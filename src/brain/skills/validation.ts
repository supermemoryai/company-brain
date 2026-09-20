export const SKILL_DESCRIPTION_MAX_CHARS = 200
export const SKILL_BODY_MAX_BYTES = 16 * 1024
export const SKILL_NAME_MAX_CHARS = 64
export const ORG_SKILL_CAP = 100
export const PERSONAL_SKILL_CAP = 25

export const SKILL_SCOPES = ["personal", "org"] as const
export type SkillScope = (typeof SKILL_SCOPES)[number]

export const SKILL_ORIGINS = ["slack", "web", "upload"] as const
export type SkillOrigin = (typeof SKILL_ORIGINS)[number]

export type SkillEditableInput = {
	name: string
	description: string
	body: string
	scope: SkillScope
}

export type ValidatedSkillInput = {
	name: string
	description: string
	body: string
	scope: SkillScope
}

export type SkillValidationContext = {
	existingNames?: Array<{
		id: string
		name: string
		scope: SkillScope
		creatorUserId: string
	}>
	excludeId?: string
	creatorUserId?: string
	orgSkillCount?: number
	personalSkillCount?: number
}

export type SkillUploadDraft = ValidatedSkillInput & {
	origin: "upload"
}

export class SkillValidationError extends Error {
	readonly code:
		| "invalid_input"
		| "name_conflict"
		| "org_limit"
		| "personal_limit"
		| "invalid_frontmatter"

	constructor(
		message: string,
		code: SkillValidationError["code"] = "invalid_input",
	) {
		super(message)
		this.name = "SkillValidationError"
		this.code = code
	}
}

const encoder = new TextEncoder()
function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new SkillValidationError(`${label} required`)
	}
	return value.trim()
}

export function normalizeSkillName(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLocaleLowerCase()
}

export function validateSkillInput(
	input: Partial<SkillEditableInput>,
	context: SkillValidationContext = {},
): ValidatedSkillInput {
	const name = requiredText(input.name, "name").replace(/\s+/g, " ")
	const description = requiredText(input.description, "description").replace(
		/\s+/g,
		" ",
	)
	const body = requiredText(input.body, "body")
	if (name.length > SKILL_NAME_MAX_CHARS) {
		throw new SkillValidationError(
			`name must be ${SKILL_NAME_MAX_CHARS} characters or fewer`,
		)
	}
	if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
		throw new SkillValidationError(
			`description must be ${SKILL_DESCRIPTION_MAX_CHARS} characters or fewer`,
		)
	}
	if (encoder.encode(body).byteLength > SKILL_BODY_MAX_BYTES) {
		throw new SkillValidationError(
			`body must be ${SKILL_BODY_MAX_BYTES} bytes or fewer`,
		)
	}
	if (!SKILL_SCOPES.includes(input.scope as SkillScope)) {
		throw new SkillValidationError("scope must be personal or org")
	}
	const scope = input.scope as SkillScope
	const normalizedName = normalizeSkillName(name)
	// Names resolve within one viewer's visible set, so a personal skill also has
	// to clear the org names it will sit beside. The reverse check is deliberately
	// absent: refusing an org name because someone holds it privately would
	// disclose that private name. loadVisibleSkillByName resolves that remaining
	// overlap in the creator's favour.
	const collidesWith = (candidate: {
		scope: SkillScope
		creatorUserId: string
	}) =>
		scope === "org"
			? candidate.scope === "org"
			: candidate.scope === "org" ||
				candidate.creatorUserId === context.creatorUserId
	if (
		context.existingNames?.some(
			(candidate) =>
				candidate.id !== context.excludeId &&
				collidesWith(candidate) &&
				normalizeSkillName(candidate.name) === normalizedName,
		)
	) {
		throw new SkillValidationError(
			"a skill with that name already exists",
			"name_conflict",
		)
	}
	if (scope === "org" && (context.orgSkillCount ?? 0) >= ORG_SKILL_CAP) {
		throw new SkillValidationError(
			`skill limit reached (${ORG_SKILL_CAP} per organization)`,
			"org_limit",
		)
	}
	if (
		scope === "personal" &&
		(context.personalSkillCount ?? 0) >= PERSONAL_SKILL_CAP
	) {
		throw new SkillValidationError(
			`personal skill limit reached (${PERSONAL_SKILL_CAP} per creator)`,
			"personal_limit",
		)
	}
	return { name, description, body, scope }
}

