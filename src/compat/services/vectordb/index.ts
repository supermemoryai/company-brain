import * as Context from "effect/Context"
import type Supermemory from "supermemory"

/**
 * The hosted brain talked to Turbopuffer through this service. Here it carries
 * the supermemory client instead: search and forget are API calls, so callers
 * that only pass the handle through keep working unchanged.
 */
export class VectorDBService extends Context.Tag("VectorDBService")<
	VectorDBService,
	Supermemory
>() {}
