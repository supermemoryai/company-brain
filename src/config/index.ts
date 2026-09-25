import * as Layer from "effect/Layer"
import { getBrainModel } from "../brain/turn/brain-model"
import { TRIAGE_MODEL } from "../brain/turn/model-profile"
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

let currentEnv: Env | undefined

export function configureFromEnv(env: Env): void {
	currentEnv = env
	const publicUrl = env.PUBLIC_URL?.replace(/\/$/, "")
	current = {
		features: { email: false, sandbox: Boolean(env.DAYTONA_API_KEY || env.Sandbox) },
		trustedOrigins: publicUrl ? [publicUrl] : [],
		publicUrl,
	}
}

/**
 * A cheap, quick model for the small classification and summarisation calls
 * scattered through a turn. Those call sites have no Env in hand, so it comes
 * from the configuration set at startup.
 */
export function fastModel() {
	if (!currentEnv) {
		throw new Error("configureFromEnv has not run yet")
	}
	return getBrainModel(TRIAGE_MODEL, currentEnv)
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
