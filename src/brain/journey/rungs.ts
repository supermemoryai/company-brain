import { and, db, eq, isNull } from "@repo/db"
import { organization } from "@repo/db/schema/auth"
import { mcpConnection } from "@repo/db/schema/brain/mcp"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"

export type JourneyRung =
	| "domain"
	| "channels"
	| "second_asker"
	| "tool_workspace"
	| "digest"

// Ladder order: the journey always offers the lowest rung not yet granted.
export const JOURNEY_RUNGS: JourneyRung[] = [
	"domain",
	"channels",
	"second_asker",
	"tool_workspace",
	"digest",
]

export type RungState = Record<JourneyRung, boolean>

// A table is created lazily by whichever feature owns it, so reading one the org
// has never used throws. An unreadable source means the rung is not granted.
function count(read: () => number): number {
	try {
		return read()
	} catch {
		return 0
	}
}

function introducedChannels(agent: CompanyBrainAgent): number {
	return count(() => {
		const rows = agent.sql<{ n: number }>`
			SELECT COUNT(*) AS n FROM brain_public_channel_introduction
		`
		return Number(rows[0]?.n ?? 0)
	})
}

function askers(agent: CompanyBrainAgent): number {
	return count(() => {
		const rows = agent.sql<{ n: number }>`
			SELECT COUNT(*) AS n FROM brain_user_seen
		`
		return Number(rows[0]?.n ?? 0)
	})
}

function standingDigests(agent: CompanyBrainAgent): number {
	const automations = count(() => {
		const rows = agent.sql<{ n: number }>`
			SELECT COUNT(*) AS n FROM brain_automation WHERE enabled = 1
		`
		return Number(rows[0]?.n ?? 0)
	})
	if (automations > 0) return automations
	// Recurring alone is not enough: ordinary reminders also repeat.
	return count(
		() =>
			agent
				.getSchedules<{ kind?: string }>()
				.filter(
					(schedule) =>
						schedule.callback === "runScheduledTask" &&
						schedule.type === "cron" &&
						schedule.payload?.kind === "digest",
				).length,
	)
}

async function hasCompanyDomain(env: Env, orgId: string): Promise<boolean> {
	const [org] = await db(env)
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1)
	const metadata: Record<string, unknown> =
		typeof org?.metadata === "string"
			? (JSON.parse(org.metadata) as Record<string, unknown>)
			: ((org?.metadata as Record<string, unknown> | null) ?? {})
	// Bootstrap only ever stores a real company domain, never a free-mail one.
	return Boolean((metadata.brainWorkspaceDomain as string)?.trim())
}

// Workspace-shared only. A personal connection helps the one member who made it,
// so coverage across people is a person-level journey, not a rung on this ladder.
async function hasWorkspaceConnection(
	env: Env,
	orgId: string,
): Promise<boolean> {
	const [row] = await db(env)
		.select({ id: mcpConnection.id })
		.from(mcpConnection)
		.where(
			and(
				eq(mcpConnection.orgId, orgId),
				eq(mcpConnection.status, "active"),
				isNull(mcpConnection.userId),
			),
		)
		.limit(1)
	return Boolean(row)
}

// Read live at send time, never cached: a disconnected tool or a removed channel
// must revoke its rung immediately, otherwise the journey nags for what it has.
export async function readRungState(
	agent: CompanyBrainAgent,
): Promise<RungState> {
	return (await readRungStateChecked(agent)).state
}

/**
 * `reliable` is false when a Postgres read failed and fell back to "not
 * granted". A false rung from a failed read must never count as a revocation.
 */
export async function readRungStateChecked(
	agent: CompanyBrainAgent,
): Promise<{ state: RungState; reliable: boolean }> {
	const env = brainAgent(agent).env
	const orgId = agent.name
	let reliable = true
	const guarded = async (read: Promise<boolean>): Promise<boolean> => {
		try {
			return await read
		} catch {
			reliable = false
			return false
		}
	}
	const [domain, workspace] = await Promise.all([
		guarded(hasCompanyDomain(env, orgId)),
		guarded(hasWorkspaceConnection(env, orgId)),
	])
	return {
		state: {
			domain,
			channels: introducedChannels(agent) > 0,
			second_asker: askers(agent) >= 2,
			tool_workspace: workspace,
			digest: standingDigests(agent) > 0,
		},
		reliable,
	}
}

export function journeyExitReason(state: RungState): "completed" | "refused" {
	return JOURNEY_RUNGS.every((rung) => state[rung]) ? "completed" : "refused"
}

export function nextRung(
	state: RungState,
	skip?: ReadonlySet<JourneyRung>,
): JourneyRung | null {
	return JOURNEY_RUNGS.find((rung) => !state[rung] && !skip?.has(rung)) ?? null
}
