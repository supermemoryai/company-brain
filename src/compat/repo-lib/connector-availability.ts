/** Ingestion connectors are a hosted-product concern; nothing is paused here. */
export function connectorPause(_slug?: string): {
	paused: boolean
	message: string | null
} {
	return { paused: false, message: null }
}