function stripInlineComment(value: string): string {
	let quote: "'" | '"' | undefined
	for (let index = 0; index < value.length; index++) {
		const character = value[index]
		if (quote === '"' && character === "\\") {
			index += 1
			continue
		}
		if (quote === "'" && character === "'" && value[index + 1] === "'") {
			index += 1
			continue
		}
		if (character === "'" || character === '"') {
			quote = quote === character ? undefined : quote ? quote : character
			continue
		}
		if (
			character === "#" &&
			!quote &&
			(index === 0 || /\s/.test(value[index - 1] ?? ""))
		) {
			return value.slice(0, index).trimEnd()
		}
	}
	return value
}

function parseFrontmatterScalar(value: string): string {
	const trimmed = stripInlineComment(value).trim()
	if (!trimmed) {
		throw new SkillValidationError(
			"SKILL.md name and description must be scalar strings",
			"invalid_frontmatter",
		)
	}
	if (trimmed.startsWith('"')) {
		try {
			const decoded = JSON.parse(trimmed)
			if (typeof decoded !== "string") throw new Error("not a string")
			return decoded.trim()
		} catch {
			throw new SkillValidationError(
				"SKILL.md frontmatter contains an invalid quoted value",
				"invalid_frontmatter",
			)
		}
	}
	if (trimmed.startsWith("'")) {
		if (!trimmed.endsWith("'") || trimmed.length < 2) {
			throw new SkillValidationError(
				"SKILL.md frontmatter contains an invalid quoted value",
				"invalid_frontmatter",
			)
		}
		return trimmed.slice(1, -1).replace(/''/g, "'").trim()
	}
	if (
		/^[[{]/.test(trimmed) ||
		trimmed.startsWith("&") ||
		trimmed.startsWith("*")
	) {
		throw new SkillValidationError(
			"SKILL.md name and description must be scalar strings",
			"invalid_frontmatter",
		)
	}
	if (
		/^(?:null|~|true|false)$/i.test(trimmed) ||
		/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)
	) {
		throw new SkillValidationError(
			"SKILL.md name and description must be scalar strings",
			"invalid_frontmatter",
		)
	}
	return trimmed
}

function parseFrontmatter(raw: string): Map<string, string> {
	const lines = raw.split("\n")
	const values = new Map<string, string>()
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? ""
		if (!line.trim() || line.trimStart().startsWith("#")) continue
		// SKILL.md files in the wild often carry extra nested metadata (for
		// example `metadata:` or `allowed-tools:`). Only name and description are
		// part of this product's compatibility surface, so nested lines belonging
		// to unrelated keys are deliberately ignored.
		if (/^\s+/.test(line)) continue
		const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
		if (!match) {
			throw new SkillValidationError(
				"SKILL.md frontmatter must use key: value fields",
				"invalid_frontmatter",
			)
		}
		const key = (match[1] ?? "").toLowerCase()
		const isEditableField = key === "name" || key === "description"
		if (isEditableField && values.has(key)) {
			throw new SkillValidationError(
				`SKILL.md frontmatter contains duplicate ${key}`,
				"invalid_frontmatter",
			)
		}
		const rawValue = (match[2] ?? "").trim()
		if (/^[>|][+-]?$/.test(stripInlineComment(rawValue).trim())) {
			const blockLines: string[] = []
			while (index + 1 < lines.length) {
				const candidate = lines[index + 1] ?? ""
				if (candidate.trim() && !/^\s+/.test(candidate)) break
				index += 1
				blockLines.push(candidate.replace(/^ {1,4}/, ""))
			}
			if (!isEditableField) continue
			const value = rawValue.startsWith(">")
				? blockLines
						.join("\n")
						.replace(/([^\n])\n(?=[^\n])/g, "$1 ")
						.replace(/\n{2,}/g, "\n")
				: blockLines.join("\n")
			values.set(key, value.trim())
			continue
		}
		if (isEditableField) values.set(key, parseFrontmatterScalar(rawValue))
	}
	return values
}

/** Parse the deliberately small SKILL.md compatibility surface: a YAML
 * frontmatter block with scalar name and description fields, then Markdown. */
export function parseSkillMarkdown(content: string): SkillUploadDraft {
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
	const lines = normalized.split("\n")
	if (lines[0]?.trim() !== "---") {
		throw new SkillValidationError(
			"SKILL.md must start with YAML frontmatter",
			"invalid_frontmatter",
		)
	}
	const endLine = lines.findIndex(
		(line, index) => index > 0 && /^---[\t ]*$/.test(line),
	)
	if (endLine < 0) {
		throw new SkillValidationError(
			"SKILL.md frontmatter is not closed",
			"invalid_frontmatter",
		)
	}
	const values = parseFrontmatter(lines.slice(1, endLine).join("\n"))
	const editable = validateSkillInput({
		name: values.get("name") ?? "",
		description: values.get("description") ?? "",
		body: lines
			.slice(endLine + 1)
			.join("\n")
			.trim(),
		scope: "personal",
	})
	return { ...editable, origin: "upload" }
}
