import { SHARED_TEAM_BRAIN_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import { readableSlackChannelContainerTagsForUser } from "../slack/channel-membership"
import type { CompanyBrainAgent } from "../turn/agent"
import { type SlackMemoryScope, slackMemoryContainerTag } from "./writeback"

// The container tags a turn may READ from — always a superset of the single
// write tag (slackMemoryContainerTag). Shared Team Brain + the current scope's
// own tag, plus — for a personal DM — EVERY private channel the asker belongs
// to, i.e. their full access surface (no cap; searchBrain bounds the fan-out
// with batched concurrency). Public and private channels are unchanged: they
// only ever read shared + their own tag.
export function resolveBrainReadContainerTags(
	agent: CompanyBrainAgent,
	scope: SlackMemoryScope | undefined,
	/** Explicit surface from the admin console; replaces the derived set entirely. */
	override?: string[],
): string[] {
	// An explicit empty surface means read nothing, not fall back to the derived set.
	if (override !== undefined) return [...new Set(override)]
	const tags = new Set<string>([SHARED_TEAM_BRAIN_CONTAINER_TAG])
	const scopeTag = slackMemoryContainerTag(scope)
	if (scopeTag) tags.add(scopeTag)
	if (scope?.kind === "dm" && scope.slackUserId) {
		for (const tag of readableSlackChannelContainerTagsForUser(
			agent,
			scope.slackUserId,
		)) {
			tags.add(tag)
		}
	}
	return [...tags]
}
