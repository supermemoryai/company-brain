import type { CreateSandbox, Sandbox } from "@daytona/api-client"
import { boundedArtifactStream, type SandboxClient } from "./client"
import type {
	ExecuteRequest,
	ExecuteResponse,
	FileInfo,
} from "@daytona/toolbox-api-client"
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

type DaytonaConfig = {
	apiKey: string
	apiUrl: string
	target?: string
}

// Daytona HTTP calls run inside the Slack turn's waitUntil; an unbounded fetch
// wedges the whole turn and trips Cloudflare's request-hang watchdog.
const DAYTONA_HTTP_TIMEOUT_MS = 30_000

function daytonaConfig(env: Env): DaytonaConfig | null {
	if (!env.DAYTONA_API_KEY) return null
	return {
		apiKey: env.DAYTONA_API_KEY,
		apiUrl: "https://app.daytona.io/api",
	}
}

function daytonaUrl(config: DaytonaConfig, path: string): string {
	return `${config.apiUrl.replace(/\/$/, "")}${path}`
}

function toolboxUrl(sandbox: Sandbox, path: string): string {
	const proxy =
		sandbox.toolboxProxyUrl ?? "https://proxy.app.daytona.io/toolbox"
	return `${proxy.replace(/\/$/, "")}/${encodeURIComponent(sandbox.id)}${path}`
}

async function daytonaRequest<T>(
	config: DaytonaConfig,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const timeout = AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS)
	const response = await fetch(daytonaUrl(config, path), {
		...init,
		signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			"X-Daytona-Source": "supermemory-company-brain",
			...(init?.body ? { "Content-Type": "application/json" } : {}),
			...init?.headers,
		},
	})
	if (!response.ok) {
		throw new Error(`Daytona request failed (${response.status})`, {
			cause: await response.text().catch(() => response.statusText),
		})
	}
	return (await response.json()) as T
}

async function toolboxRequest<T>(
	config: DaytonaConfig,
	sandbox: Sandbox,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const timeout = AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS)
	const response = await fetch(toolboxUrl(sandbox, path), {
		...init,
		signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			...(init?.body ? { "Content-Type": "application/json" } : {}),
			...init?.headers,
		},
	})
	if (!response.ok) {
		throw new Error(`Daytona toolbox request failed (${response.status})`, {
			cause: await response.text().catch(() => response.statusText),
		})
	}
	return (await response.json()) as T
}

async function toolboxResponse(
	config: DaytonaConfig,
	sandbox: Sandbox,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const timeout = AbortSignal.timeout(DAYTONA_HTTP_TIMEOUT_MS)
	const response = await fetch(toolboxUrl(sandbox, path), {
		...init,
		signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			...(init?.body ? { "Content-Type": "application/json" } : {}),
			...init?.headers,
		},
	})
	if (!response.ok) {
		throw new Error(`Daytona file download failed (${response.status})`, {
			cause: await response.text().catch(() => response.statusText),
		})
	}
	return response
}

async function toolboxBlob(
	config: DaytonaConfig,
	sandbox: Sandbox,
	path: string,
): Promise<ArrayBuffer> {
	const response = await toolboxResponse(config, sandbox, path)
	return response.arrayBuffer()
}

async function getSandbox(
	config: DaytonaConfig,
	sandboxId: string,
	signal?: AbortSignal,
): Promise<Sandbox> {
	return daytonaRequest<Sandbox>(
		config,
		`/sandbox/${encodeURIComponent(sandboxId)}`,
		signal ? { signal } : undefined,
	)
}

async function waitForSandboxStarted(
	config: DaytonaConfig,
	sandbox: Sandbox,
	timeoutMs = 90_000,
): Promise<Sandbox> {
	const startedAt = Date.now()
	let current = sandbox
	while (current.state && current.state !== "started") {
		if (current.state === "error" || current.state === "build_failed") {
			throw new Error(`Daytona sandbox failed to start: ${current.state}`)
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Daytona sandbox did not start before timeout.")
		}
		await new Promise((resolve) => setTimeout(resolve, 1000))
		current = await getSandbox(config, sandbox.id)
	}
	return current
}

async function execToolboxCommand(
	config: DaytonaConfig,
	sandbox: Sandbox,
	body: ExecuteRequest,
	timeoutSec: number,
): Promise<ExecuteResponse> {
	return toolboxRequest<ExecuteResponse>(config, sandbox, "/process/execute", {
		method: "POST",
		signal: AbortSignal.timeout((timeoutSec + 15) * 1000),
		body: JSON.stringify(body),
	})
}

function encodeQuery(params: Record<string, string | undefined>): string {
	const query = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) query.set(key, value)
	}
	const text = query.toString()
	return text ? `?${text}` : ""
}

