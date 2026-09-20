import type { ToolSet } from "ai"
import { logPreview } from "../../observability/log-utils"
import { uploadSlackFile } from "../../slack/client"
import type { CompanyBrainAgent } from "../../turn/agent"
import type { TurnDeps } from "../../turn/deps"
import {
	base64FromArrayBuffer,
	createDaytonaSandboxClient,
	sandboxToolsConfigured,
} from "./daytona-client"
import {
	normalizeCwd,
	normalizePath,
	sandboxLimits,
	validateRepoUrl,
} from "./guards"
import {
	deleteSandboxSession,
	loadSandboxSession,
	type SandboxSessionScope,
	sandboxSessionKey,
	saveSandboxSession,
	touchSandboxSession,
} from "./sessions"

export type CreateSandboxToolsArgs = {
	env: Env
	agent: CompanyBrainAgent
	deps: TurnDeps
	scope: SandboxSessionScope
	/** Present only for an interactive Slack turn. Never persisted with session state. */
	slackArtifactDestination?: {
		botToken: string
		channel: string
		threadTs?: string
		signal?: AbortSignal
		canShare?: () => boolean
	}
	traceId: string
}

function missingSession() {
	return {
		isError: true,
		error: "No active sandbox. Call sandbox_start first.",
	}
}

function toolError(error: unknown) {
	return {
		isError: true,
		error: error instanceof Error ? error.message : String(error),
	}
}

function artifactFilename(path: string): string {
	const filename = path.split("/").filter(Boolean).at(-1)?.trim()
	return filename || "sandbox-artifact"
}

class SlackArtifactUploadError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SlackArtifactUploadError"
	}
}

