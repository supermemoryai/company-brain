let turnDepsPromise:
	| Promise<Awaited<ReturnType<typeof loadTurnDeps>>>
	| undefined

export async function loadTurnDeps() {
	const [
		{ z },
		ai,
		Effect,
		{ makeAppLayer },
		{ getStreamTextStructuredOutput },
		{ getBrainModel: getModel },
		{ searchMemoryEntries },
		{ VectorDBService },
		{ MemoryDocSchema },
		{ buildSystemPrompt, buildSystemPromptMessages },
		webTools,
		{ SHARED_TEAM_BRAIN_CONTAINER_TAG },
		{ makeSlackSearchContext },
	] = await Promise.all([
		import("zod"),
		import("ai"),
		import("effect/Effect"),
		import("@/config"),
		import("@/lib/ai-utils"),
		import("./brain-model"),
		import("@/routes/v4/search/handlers"),
		import("@/services/vectordb"),
		import("../memory"),
		import("../prompt/system"),
		import("../tools/web"),
		import("@/lib/spaces/provisioning"),
		import("../slack/workspace"),
	])
	return {
		z,
		...ai,
		Effect,
		makeAppLayer,
		getStreamTextStructuredOutput,
		getModel,
		searchMemoryEntries,
		VectorDBService,
		MemoryDocSchema,
		buildSystemPrompt,
		buildSystemPromptMessages,
		createBrainWebSearchTool: webTools.createBrainWebSearchTool,
		createBrainWebExtractTool: webTools.createBrainWebExtractTool,
		SHARED_TEAM_BRAIN_CONTAINER_TAG,
		makeSlackSearchContext,
	}
}

export type TurnDeps = Awaited<ReturnType<typeof loadTurnDeps>>

export function getTurnDeps(): Promise<TurnDeps> {
	if (!turnDepsPromise) turnDepsPromise = loadTurnDeps()
	return turnDepsPromise
}
