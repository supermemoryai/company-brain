import { db, eq } from "@repo/db"
import * as schema from "@repo/db/schema"
import type {
	BrainChannelProactivity,
	BrainProactivityDefault,
} from "@repo/db/schema/common"
import { MAX_WORKSPACE_PROMPT_LENGTH } from "@repo/lib/constants"
import type { Schedule } from "agents"
import type { ToolSet } from "ai"
import { normalizeCompanyDomain } from "./company-domain"
import { creditGrant } from "./journey/log"
import { getCompanyContext } from "./memory/company-context"
import { loadInteractionStyleProfile } from "./memory/interaction-style"
import {
	getWorkspacePrompt,
	setWorkspacePrompt,
} from "./memory/workspace-prompt"
import { setCompanyDomain } from "./settings/company-domain"
import { type BrainModelsPatch, updateBrainModels } from "./settings/models"
import { updateBrainProactivity } from "./settings/proactivity"
import { ensureChannelObserveTables } from "./slack/channel-observe"
import {
	BRAIN_CHANNEL_PROACTIVITY,
	BRAIN_PROACTIVITY_DEFAULTS,
	DEFAULT_BRAIN_PROACTIVITY,
	parseBrainProactivity,
} from "./slack/proactivity"
import { getWorkspaceStatusByOrgId } from "./slack/workspace"
import { type Automation, listAutomations } from "./tools/automations"
import { MCP_CATALOG } from "./tools/mcp/catalog"
import { listConnectionsForActor } from "./tools/mcp/store"
import { sandboxToolsConfigured } from "./tools/sandbox/client"
import {
	isManageableReminderSchedule,
	type ScheduledTaskPayload,
} from "./tools/scheduling"
import type { TurnActor } from "./turn/actor"
import type { CompanyBrainAgent } from "./turn/agent"
import type { TurnDeps } from "./turn/deps"
import { getHomeChannel, type HomeChannel } from "./turn/home-channel"
import {
	BRAIN_EFFORT_CHOICES,
	BRAIN_MAIN_EFFORT_CHOICES,
	BRAIN_MAIN_MODEL_CHOICES,
	BRAIN_TRIAGE_MODEL_CHOICES,
	resolveBrainMainEffort,
	resolveBrainMainModel,
	resolveBrainTriageEffort,
	resolveBrainTriageModel,
} from "./turn/model-profile"
import { isRecord } from "./turn/util"

export type BrainConfigViewer = {
	userId?: string
	isAdmin?: boolean
	slackUserId?: string
}

export type BrainAgentConfigSnapshot = {
	homeChannel: HomeChannel | null
	workspacePrompt: string | null
	automations: Automation[]
	reminders: {
		id: string
		label: string
		channel: string
		deliverTo: string | null
		kind: string
		nextRunAt: string | null
	}[]
	observedChannelCount: number
}

// DO-side config: agent SQLite + schedules; members only see their own reminders.
export async function collectBrainConfigSnapshot(
	agent: CompanyBrainAgent,
	viewer: BrainConfigViewer,
): Promise<BrainAgentConfigSnapshot> {
	const isAdmin = !!viewer.isAdmin

	const schedules =
		(await agent.listSchedules()) as Schedule<ScheduledTaskPayload>[]
	const reminders: BrainAgentConfigSnapshot["reminders"] = []
	for (const s of schedules) {
		if (!isManageableReminderSchedule(s)) continue
		const visible =
			isAdmin ||
			(!!viewer.userId && s.payload.creatorUserId === viewer.userId) ||
			(!!viewer.slackUserId &&
				s.payload.creatorSlackUserId === viewer.slackUserId)
		if (!visible) continue
		reminders.push({
			id: s.id,
			label: s.payload.label,
			channel: s.payload.channel,
			deliverTo: s.payload.deliverTo ?? null,
			kind: s.payload.kind ?? "reminder",
			nextRunAt:
				typeof s.time === "number"
					? new Date(s.time * 1000).toISOString()
					: null,
		})
	}

	ensureChannelObserveTables(agent)
	const [observed] = agent.sql<{ n: number }>`
		SELECT COUNT(*) AS n FROM brain_channel_observe
	`

	return {
		homeChannel: getHomeChannel(agent),
		workspacePrompt: getWorkspacePrompt(agent),
		automations: viewer.userId
			? listAutomations(agent, { userId: viewer.userId, isAdmin })
			: isAdmin
				? listAutomations(agent, { userId: "", isAdmin: true })
				: [],
		reminders,
		observedChannelCount: Number(observed?.n ?? 0),
	}
}

