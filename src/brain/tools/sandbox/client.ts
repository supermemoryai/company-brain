import { createCloudflareSandboxClient } from "./cloudflare-client"
import { createDaytonaSandboxClient } from "./daytona-client"
import { sandboxLimits } from "./guards"

export type SandboxFileInfo = {
	name: string
	isDir: boolean
	size: number
	modTime?: string
}

/** What the sandbox tools need from a sandbox provider. */
export type SandboxClient = {
	createSandbox(args: { goal: string; repoUrl?: string }): Promise<{
		sandboxId: string
		defaultCwd: string
		repoUrl?: string
		cloneOutput?: string
	}>
	runCommand(args: {
		sandboxId: string
		command: string
		cwd: string
		timeoutSec?: number
	}): Promise<{
		exitCode: number
		output: string
		truncated: boolean
		cwd: string
		timeoutSec: number
	}>
	listFiles(args: { sandboxId: string; path: string; glob?: string }): Promise<{
		files: Array<SandboxFileInfo | string>
		path: string
		glob?: string
	}>
	readTextFile(args: {
		sandboxId: string
		path: string
	}): Promise<{ path: string; content: string; truncated: boolean }>
	getArtifact(args: { sandboxId: string; path: string }): Promise<{
		path: string
		sizeBytes: number
		content: ArrayBuffer
		truncated: false
	}>
	getArtifactStream(args: {
		sandboxId: string
		path: string
		signal?: AbortSignal
	}): Promise<{
		path: string
		sizeBytes: number
		content: ReadableStream<Uint8Array>
	}>
	isSandboxRunning(sandboxId: string): Promise<boolean>
}

/**
 * Cloudflare Sandbox runs in the deployer's own account and is the default.
 * Setting DAYTONA_API_KEY opts into Daytona instead.
 */
export function sandboxToolsConfigured(env: Env): boolean {
	return Boolean(env.DAYTONA_API_KEY) || Boolean(env.Sandbox)
}

export function createSandboxClient(env: Env): SandboxClient {
	if (env.DAYTONA_API_KEY) return createDaytonaSandboxClient(env)
	return createCloudflareSandboxClient(env)
}

export function base64FromArrayBuffer(buffer: ArrayBuffer): string {
	let binary = ""
	const bytes = new Uint8Array(buffer)
	for (let index = 0; index < bytes.byteLength; index++) {
		binary += String.fromCharCode(bytes[index] ?? 0)
	}
	return btoa(binary)
}

/** Pass a download through only if it matches the size it claimed. */
export function boundedArtifactStream(
	content: ReadableStream<Uint8Array>,
	expectedSize: number,
): ReadableStream<Uint8Array> {
	let received = 0
	return content.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				received += chunk.byteLength
				if (
					received > expectedSize ||
					received > sandboxLimits.maxArtifactBytes
				) {
					controller.error(
						new Error("Artifact contents exceeded the sandbox artifact limit."),
					)
					return
				}
				controller.enqueue(chunk)
			},
			flush(controller) {
				if (received !== expectedSize) {
					controller.error(
						new Error(
							"Artifact contents did not match the reported file size.",
						),
					)
				}
			},
		}),
	)
}
