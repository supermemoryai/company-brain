/** Ingestion connectors are a hosted-product concern; nothing is paused here. */
export function connectorPause(): { paused: boolean; reason: string | null } {
	return { paused: false, reason: null }
}
