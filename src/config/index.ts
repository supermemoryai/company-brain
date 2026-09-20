import * as Layer from "effect/Layer"
import { VectorDBService } from "../compat/services/vectordb"
import { memoryClient } from "../memory/client"

/**
 * Deployment config. The hosted product read this from a much larger settings
 * object; a self-hosted brain only needs the handful of values below.
 */
export type BrainConfig = {
	features: { email: boolean; sandbox: boolean }
	trustedOrigins: string[]
	publicUrl: string | undefined
}

let current: BrainConfig = {
	features: { email: false, sandbox: false },
	trustedOrigins: [],
	publicUrl: undefined,
}

export function getConfig(): BrainConfig {
	return current
}

export function configureFromEnv(env: {
	PUBLIC_URL?: string
	DAYTONA_API_KEY?: string
}): void {
	const publicUrl = env.PUBLIC_URL?.replace(/\/$/, "")
	current = {
		features: { email: false, sandbox: Boolean(env.DAYTONA_API_KEY) },
		trustedOrigins: publicUrl ? [publicUrl] : [],
		publicUrl,
	}
}

/**
 * Effect layer for a request or turn. The hosted app assembled a dozen
 * services here; a self-hosted brain needs one — the memory client.
 */
export function makeAppLayer(params: {
	env: Env
	orgId?: string
	executionCtx?: ExecutionContext
}): Layer.Layer<VectorDBService> {
	return Layer.succeed(VectorDBService, memoryClient(params.env))
}