function metaString(metadata: unknown, key: string): string | null {
	if (!isRecord(metadata)) return null
	const value = metadata[key]
	return typeof value === "string" ? value : null
}

// Postgres + metadata merged with the agent snapshot; failure-isolated, no secrets.
export async function buildBrainConfiguration(args: {
	env: Env
	orgId: string
	metadata: unknown
	viewer: BrainConfigViewer
	snapshot: BrainAgentConfigSnapshot
	// Mirror the turn's runtime inventory scope so automations never see personal rows.
	connectionScope?: { personalOnly?: boolean; orgSharedOnly?: boolean }
}) {
	const { env, orgId, metadata, viewer, snapshot } = args

	const [settingsRow, companyContext, interactionStyle, connections, slack] =
		await Promise.all([
			db(env)
				.query.organizationSettings.findFirst({
					where: eq(schema.organizationSettings.orgId, orgId),
					columns: { brainProactivity: true },
				})
				.catch(() => null),
			getCompanyContext(env, orgId).catch(() => null),
			loadInteractionStyleProfile(env, orgId, viewer.slackUserId).catch(
				() => null,
			),
			listConnectionsForActor(
				env,
				orgId,
				viewer.userId,
				args.connectionScope ?? {},
			).catch(() => []),
			getWorkspaceStatusByOrgId(env, orgId).catch(() => ({
				connected: false,
				teamName: null as string | null,
			})),
		])
	const proactivity = parseBrainProactivity(settingsRow?.brainProactivity)

	return {
		workspace: {
			mode: metaString(metadata, "brainMode"),
			domain: metaString(metadata, "brainWorkspaceDomain"),
			name: metaString(metadata, "brainWorkspaceName"),
			trial: {
				status: metaString(metadata, "brainTrialStatus"),
				startedAt: metaString(metadata, "brainTrialStartedAt"),
				endsAt: metaString(metadata, "brainTrialEndsAt"),
			},
		},
		models: {
			main: resolveBrainMainModel(metadata),
			// A configured "auto" must report as auto, not the resolved default.
			mainEffort:
				isRecord(metadata) &&
				isRecord(metadata.brainModels) &&
				metadata.brainModels.mainEffort === "auto"
					? "auto"
					: resolveBrainMainEffort(metadata),
			triage: resolveBrainTriageModel(metadata),
			triageEffort: resolveBrainTriageEffort(metadata),
		},
		proactivity: {
			default: proactivity.default ?? DEFAULT_BRAIN_PROACTIVITY,
			channelOverrides: proactivity.channels ?? {},
			// The home channel is always proactive regardless of overrides.
			homeChannelId: snapshot.homeChannel?.channelId ?? null,
		},
		prompt: {
			workspacePrompt: snapshot.workspacePrompt,
			companyContext,
			interactionStyle,
		},
		connections: {
			apps: connections.map((r) => ({
				slug: r.serverSlug,
				runtime: r.runtime,
				authType: r.authType,
				status: r.status,
				shared: r.userId == null,
			})),
			catalog: MCP_CATALOG.map((e) => ({
				slug: e.slug,
				name: e.name,
				category: e.category,
			})),
		},
		schedules: {
			automations: snapshot.automations,
			reminders: snapshot.reminders,
		},
		slack: {
			connected: slack.connected,
			teamName: slack.teamName,
			observedChannelCount: snapshot.observedChannelCount,
		},
		capabilities: {
			sandbox: sandboxToolsConfigured(env),
			// context.dev when keyed, Firecrawl's keyless tier otherwise.
			webSearch: true,
		},
	}
}

