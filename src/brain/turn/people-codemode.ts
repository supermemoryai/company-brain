import {
	DynamicWorkerExecutor,
	type ExecuteOptions,
	type Executor,
	type ResolvedProvider,
} from "@cloudflare/codemode"
import { createCodeTool } from "@cloudflare/codemode/ai"
import type { ToolSet } from "ai"
import type { SlackMember } from "../slack/client"
import type { TurnDeps } from "./deps"
import { searchDirectoryMembers } from "./people-search"

const PEOPLE_CODE_OUTPUT_CHAR_LIMIT = 6_000
const PEOPLE_CODE_RESULT_CHAR_LIMIT = 5_200
const PEOPLE_FALLBACK_RESULT_LIMIT = 10

function publicMember(member: SlackMember, includeContactDetails: boolean) {
	return {
		slackUserId: member.id,
		name: member.name,
		displayName: member.displayName,
		handle: member.handle,
		email: includeContactDetails ? member.email : undefined,
		kind: member.isBot ? "bot" : "person",
	}
}

function serializedLength(value: unknown): number {
	if (typeof value === "string") return value.length
	try {
		return JSON.stringify(value)?.length ?? 0
	} catch {
		return String(value).length
	}
}

function boundedPeopleExecutor(
	loader: WorkerLoader,
	traceId: string,
): Executor {
	const executor = new DynamicWorkerExecutor({
		loader,
		globalOutbound: null,
	})
	return {
		execute: async (
			code: string,
			providersOrFns:
				| ResolvedProvider[]
				| Record<string, (...args: unknown[]) => Promise<unknown>>,
			options?: ExecuteOptions,
		) => {
			const output = await executor.execute(code, providersOrFns, options)
			const resultChars = serializedLength(output.result)
			if (resultChars <= PEOPLE_CODE_RESULT_CHAR_LIMIT) {
				// Logs may contain an accidentally printed roster. The compact return
				// value is the only data allowed back into model context.
				return { ...output, logs: undefined }
			}
			console.warn(
				`[company-brain][${traceId}] people Code Mode output too large resultChars=${resultChars} resultLimit=${PEOPLE_CODE_RESULT_CHAR_LIMIT}`,
			)
			return {
				...output,
				logs: undefined,
				result: {
					status: "error",
					error: `The people-directory result was ${resultChars} characters, above its ${PEOPLE_CODE_RESULT_CHAR_LIMIT}-character share of the ${PEOPLE_CODE_OUTPUT_CHAR_LIMIT}-character context limit. Retry in Code Mode and filter, count, group, or sample the roster before returning. Return at most 10 matching people unless the user explicitly requested a longer list.`,
					outputChars: resultChars,
					limitChars: PEOPLE_CODE_OUTPUT_CHAR_LIMIT,
				},
			}
		},
	}
}

export function createPeopleDirectoryTools(args: {
	deps: TurnDeps
	env: Env
	directory: SlackMember[]
	traceId: string
}): ToolSet {
	const { deps, env, directory, traceId } = args
	if (env.LOADER) {
		const get_directory = deps.tool({
			description:
				"Load the available Slack directory snapshot inside the isolated Code Mode worker. Returns {loadedDirectoryMembers, members}, where each member has slackUserId, name, displayName, handle, optional email, and kind=person|bot. The snapshot can be partial if Slack stopped or bounded the directory read, so do not present loadedDirectoryMembers as an exact workspace total. Filter and aggregate inside Code Mode; never return the raw roster.",
			inputSchema: deps.z.object({
				includeBots: deps.z.boolean().optional(),
				includeContactDetails: deps.z
					.boolean()
					.optional()
					.describe(
						"Include email addresses only when identity resolution or a live app requires them.",
					),
			}),
			execute: async ({ includeBots, includeContactDetails }) => ({
				loadedDirectoryMembers: directory.length,
				members: directory
					.filter((member) => includeBots || !member.isBot)
					.map((member) =>
						publicMember(member, includeContactDetails === true),
					),
			}),
		})
		return {
			inspect_people_directory: createCodeTool({
				tools: [{ name: "people", tools: { get_directory } }],
				executor: boundedPeopleExecutor(env.LOADER, traceId),
				description: `Inspect the available Slack people-directory snapshot in isolated Code Mode without loading the roster into the model context.

Available API:
{{types}}

Write one JavaScript async arrow function. Call people.get_directory(), then search, filter, join, count, group, or sample inside the worker. Return only the compact answer material: normally at most 10 matching people with stable Slack ids, or aggregate counts for roster-wide questions. Never return the unfiltered directory.`,
			}),
		}
	}

	// Local/dev safety fallback when Worker Loader is unavailable. It remains
	// query-only so a missing binding can never reintroduce the full roster.
	return {
		inspect_people_directory: deps.tool({
			description:
				"Resolve a specific Slack workspace person or bot by name, handle, email, or Slack id. Worker Code Mode is unavailable in this environment, so a query is required and results are capped. loadedDirectoryMembers is the available snapshot size, not a guaranteed exact workspace total.",
			inputSchema: deps.z.object({
				query: deps.z.string().min(1),
				includeBots: deps.z.boolean().optional(),
				includeContactDetails: deps.z.boolean().optional(),
				limit: deps.z
					.number()
					.int()
					.min(1)
					.max(PEOPLE_FALLBACK_RESULT_LIMIT)
					.optional(),
			}),
			execute: async ({ query, includeBots, includeContactDetails, limit }) => {
				const people = searchDirectoryMembers({
					directory,
					query,
					includeBots,
					limit,
				}).map((member) => publicMember(member, includeContactDetails === true))
				return { people, loadedDirectoryMembers: directory.length }
			},
		}),
	}
}