export function createSandboxTools(args: CreateSandboxToolsArgs): ToolSet {
	if (!sandboxToolsConfigured(args.env)) return {}

	const { env, agent, deps, scope, traceId } = args
	const sessionKey = sandboxSessionKey(scope)
	const client = createDaytonaSandboxClient(env)
	// Models sometimes inspect the same artifact twice while drafting their
	// answer. Reusing a successful upload keeps that from creating duplicates.
	const artifactUploads = new Map<
		string,
		Promise<{ fileId: string; sizeBytes: number; path: string }>
	>()

	const sandbox_start = deps.tool({
		description:
			"Create or reuse an isolated workspace for code/repo/file/PDF work. Use this before sandbox_run, sandbox_read_file, sandbox_list_files, or sandbox_get_artifact. Only public https repo URLs are supported in V1.",
		inputSchema: deps.z.object({
			goal: deps.z
				.string()
				.min(1)
				.describe("Short description of what this workspace is for."),
			repoUrl: deps.z
				.string()
				.optional()
				.describe("Optional public https repository URL to clone."),
		}),
		execute: async ({ goal, repoUrl }) => {
			try {
				// Normalize the requested repo scope: null = bare workspace, a
				// normalized URL = specific repo. Reuse only when it matches the
				// running session's repo, else the model would keep operating from
				// the previous repo's workspace after switching repos.
				const requested = repoUrl ? validateRepoUrl(repoUrl) : null
				// Reject a bad repo URL before touching the existing session.
				if (requested && !requested.ok) {
					return { isError: true, error: requested.error }
				}
				const requestedRepo = requested ? requested.url : null

				const existing = loadSandboxSession(agent, sessionKey)
				const scopeMatches =
					existing != null &&
					requestedRepo !== undefined &&
					existing.repoUrl === requestedRepo
				if (
					existing &&
					scopeMatches &&
					(await client.isSandboxRunning(existing.sandboxId))
				) {
					const touched = touchSandboxSession(agent, existing)
					console.log(
						`[company-brain][${traceId}] sandbox_start reuse id=${touched.sandboxId} cwd=${touched.defaultCwd} repo=${touched.repoUrl ?? "-"}`,
					)
					return {
						reused: true,
						sandboxId: touched.sandboxId,
						defaultCwd: touched.defaultCwd,
						repoUrl: touched.repoUrl ?? undefined,
						expiresAt: touched.expiresAt,
					}
				}
				if (existing) {
					// Drop the session when the repo scope changed, or when Daytona
					// already auto-stopped/deleted the workspace (autoStop 30m,
					// autoDeleteInterval:0), so a cached id can't be reused wrongly.
					deleteSandboxSession(agent, sessionKey)
					const reason = scopeMatches ? "stale" : "repo-changed"
					console.log(
						`[company-brain][${traceId}] sandbox_start ${reason} id=${existing.sandboxId} repo=${existing.repoUrl ?? "-"} dropped; recreating`,
					)
				}

				artifactUploads.clear()
				const created = await client.createSandbox({ goal, repoUrl })
				const session = saveSandboxSession(agent, {
					sessionKey,
					sandboxId: created.sandboxId,
					orgId: scope.orgId,
					userId: scope.userId ?? null,
					channel: scope.channel ?? null,
					threadTs: scope.threadTs ?? null,
					defaultCwd: created.defaultCwd,
					repoUrl: created.repoUrl ?? null,
					goal,
				})
				console.log(
					`[company-brain][${traceId}] sandbox_start created id=${session.sandboxId} cwd=${session.defaultCwd} repo=${created.repoUrl ?? "-"}`,
				)
				return {
					reused: false,
					sandboxId: session.sandboxId,
					defaultCwd: session.defaultCwd,
					repoUrl: created.repoUrl,
					cloneOutput: created.cloneOutput,
					expiresAt: session.expiresAt,
				}
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_run = deps.tool({
		description:
			"Run a bounded shell command in the active sandbox workspace. Use for inspection, package-backed analysis, tests, scripts, and artifact generation. External writes like git push/deploy are blocked in V1.",
		inputSchema: deps.z.object({
			command: deps.z.string().min(1).describe("Shell command to run."),
			reason: deps.z
				.string()
				.min(1)
				.describe("Why this command is needed for the user's request."),
			cwd: deps.z
				.string()
				.optional()
				.describe("Working directory. Defaults to the sandbox repo/workspace."),
			timeoutSec: deps.z
				.number()
				.int()
				.min(1)
				.max(sandboxLimits.maxTimeoutSec)
				.optional(),
		}),
		execute: async ({ command, reason, cwd, timeoutSec }) => {
			try {
				const session = loadSandboxSession(agent, sessionKey)
				if (!session) return missingSession()
				// A command can replace an artifact at the same path, so cached Slack
				// file IDs are no longer safe once execution resumes.
				artifactUploads.clear()
				console.log(
					`[company-brain][${traceId}] sandbox_run id=${session.sandboxId} reason="${logPreview(reason)}" command="${logPreview(command)}"`,
				)
				const out = await client.runCommand({
					sandboxId: session.sandboxId,
					command,
					cwd: normalizeCwd(cwd, session.defaultCwd),
					timeoutSec,
				})
				touchSandboxSession(agent, session)
				return out
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_list_files = deps.tool({
		description:
			"List files in the active sandbox workspace. Use glob to search by filename pattern.",
		inputSchema: deps.z.object({
			path: deps.z.string().optional().describe("Directory to list."),
			glob: deps.z
				.string()
				.optional()
				.describe("Optional filename glob, e.g. '*.ts' or '*.pdf'."),
		}),
		execute: async ({ path, glob }) => {
			try {
				const session = loadSandboxSession(agent, sessionKey)
				if (!session) return missingSession()
				const out = await client.listFiles({
					sandboxId: session.sandboxId,
					path: normalizePath(path, session.defaultCwd),
					glob,
				})
				touchSandboxSession(agent, session)
				return out
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_read_file = deps.tool({
		description:
			"Read a capped text file from the active sandbox. For binary files or generated PDFs/images, use sandbox_get_artifact instead.",
		inputSchema: deps.z.object({
			path: deps.z.string().min(1).describe("Path to the text file."),
		}),
		execute: async ({ path }) => {
			try {
				const session = loadSandboxSession(agent, sessionKey)
				if (!session) return missingSession()
				const out = await client.readTextFile({
					sandboxId: session.sandboxId,
					path: normalizePath(path, session.defaultCwd),
				})
				touchSandboxSession(agent, session)
				return out
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_get_artifact = deps.tool({
		description:
			"Retrieve a small generated artifact from the active sandbox, such as a PDF, CSV, image, or report. During an interactive Slack turn, it is automatically uploaded into the active thread so images render inline; otherwise it returns base64 content with metadata.",
		inputSchema: deps.z.object({
			path: deps.z.string().min(1).describe("Path to the generated artifact."),
		}),
		execute: async ({ path }) => {
			try {
				const session = loadSandboxSession(agent, sessionKey)
				if (!session) return missingSession()
				const slackDestination = args.slackArtifactDestination
				if (!slackDestination) {
					const out = await client.getArtifact({
						sandboxId: session.sandboxId,
						path: normalizePath(path, session.defaultCwd),
					})
					touchSandboxSession(agent, session)
					return {
						path: out.path,
						sizeBytes: out.sizeBytes,
						base64: base64FromArrayBuffer(out.content),
						truncated: false,
					}
				}
				const artifactPath = normalizePath(path, session.defaultCwd)
				const existing = artifactUploads.get(artifactPath)
				if (existing) {
					const uploaded = await existing
					touchSandboxSession(agent, session)
					return {
						path: uploaded.path,
						sizeBytes: uploaded.sizeBytes,
						uploaded: true,
						reusedUpload: true,
						slackFileId: uploaded.fileId,
					}
				}

				// Install the promise before awaiting any I/O so parallel tool calls
				// for the same path share one upload rather than racing two files.
				const uploadPromise = (async () => {
					const out = await client.getArtifactStream({
						sandboxId: session.sandboxId,
						path: artifactPath,
						signal: slackDestination.signal,
					})
					touchSandboxSession(agent, session)

					const filename = artifactFilename(out.path)
					const upload = await uploadSlackFile(slackDestination.botToken, {
						channel: slackDestination.channel,
						threadTs: slackDestination.threadTs,
						filename,
						sizeBytes: out.sizeBytes,
						content: out.content,
						altText: `Generated artifact: ${filename}`,
						signal: slackDestination.signal,
						canShare: slackDestination.canShare,
					})
					if (!upload.ok) {
						const scopeHint =
							upload.error === "missing_scope"
								? " Reinstall Company Brain to grant files:write."
								: ""
						throw new SlackArtifactUploadError(
							`Created ${filename}, but Slack could not upload it (${upload.stage}: ${upload.error}).${scopeHint}`,
						)
					}
					return {
						fileId: upload.fileId,
						sizeBytes: out.sizeBytes,
						path: out.path,
					}
				})()
				artifactUploads.set(artifactPath, uploadPromise)
				let uploaded: Awaited<typeof uploadPromise>
				try {
					uploaded = await uploadPromise
				} catch (error) {
					if (artifactUploads.get(artifactPath) === uploadPromise) {
						artifactUploads.delete(artifactPath)
					}
					throw error
				}
				return {
					path: uploaded.path,
					sizeBytes: uploaded.sizeBytes,
					uploaded: true,
					slackFileId: uploaded.fileId,
				}
			} catch (error) {
				if (error instanceof SlackArtifactUploadError) throw error
				return toolError(error)
			}
		},
	})

	return {
		sandbox_start,
		sandbox_run,
		sandbox_list_files,
		sandbox_read_file,
		sandbox_get_artifact,
	}
}