// Read-only self-introspection; same redacted view as the HTTP route.
export function createConfigurationTool(args: {
	deps: TurnDeps
	env: Env
	agent: CompanyBrainAgent
	orgId: string
	orgMetadata: unknown
	actor: TurnActor
	askerSlackUserId?: string
	traceId: string
	allowWrites?: boolean
}): ToolSet {
	const { deps, env, agent, orgId, orgMetadata, actor, traceId } = args

	const get_configuration = deps.tool({
		description:
			"Look up how this Company Brain is currently configured: connected apps and the connectable catalog, automations and reminders, model settings, Slack proactivity, workspace prompt and company context, trial status, and capabilities. Read-only. Use it whenever someone asks what you are set up to do, what is connected, or why a behavior is on or off; summarize the relevant part rather than dumping the raw object.",
		inputSchema: deps.z.object({}),
		execute: async () => {
			const t = Date.now()
			const viewer = {
				userId: actor.userId,
				isAdmin: !!actor.isAdmin,
				slackUserId: args.askerSlackUserId,
			}
			const snapshot = await collectBrainConfigSnapshot(agent, viewer)
			const configuration = await buildBrainConfiguration({
				env,
				orgId,
				metadata: orgMetadata,
				viewer,
				snapshot,
				connectionScope: {
					personalOnly: actor.personalConnectionsOnly,
					orgSharedOnly: actor.orgSharedOnly,
				},
			})
			console.log(
				`[company-brain][${traceId}] get_configuration ms=${Date.now() - t}`,
			)
			return configuration
		},
	})

	// Enforced in execute, not the wire schema: Anthropic rejects non-object tool schemas.
	const updateInputSchema = deps.z.discriminatedUnion("field", [
		deps.z.object({
			field: deps.z.literal("company_domain"),
			value: deps.z.string().min(1).max(200),
		}),
		deps.z.object({
			field: deps.z.literal("proactivity_default"),
			value: deps.z.enum(BRAIN_PROACTIVITY_DEFAULTS),
		}),
		deps.z.object({
			field: deps.z.literal("channel_proactivity"),
			channelId: deps.z.string().regex(/^[CDG][A-Z0-9]{4,30}$/),
			value: deps.z.enum(BRAIN_CHANNEL_PROACTIVITY).nullable(),
		}),
		deps.z.object({
			field: deps.z.literal("models"),
			main: deps.z.enum(BRAIN_MAIN_MODEL_CHOICES).nullish(),
			mainEffort: deps.z.enum(BRAIN_MAIN_EFFORT_CHOICES).nullish(),
			triage: deps.z.enum(BRAIN_TRIAGE_MODEL_CHOICES).nullish(),
			triageEffort: deps.z.enum(BRAIN_EFFORT_CHOICES).nullish(),
		}),
		deps.z.object({
			field: deps.z.literal("workspace_prompt"),
			value: deps.z.string().max(MAX_WORKSPACE_PROMPT_LENGTH).nullable(),
		}),
	])

	const update_configuration = deps.tool({
		description:
			"Change one piece of this workspace's Company Brain configuration: company_domain, proactivity_default, channel_proactivity, models and workspace_prompt. All are admin-only, matching the web settings pages. Setting company_domain re-runs company research and updates the saved research findings in place, so it can be changed whenever the company's domain changes. Use it when someone asks to change a setting instead of describing where to click.",
		inputSchema: deps.z.object({
			field: deps.z
				.enum([
					"company_domain",
					"proactivity_default",
					"channel_proactivity",
					"models",
					"workspace_prompt",
				])
				.describe("Which setting to change."),
			value: deps.z
				.string()
				.nullish()
				.describe(
					`Required except for models. company_domain: the company's website or domain, like acme.com. proactivity_default: one of ${BRAIN_PROACTIVITY_DEFAULTS.join(", ")} — where the bot may reply unprompted. channel_proactivity: one of ${BRAIN_CHANNEL_PROACTIVITY.join(", ")}, or null to remove this channel's override. workspace_prompt: the standing workspace instructions, or null to clear them.`,
				),
			channelId: deps.z
				.string()
				.nullish()
				.describe("Slack channel id; required for channel_proactivity only."),
			main: deps.z.enum(BRAIN_MAIN_MODEL_CHOICES).nullish(),
			mainEffort: deps.z.enum(BRAIN_MAIN_EFFORT_CHOICES).nullish(),
			triage: deps.z.enum(BRAIN_TRIAGE_MODEL_CHOICES).nullish(),
			triageEffort: deps.z.enum(BRAIN_EFFORT_CHOICES).nullish(),
		}),
		execute: (raw) => {
			const parsed = updateInputSchema.safeParse(
				Object.fromEntries(
					Object.entries(raw).filter(([, v]) => v !== undefined),
				),
			)
			if (!parsed.success) {
				return Promise.resolve({
					updated: false as const,
					reason: `Invalid input for ${raw.field}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
				})
			}
			return applyConfigurationUpdate(
				{ env, agent, orgId, actor, traceId },
				parsed.data,
			)
		},
	})

	return args.allowWrites === false
		? { get_configuration }
		: { get_configuration, update_configuration }
}

type UpdateConfigurationInput =
	| { field: "company_domain"; value: string }
	| { field: "proactivity_default"; value: BrainProactivityDefault }
	| {
			field: "channel_proactivity"
			channelId: string
			value: BrainChannelProactivity | null
	  }
	| ({ field: "models" } & BrainModelsPatch)
	| { field: "workspace_prompt"; value: string | null }

type ConfigurationUpdateContext = {
	env: Env
	agent: CompanyBrainAgent
	orgId: string
	actor: TurnActor
	traceId: string
}

type ConfigurationUpdateResult =
	| { updated: true; field: string; detail: Record<string, unknown> }
	| { updated: false; reason: string }

const ADMIN_ONLY_REASON =
	"Only an organization admin can change this, same as the web settings page."

async function applyConfigurationUpdate(
	ctx: ConfigurationUpdateContext,
	input: UpdateConfigurationInput,
): Promise<ConfigurationUpdateResult> {
	const t = Date.now()
	if (!ctx.actor.isAdmin) {
		return { updated: false, reason: ADMIN_ONLY_REASON }
	}
	const result = await applyField(ctx, input)
	console.log(
		`[company-brain][${ctx.traceId}] update_configuration field=${input.field} updated=${result.updated} ms=${Date.now() - t}`,
	)
	return result
}

async function applyField(
	ctx: ConfigurationUpdateContext,
	input: UpdateConfigurationInput,
): Promise<ConfigurationUpdateResult> {
	switch (input.field) {
		case "company_domain":
			return applyCompanyDomain(ctx, input.value)
		case "proactivity_default": {
			const result = await updateBrainProactivity(ctx.env, ctx.orgId, {
				default: input.value,
			})
			if ("error" in result) return { updated: false, reason: result.error }
			return {
				updated: true,
				field: input.field,
				detail: { default: input.value },
			}
		}
		case "channel_proactivity": {
			const result = await updateBrainProactivity(ctx.env, ctx.orgId, {
				channels: { [input.channelId]: input.value },
			})
			if ("error" in result) {
				return {
					updated: false,
					reason: "That would exceed the per-channel override limit.",
				}
			}
			return {
				updated: true,
				field: input.field,
				detail: { channelId: input.channelId, value: input.value },
			}
		}
		case "models": {
			const { field: _field, ...patch } = input
			if (!Object.values(patch).some((value) => value !== undefined)) {
				return {
					updated: false,
					reason: "Name at least one model or effort to change.",
				}
			}
			const merged = await updateBrainModels(ctx.env, ctx.orgId, patch)
			if (!merged) return { updated: false, reason: "Organization not found." }
			return {
				updated: true,
				field: input.field,
				detail: { overrides: merged },
			}
		}
		case "workspace_prompt": {
			const prompt = setWorkspacePrompt(ctx.agent, input.value)
			return {
				updated: true,
				field: input.field,
				detail: { prompt, cleared: prompt === null },
			}
		}
	}
}

async function applyCompanyDomain(
	ctx: ConfigurationUpdateContext,
	value: string,
): Promise<ConfigurationUpdateResult> {
	const domain = normalizeCompanyDomain(value)
	if (!domain) {
		return {
			updated: false,
			reason:
				"That doesn't look like a company domain (personal email providers don't count). Ask for the company's website, like acme.com.",
		}
	}
	if (!(await setCompanyDomain(ctx.env, ctx.orgId, domain))) {
		return {
			updated: false,
			reason:
				"I couldn't save the company domain just now. Try again in a moment.",
		}
	}
	// Research memories need an owner; unmapped askers fall back to the installer.
	const [ws] = await db(ctx.env)
		.select({ installer: schema.slackWorkspace.installedByUserId })
		.from(schema.slackWorkspace)
		.where(eq(schema.slackWorkspace.orgId, ctx.orgId))
		.limit(1)
	const ownerId = ctx.actor.userId ?? ws?.installer ?? null
	const research = ownerId
		? await startDomainResearch(ctx, domain, ownerId)
		: "Saved; research starts on the next install sync."
	creditGrant(ctx.agent, "domain")
	return {
		updated: true,
		field: "company_domain",
		detail: { domain, research },
	}
}

// force is required: researchCompanyOnSignup no-ops on a queued/running/done pass,
// which is every existing install. A same-domain pass is still worth keeping.
async function startDomainResearch(
	ctx: ConfigurationUpdateContext,
	domain: string,
	ownerId: string,
): Promise<string> {
	const state = await ctx.agent.getResearchState()
	if (state.domain === domain) {
		if (state.status === "queued" || state.status === "running") {
			return "Already running. Findings land in the home channel when it finishes."
		}
		if (state.status === "done") {
			return "Already researched for this domain."
		}
	}
	await ctx.agent.researchCompanyOnSignup({ domain, ownerId, force: true })
	return "Started. Findings land in the home channel when it finishes."
}
