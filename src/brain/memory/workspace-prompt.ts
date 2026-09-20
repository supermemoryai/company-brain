import { MAX_WORKSPACE_PROMPT_LENGTH } from "@repo/lib/constants"
import type { CompanyBrainAgent } from "../turn/agent"

export function normalizeWorkspacePrompt(
	value: string | null | undefined,
): string | null {
	const normalized = value?.trim()
	if (!normalized) return null

	const truncated = normalized.slice(0, MAX_WORKSPACE_PROMPT_LENGTH)
	return truncated.replace(/[\uD800-\uDBFF]$/, "") || null
}

export function ensureWorkspacePromptTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_workspace_prompt (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			prompt TEXT
		)
	`
}

export function getWorkspacePrompt(agent: CompanyBrainAgent): string | null {
	ensureWorkspacePromptTable(agent)
	const [row] = agent.sql<{ prompt: string | null }>`
		SELECT prompt FROM brain_workspace_prompt WHERE id = 1
	`
	return row?.prompt ?? null
}

export function setWorkspacePrompt(
	agent: CompanyBrainAgent,
	value: string | null,
): string | null {
	ensureWorkspacePromptTable(agent)
	const prompt = normalizeWorkspacePrompt(value)
	agent.sql`
		INSERT INTO brain_workspace_prompt (id, prompt)
		VALUES (1, ${prompt})
		ON CONFLICT(id) DO UPDATE SET prompt = excluded.prompt
	`
	return prompt
}
