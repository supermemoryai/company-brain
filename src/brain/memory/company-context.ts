import { and, db, desc, eq, sql } from "@repo/db"
import { document } from "@repo/db/schema/content"
import * as Effect from "effect/Effect"
import { makeAppLayer } from "@/config"
import { captureException } from "@/lib/capture"
import {
	buildOrgEntityContext,
	SHARED_TEAM_BRAIN_CONTAINER_TAG,
} from "@/lib/spaces/provisioning"
import { addMemorySingle } from "@/routes/memories/handler-effect"

const COMPANY_CONTEXT_TYPE = "company_context"

function companyContextCustomId(orgId: string): string {
	return `company_context_${orgId}`
}

// Upserts the company description into the Team Brain (deterministic customId, no dupes).
export async function writeCompanyContext(
	env: Env,
	executionCtx: ExecutionContext | undefined,
	org: { id: string; name: string; metadata?: unknown },
	userId: string,
	params: { domain?: string | null; about?: string | null },
): Promise<{ written: boolean }> {
	const about = params.about?.trim()
	if (!about) return { written: false }

	const content = buildOrgEntityContext({
		orgName: org.name,
		domain: params.domain,
		about,
	})

	const program = addMemorySingle({
		org: { id: org.id, name: org.name, metadata: org.metadata },
		userId,
		source: "company-brain",
		executionCtx,
		requestParams: {
			content,
			customId: companyContextCustomId(org.id),
			containerTag: SHARED_TEAM_BRAIN_CONTAINER_TAG,
			metadata: {
				type: COMPANY_CONTEXT_TYPE,
				sm_source: "company-brain",
				title: `About ${org.name}`,
			},
		},
	})

	try {
		await Effect.runPromise(
			program.pipe(Effect.provide(makeAppLayer({ executionCtx, env }))),
		)
		return { written: true }
	} catch (error) {
		captureException(
			error instanceof Error ? error : new Error(String(error)),
			{ tags: { component: "company-context" } },
		)
		return { written: false }
	}
}

// Fetch by metadata (not semantic search) so it's always available to prime the prompt.
export async function getCompanyContext(
	env: Env,
	orgId: string,
	traceId?: string,
): Promise<string | null> {
	const t = Date.now()
	try {
		const [row] = await db(env)
			.select({ content: document.content })
			.from(document)
			.where(
				and(
					eq(document.orgId, orgId),
					sql`${document.containerTags} && ARRAY[${SHARED_TEAM_BRAIN_CONTAINER_TAG}]::text[]`,
					sql`${document.metadata}->>'type' = ${COMPANY_CONTEXT_TYPE}`,
				),
			)
			.orderBy(desc(document.createdAt))
			.limit(1)
		const content = row?.content?.trim() || null
		if (traceId) {
			console.log(
				`[company-brain][${traceId}] company_context lookup org=${orgId} found=${content ? "yes" : "no"} chars=${content?.length ?? 0} ms=${Date.now() - t}`,
			)
		}
		return content
	} catch (error) {
		if (traceId) {
			console.warn(
				`[company-brain][${traceId}] company_context lookup failed org=${orgId} ms=${Date.now() - t}:`,
				error,
			)
		}
		captureException(
			error instanceof Error ? error : new Error(String(error)),
			{ tags: { component: "company-context" } },
		)
		return null
	}
}
