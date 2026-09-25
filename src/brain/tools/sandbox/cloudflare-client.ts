import { getSandbox } from "@cloudflare/sandbox"
import {
	boundedArtifactStream,
	type SandboxClient,
	type SandboxFileInfo,
} from "./client"
import {
	normalizeCwd,
	normalizePath,
	normalizeTimeout,
	safeRepoDir,
	sandboxLimits,
	shellQuote,
	truncateText,
	validateCommand,
	validateRepoUrl,
} from "./guards"

// Sandboxes sleep after this long idle. A sleeping container loses its
// filesystem, which the marker file below detects.
const SLEEP_AFTER = "30m"

// Written when a sandbox is set up. A container that woke from sleep starts
// from the image again and won't have it, so the session gets recreated.
const READY_MARKER = "/workspace/.company-brain-ready"

// Tool paths are relative to the sandbox root, as they were on Daytona, where
// the default working directory is "workspace".
function absolute(path: string): string {
	return path.startsWith("/") ? path : `/${path}`
}

function sandboxFor(env: Env, sandboxId: string) {
	if (!env.Sandbox) throw new Error("The Sandbox binding is not configured.")
	return getSandbox(env.Sandbox, sandboxId, { sleepAfter: SLEEP_AFTER })
}

export function createCloudflareSandboxClient(env: Env): SandboxClient {
	const client: SandboxClient = {
		async isSandboxRunning(sandboxId) {
			try {
				const result = await sandboxFor(env, sandboxId).exists(READY_MARKER)
				return result.exists
			} catch {
				return false
			}
		},

		async createSandbox(args) {
			const repo = args.repoUrl ? validateRepoUrl(args.repoUrl) : null
			if (repo && !repo.ok) throw new Error(repo.error)

			// Lowercase: sandbox ids double as preview hostnames.
			const sandboxId = `brain-${crypto.randomUUID()}`
			const sandbox = sandboxFor(env, sandboxId)
			await sandbox.exec(
				`mkdir -p /workspace && touch ${shellQuote(READY_MARKER)}`,
			)
			if (!repo) return { sandboxId, defaultCwd: "workspace" }

			const defaultCwd = safeRepoDir(repo.url)
			const clone = await client.runCommand({
				sandboxId,
				command: `git clone --depth 1 -- ${shellQuote(repo.url)} ${shellQuote(absolute(defaultCwd))}`,
				cwd: "workspace",
				timeoutSec: 120,
			})
			return {
				sandboxId,
				defaultCwd,
				repoUrl: repo.url,
				cloneOutput: clone.output,
			}
		},

		async runCommand(args) {
			const timeoutSec = normalizeTimeout(args.timeoutSec)
			const command = validateCommand(args.command)
			if (!command.ok) {
				return {
					exitCode: 126,
					output: command.error,
					truncated: false,
					cwd: args.cwd,
					timeoutSec,
				}
			}
			const cwd = normalizeCwd(args.cwd, "workspace")
			// cd inside the command so a missing directory is an ordinary error.
			const result = await sandboxFor(env, args.sandboxId).exec(
				`cd ${shellQuote(absolute(cwd))} && ${command.command}`,
				{ timeout: timeoutSec * 1000 },
			)
			const combined = [result.stdout, result.stderr]
				.filter((part) => part.length > 0)
				.join("\n")
			const truncated = truncateText(combined)
			return {
				exitCode: result.exitCode,
				output: truncated.text,
				truncated: truncated.truncated,
				cwd,
				timeoutSec,
			}
		},

		async listFiles(args) {
			const sandbox = sandboxFor(env, args.sandboxId)
			const path = normalizePath(args.path, "workspace")
			const glob = args.glob?.trim()
			if (glob) {
				const found = await sandbox.exec(
					`find ${shellQuote(absolute(path))} -name ${shellQuote(glob)} -not -path '*/.git/*' 2>/dev/null | head -200`,
				)
				return {
					files: found.stdout.split("\n").filter(Boolean),
					path,
					glob,
				}
			}
			const listed = await sandbox.listFiles(absolute(path))
			const files: SandboxFileInfo[] = listed.files
				.slice(0, 200)
				.map((file) => ({
					name: file.name,
					isDir: file.type === "directory",
					size: file.size,
					modTime: file.modifiedAt,
				}))
			return { files, path }
		},

		async readTextFile(args) {
			const path = normalizePath(args.path, "workspace")
			const file = await sandboxFor(env, args.sandboxId).readFile(
				absolute(path),
			)
			const text =
				file.encoding === "base64"
					? new TextDecoder().decode(
							Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)),
						)
					: file.content
			const truncated = truncateText(text, sandboxLimits.maxTextFileChars)
			return { path, content: truncated.text, truncated: truncated.truncated }
		},

		async getArtifact(args) {
			const out = await client.getArtifactStream(args)
			const content = await new Response(out.content).arrayBuffer()
			return {
				path: out.path,
				sizeBytes: content.byteLength,
				content,
				truncated: false,
			}
		},

		async getArtifactStream(args) {
			args.signal?.throwIfAborted()
			const path = normalizePath(args.path, "workspace")
			const file = await sandboxFor(env, args.sandboxId).readFile(
				absolute(path),
				{ encoding: "none" },
			)
			if (!Number.isSafeInteger(file.size) || file.size <= 0) {
				await file.content.cancel()
				throw new Error("Artifact has an invalid size.")
			}
			if (file.size > sandboxLimits.maxArtifactBytes) {
				await file.content.cancel()
				throw new Error("Artifact is too large.", {
					cause: `${file.size} bytes, max ${sandboxLimits.maxArtifactBytes}`,
				})
			}
			return {
				path,
				sizeBytes: file.size,
				content: boundedArtifactStream(file.content, file.size),
			}
		},
	}
	return client
}