export function createDaytonaSandboxClient(env: Env): SandboxClient {
	const config = daytonaConfig(env)
	if (!config) throw new Error("Daytona is not configured.")

	return {
		async isSandboxRunning(sandboxId) {
			try {
				const sandbox = await getSandbox(config, sandboxId)
				return sandbox.state === undefined || sandbox.state === "started"
			} catch {
				return false
			}
		},
		async createSandbox(args) {
			const repo = args.repoUrl ? validateRepoUrl(args.repoUrl) : null
			if (repo && !repo.ok) {
				throw new Error(repo.error)
			}

			const createBody: CreateSandbox = {
				labels: {
					app: "company-brain",
					kind: "slack-workspace",
					"code-toolbox-language": "typescript",
				},
				target: config.target,
				autoStopInterval: 30,
				autoArchiveInterval: 0,
				autoDeleteInterval: 0,
			}
			const created = await daytonaRequest<Sandbox>(config, "/sandbox", {
				method: "POST",
				body: JSON.stringify(createBody),
			})
			const sandbox = await waitForSandboxStarted(config, created)
			if (!repo) {
				// Create workspace from home (".") — chdir'ing into a dir that does
				// not exist yet makes the toolbox fork/exec a broken shell.
				await this.runCommand({
					sandboxId: sandbox.id,
					command: "mkdir -p workspace",
					cwd: ".",
					timeoutSec: 30,
				})
				return { sandboxId: sandbox.id, defaultCwd: "workspace" }
			}

			const defaultCwd = safeRepoDir(repo.url)
			const clone = await this.runCommand({
				sandboxId: sandbox.id,
				command: `mkdir -p workspace && git clone --depth 1 -- ${shellQuote(repo.url)} ${shellQuote(defaultCwd)}`,
				cwd: ".",
				timeoutSec: 120,
			})
			return {
				sandboxId: sandbox.id,
				defaultCwd,
				repoUrl: repo.url,
				cloneOutput: clone.output,
			}
		},

		async runCommand(args) {
			const command = validateCommand(args.command)
			if (!command.ok) {
				return {
					exitCode: 126,
					output: command.error,
					truncated: false,
					cwd: args.cwd,
					timeoutSec: normalizeTimeout(args.timeoutSec),
				}
			}
			const sandbox = await getSandbox(config, args.sandboxId)
			const cwd = normalizeCwd(args.cwd, "workspace")
			const timeoutSec = normalizeTimeout(args.timeoutSec)
			// Fold cwd into the command instead of the toolbox `cwd` param: a missing
			// dir there makes the toolbox fork/exec a broken shell; `cd` just errors.
			const execBody: ExecuteRequest = {
				command: `cd ${shellQuote(cwd)} && ${command.command}`,
				timeout: timeoutSec,
			}
			const out = await execToolboxCommand(
				config,
				sandbox,
				execBody,
				timeoutSec,
			)
			const truncated = truncateText(out.result ?? "")
			return {
				exitCode: out.exitCode ?? 0,
				output: truncated.text,
				truncated: truncated.truncated,
				cwd,
				timeoutSec,
			}
		},

		async listFiles(args) {
			const sandbox = await getSandbox(config, args.sandboxId)
			const path = normalizePath(args.path, "workspace")
			if (args.glob?.trim()) {
				const result = await toolboxRequest<{ files: string[] }>(
					config,
					sandbox,
					`/files/search${encodeQuery({ path, pattern: args.glob.trim() })}`,
				)
				return {
					files: (result.files ?? []).slice(0, 200),
					path,
					glob: args.glob.trim(),
				}
			}
			const files = await toolboxRequest<FileInfo[]>(
				config,
				sandbox,
				`/files${encodeQuery({ path })}`,
			)
			return {
				files: files.slice(0, 200),
				path,
			}
		},

		async readTextFile(args) {
			const sandbox = await getSandbox(config, args.sandboxId)
			const path = normalizePath(args.path, "workspace")
			const content = await toolboxBlob(
				config,
				sandbox,
				`/files/download${encodeQuery({ path })}`,
			)
			const text = new TextDecoder().decode(content)
			const truncated = truncateText(text, sandboxLimits.maxTextFileChars)
			return { path, content: truncated.text, truncated: truncated.truncated }
		},

		async getArtifact(args) {
			const sandbox = await getSandbox(config, args.sandboxId)
			const path = normalizePath(args.path, "workspace")
			const content = await toolboxBlob(
				config,
				sandbox,
				`/files/download${encodeQuery({ path })}`,
			)
			if (content.byteLength > sandboxLimits.maxArtifactBytes) {
				throw new Error("Artifact is too large.", {
					cause: `${content.byteLength} bytes, max ${sandboxLimits.maxArtifactBytes}`,
				})
			}
			return {
				path,
				sizeBytes: content.byteLength,
				content,
				truncated: false,
			}
		},

		async getArtifactStream(args) {
			const sandbox = await getSandbox(config, args.sandboxId, args.signal)
			const path = normalizePath(args.path, "workspace")
			const info = await toolboxRequest<FileInfo>(
				config,
				sandbox,
				`/files/info${encodeQuery({ path })}`,
				args.signal ? { signal: args.signal } : undefined,
			)
			if (!Number.isSafeInteger(info.size) || info.size <= 0) {
				throw new Error("Artifact has an invalid size.")
			}
			if (info.size > sandboxLimits.maxArtifactBytes) {
				throw new Error("Artifact is too large.", {
					cause: `${info.size} bytes, max ${sandboxLimits.maxArtifactBytes}`,
				})
			}
			const response = await toolboxResponse(
				config,
				sandbox,
				`/files/download${encodeQuery({ path })}`,
				args.signal ? { signal: args.signal } : undefined,
			)
			if (!response.body) {
				throw new Error("Daytona artifact download returned no body.")
			}
			return {
				path,
				sizeBytes: info.size,
				content: boundedArtifactStream(response.body, info.size),
			}
		},
	}
}
