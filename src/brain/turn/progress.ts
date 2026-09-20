export const COMPANY_BRAIN_TOOL_NAME = "search_company_brain"

// Silent bookkeeping tools: replaced the old reply/memory/connect output fields.
const SILENT_TOOLS = new Set([
	COMPANY_BRAIN_TOOL_NAME,
	"save_memory",
	"connect_app",
	"inspect_people_directory",
	"recall_tagged_memories",
	"list_memory_tags",
	"enable_tool_family",
])

export function shouldShowToolProgressCard(toolName: string): boolean {
	return !SILENT_TOOLS.has(toolName)
}
