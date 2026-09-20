import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker"

type JsonObject = Record<string, unknown>

export type CommandWrapperToolAnnotations = {
	readOnlyHint?: boolean
	destructiveHint?: boolean
	idempotentHint?: boolean
	openWorldHint?: boolean
}

export type CommandWrapperToolContract = {
	name: string
	description?: string
	inputSchema: JsonObject
	annotations?: CommandWrapperToolAnnotations
	fieldSchemas: Record<string, JsonObject>
	unresolvedSchemaPaths: string[]
}

export type CommandWrapperHydrationFailure = {
	toolName: string
	fieldPath?: string
	reason: string
	detail?: string
	observedAt: number
}

export type CommandWrapperContract = {
	commandField: string
	commands: {
		info: string
		schema: string
		call: string
	}
	infoJsonFlag?: string
	callJsonFlag?: string
	callConfirmFlag?: string
	leadingTokens: string[]
	requiredAuxiliaryFields: Array<{
		name: string
		type?: string
		defaultValue?: unknown
	}>
	tools: Record<string, CommandWrapperToolContract>
	/** Deterministic inspection failures. Kept with the catalog so the model gets
	 * one explicit failure instead of repeatedly re-running the same metadata
	 * command with slightly different wrapper context. */
	failures?: Record<string, CommandWrapperHydrationFailure>
}

export type CommandWrapperVirtualMethod = {
	methodName: string
	tool: CommandWrapperToolContract
	inputSchema: JsonObject
}

export type ParsedCommandWrapperCommand =
	| { kind: "info"; toolName: string }
	| { kind: "schema"; toolName: string; fieldPath?: string }
	| { kind: "call"; toolName: string; jsonInput: string }
	| { kind: "other"; leadingToken: string }
	| { kind: "malformed"; leadingToken: string }

export type DecodedCommandWrapperCall = {
	tool: CommandWrapperToolContract
	input: unknown
}

const MAX_WRAPPER_TOOLS = 256
const MAX_WRAPPER_FIELDS_PER_TOOL = 64
const MAX_WRAPPER_SCHEMA_CHARS = 48_000
const MAX_WRAPPER_TOOL_CHARS = 192_000
const MAX_SCHEMA_DEPTH = 40
const MAX_SCHEMA_NODES = 5_000
const TOOL_NAME_PATTERN = "[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,159}"
const VALID_SCHEMA_TYPES = new Set([
	"array",
	"boolean",
	"integer",
	"null",
	"number",
	"object",
	"string",
])

function objectRecord(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined
}

function cloneJsonObject(value: unknown): JsonObject | undefined {
	const record = objectRecord(value)
	if (!record) return undefined
	try {
		return JSON.parse(JSON.stringify(record)) as JsonObject
	} catch {
		return undefined
	}
}

function cloneJsonValue(value: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(value)) as unknown
	} catch {
		return undefined
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

type CommandGrammarProduction = {
	verb: string
	placeholders: string[]
	flags: string[]
}

const COMMAND_SECTION_PATTERN =
	/\b(?:supported commands?|allowed commands?)\s*(?::|=|are)\s*/i

function commandGrammarBody(description: string):
	| {
			inline: string
			body: string
	  }
	| undefined {
	const marker = COMMAND_SECTION_PATTERN.exec(description)
	if (!marker) return undefined
	const tail = description.slice(marker.index + marker[0].length)
	const inline = tail.split("\n", 1)[0]?.trim() ?? ""
	const trimmed = tail.trimStart()
	const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)```/)
	if (fenced?.[1]) return { inline, body: fenced[1] }
	const lines: string[] = []
	let started = false
	for (const line of tail.split("\n").slice(0, 40)) {
		const clean = line.trim()
		if (/^#{1,6}\s|^\*\*[^*]+\*\*/.test(clean) && started) break
		if (!clean) {
			if (started) break
			continue
		}
		started = true
		lines.push(line)
	}
	return { inline, body: lines.join("\n") }
}

function commandGrammarProduction(
	line: string,
): CommandGrammarProduction | undefined {
	const clean = line
		.trim()
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^`|`$/g, "")
	if (!clean || clean.startsWith("#") || clean.startsWith("```")) {
		return undefined
	}
	const match = clean.match(/^([a-zA-Z][a-zA-Z0-9_.:-]{0,79})(?=\s|$)/)
	if (!match?.[1]) return undefined
	const placeholders = [
		...clean.matchAll(/<([a-zA-Z][a-zA-Z0-9_-]*)>/g),
		...clean.matchAll(/\[(?:<)?([a-zA-Z][a-zA-Z0-9_-]*)(?:>)?\]/g),
	]
		.map((candidate) => candidate[1]?.toLowerCase().replace(/-/g, "_"))
		.filter((candidate): candidate is string => Boolean(candidate))
	const flags = [...clean.matchAll(/--[a-zA-Z0-9_-]+/g)].map((candidate) =>
		candidate[0].toLowerCase(),
	)
	return {
		verb: match[1].toLowerCase(),
		placeholders: [...new Set(placeholders)],
		flags: [...new Set(flags)],
	}
}

function inlineCommandTokens(value: string): string[] {
	if (
		!value ||
		value.startsWith("```") ||
		!/[,|]|\b(?:and|or)\b/i.test(value)
	) {
		return []
	}
	return value
		.replace(/\b(?:and|or)\b/gi, ",")
		.replace(/[.;].*$/, "")
		.split(/[,|]/)
		.map((candidate) => candidate.trim().replace(/^[`'"\s]+|[`'"\s]+$/g, ""))
		.filter((candidate) => /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(candidate))
		.map((candidate) => candidate.toLowerCase())
}

function commandGrammar(description: string):
	| {
			productions: CommandGrammarProduction[]
			leadingTokens: string[]
	  }
	| undefined {
	const section = commandGrammarBody(description)
	if (!section) return undefined
	const productions = section.body
		.split("\n")
		.map(commandGrammarProduction)
		.filter((candidate): candidate is CommandGrammarProduction =>
			Boolean(candidate),
		)
	const leadingTokens = [
		...new Set([
			...inlineCommandTokens(section.inline),
			...productions.map((production) => production.verb),
		]),
	].slice(0, 32)
	return { productions, leadingTokens }
}

/**
 * Detect an MCP that exposes nested tools through a documented command field.
 * Detection requires all three schema-inspection and execution productions, so
 * ordinary string-command tools do not enter this path accidentally.
 */
export function detectCommandWrapperContract(
	inputSchema: unknown,
): CommandWrapperContract | undefined {
	const schema = objectRecord(inputSchema)
	if (!schema) return undefined
	const properties = objectRecord(schema.properties)
	if (!properties) return undefined
	for (const [field, value] of Object.entries(properties)) {
		const property = objectRecord(value)
		if (
			property?.type !== "string" ||
			typeof property.description !== "string"
		) {
			continue
		}
		const description = property.description
		const grammar = commandGrammar(description)
		if (!grammar) continue
		const hasToolPlaceholder = (production: CommandGrammarProduction) =>
			production.placeholders.some((name) =>
				["name", "tool", "tool_name"].includes(name),
			)
		const hasInputPlaceholder = (production: CommandGrammarProduction) =>
			production.placeholders.some((name) =>
				[
					"args",
					"arguments",
					"arguments_json",
					"input",
					"json",
					"json_args",
					"json_input",
					"parameters",
					"params",
					"payload",
				].includes(name),
			)
		const hasFieldPlaceholder = (production: CommandGrammarProduction) =>
			production.placeholders.some((name) =>
				["field", "field_name", "field_path", "path"].includes(name),
			)
		const callProduction = grammar.productions.find(
			(production) =>
				hasToolPlaceholder(production) && hasInputPlaceholder(production),
		)
		const schemaProduction = grammar.productions.find(
			(production) =>
				hasToolPlaceholder(production) && hasFieldPlaceholder(production),
		)
		const infoProduction = grammar.productions.find(
			(production) =>
				hasToolPlaceholder(production) &&
				!hasFieldPlaceholder(production) &&
				!hasInputPlaceholder(production),
		)
		const info = infoProduction?.verb
		const schemaVerb = schemaProduction?.verb
		const call = callProduction?.verb
		if (
			!info ||
			!schemaVerb ||
			!call ||
			new Set([info, schemaVerb, call]).size < 3
		) {
			continue
		}
		const required = Array.isArray(schema.required)
			? schema.required.filter(
					(candidate): candidate is string => typeof candidate === "string",
				)
			: []
		const requiredAuxiliaryFields = required
			.filter((candidate) => candidate !== field)
			.map((name) => {
				const auxiliary = objectRecord(properties[name])
				return {
					name,
					type:
						typeof auxiliary?.type === "string" ? auxiliary.type : undefined,
					defaultValue: auxiliary?.default,
				}
			})
		return {
			commandField: field,
			commands: { info, schema: schemaVerb, call },
			infoJsonFlag: infoProduction?.flags.includes("--json")
				? "--json"
				: undefined,
			callJsonFlag: callProduction?.flags.includes("--json")
				? "--json"
				: undefined,
			callConfirmFlag: callProduction?.flags.includes("--confirm")
				? "--confirm"
				: undefined,
			leadingTokens: grammar.leadingTokens,
			requiredAuxiliaryFields,
			tools: {},
		}
	}
	return undefined
}

function commandPattern(verb: string, source: string): RegExp {
	return new RegExp(`^${escapeRegExp(verb)}${source}$`, "i")
}

function optionalFlagSequence(flags: Array<string | undefined>): string {
	const allowed = [
		...new Set(flags.filter((flag): flag is string => Boolean(flag))),
	]
	if (allowed.length === 0) return ""
	return `(?:\\s+(?:${allowed.map(escapeRegExp).join("|")}))*`
}

export function parseCommandWrapperCommand(
	contract: CommandWrapperContract,
	command: string,
): ParsedCommandWrapperCommand {
	const trimmed = command.trim()
	const leadingToken = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? ""
	const infoFlags = optionalFlagSequence([contract.infoJsonFlag])
	const info = trimmed.match(
		commandPattern(
			contract.commands.info,
			`${infoFlags}\\s+(${TOOL_NAME_PATTERN})${infoFlags}`,
		),
	)
	if (info?.[1]) return { kind: "info", toolName: info[1] }
	const schema = trimmed.match(
		commandPattern(
			contract.commands.schema,
			`\\s+(${TOOL_NAME_PATTERN})(?:\\s+([^\\s]+))?`,
		),
	)
	if (schema?.[1]) {
		return {
			kind: "schema",
			toolName: schema[1],
			fieldPath: schema[2],
		}
	}
	const call = trimmed.match(
		commandPattern(
			contract.commands.call,
			`${optionalFlagSequence([contract.callJsonFlag, contract.callConfirmFlag])}\\s+(${TOOL_NAME_PATTERN})\\s+([\\s\\S]+)`,
		),
	)
	if (call?.[1] && call[2]) {
		return { kind: "call", toolName: call[1], jsonInput: call[2].trim() }
	}
	if (
		[
			contract.commands.info,
			contract.commands.schema,
			contract.commands.call,
		].includes(leadingToken)
	) {
		return { kind: "malformed", leadingToken }
	}
	return { kind: "other", leadingToken }
}

function structuredObject(value: unknown, depth = 0): JsonObject | undefined {
	if (depth > 5) return undefined
	if (typeof value === "string") {
		try {
			return structuredObject(JSON.parse(value), depth + 1)
		} catch {
			return undefined
		}
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const parsed = structuredObject(item, depth + 1)
			if (parsed) return parsed
		}
		return undefined
	}
	const record = objectRecord(value)
	if (!record) return undefined
	if (typeof record.name === "string" && objectRecord(record.inputSchema)) {
		return record
	}
	if (
		objectRecord(record.schema) &&
		(record.field === undefined || typeof record.field === "string")
	) {
		return record
	}
	for (const key of ["structuredContent", "result", "data", "content"]) {
		if (!(key in record)) continue
		const parsed = structuredObject(record[key], depth + 1)
		if (parsed) return parsed
	}
	if (typeof record.text === "string") {
		return structuredObject(record.text, depth + 1)
	}
	return undefined
}

function summaryHint(value: unknown): string | undefined {
	const record = objectRecord(value)
	return typeof record?.hint === "string" ? record.hint : undefined
}

type SchemaSanitizeState = { nodes: number }

class CommandWrapperSchemaError extends Error {}

function compactSchemaDocumentation(
	value: string,
	maxChars: number,
): string | undefined {
	const compact = value.replace(/\s+/g, " ").trim()
	if (!compact) return undefined
	return compact.length <= maxChars
		? compact
		: `${compact.slice(0, maxChars - 1).trimEnd()}…`
}

/** Preserve validation-relevant JSON Schema structure while removing bulky
 * presentation metadata. The first pass retains short descriptions; callers
 * retry without documentation before deciding that a schema is too large. */
function sanitizeSchemaNode(
	value: unknown,
	path: string,
	unresolved: Set<string>,
	options: {
		includeDocumentation?: boolean
		depth?: number
		state?: SchemaSanitizeState
	} = {},
): JsonObject {
	const depth = options.depth ?? 0
	const state = options.state ?? { nodes: 0 }
	if (depth > MAX_SCHEMA_DEPTH) {
		throw new CommandWrapperSchemaError(
			`schema nesting exceeds ${MAX_SCHEMA_DEPTH} levels`,
		)
	}
	state.nodes += 1
	if (state.nodes > MAX_SCHEMA_NODES) {
		throw new CommandWrapperSchemaError(
			`schema contains more than ${MAX_SCHEMA_NODES} nodes`,
		)
	}

	if (value === true) return {}
	if (value === false) return { not: {} }
	const source = objectRecord(value)
	if (!source) {
		throw new CommandWrapperSchemaError(
			`schema node${path ? ` at ${path}` : ""} is not an object or boolean`,
		)
	}
	const output: JsonObject = {}
	const includeDocumentation = options.includeDocumentation !== false
	const child = (candidate: unknown, childPath = path) =>
		sanitizeSchemaNode(candidate, childPath, unresolved, {
			includeDocumentation,
			depth: depth + 1,
			state,
		})
	const hint = summaryHint(source)
	if (hint && path) unresolved.add(path)
	if (hint) output.hint = compactSchemaDocumentation(hint, 500)

	const sourceType = source.type
	// Quarantine rather than widen: an unusable type must not skip validation.
	const unusableType = () => {
		if (!path) {
			throw new CommandWrapperSchemaError("schema contains an invalid type")
		}
		unresolved.add(path)
	}
	if (typeof sourceType === "string" && VALID_SCHEMA_TYPES.has(sourceType)) {
		output.type = sourceType
	} else if (Array.isArray(sourceType)) {
		const types = [
			...new Set(
				sourceType.filter(
					(candidate): candidate is string =>
						typeof candidate === "string" && VALID_SCHEMA_TYPES.has(candidate),
				),
			),
		]
		if (types.length) output.type = types
		else unusableType()
	} else if (sourceType !== undefined) {
		unusableType()
	}

	if (typeof source.$ref === "string") {
		if (!source.$ref.startsWith("#")) {
			throw new CommandWrapperSchemaError(
				"schema contains an external $ref that cannot be validated locally",
			)
		}
		output.$ref = source.$ref
	}
	if (includeDocumentation) {
		if (typeof source.title === "string") {
			output.title = compactSchemaDocumentation(source.title, 160)
		}
		const description = [
			typeof source.description === "string" ? source.description : undefined,
			hint,
		]
			.filter((candidate): candidate is string => Boolean(candidate))
			.join(" ")
		if (description) {
			output.description = compactSchemaDocumentation(description, 500)
		}
	}
	for (const key of [
		"format",
		"pattern",
		"contentEncoding",
		"contentMediaType",
	] as const) {
		if (typeof source[key] === "string") output[key] = source[key]
	}
	for (const key of [
		"minimum",
		"maximum",
		"exclusiveMinimum",
		"exclusiveMaximum",
		"multipleOf",
		"minLength",
		"maxLength",
		"minItems",
		"maxItems",
		"minContains",
		"maxContains",
		"minProperties",
		"maxProperties",
	] as const) {
		if (typeof source[key] === "number") output[key] = source[key]
	}
	for (const key of ["uniqueItems", "nullable"] as const) {
		if (typeof source[key] === "boolean") output[key] = source[key]
	}
	if (Array.isArray(source.enum)) output.enum = cloneJsonValue(source.enum)
	if ("const" in source) output.const = cloneJsonValue(source.const)

	for (const key of [
		"additionalProperties",
		"unevaluatedProperties",
	] as const) {
		const candidate = source[key]
		if (candidate === false || candidate === true) output[key] = candidate
		else if (objectRecord(candidate)) {
			output[key] = child(candidate, path ? `${path}.*` : "*")
		}
	}
	if (source.items === true || source.items === false) {
		output.items = child(source.items, path ? `${path}[]` : "[]")
	} else if (objectRecord(source.items)) {
		output.items = child(source.items, path ? `${path}[]` : "[]")
	} else if (Array.isArray(source.items)) {
		output.items = source.items.map((item) =>
			child(item, path ? `${path}[]` : "[]"),
		)
	}
	for (const key of ["prefixItems", "allOf", "anyOf", "oneOf"] as const) {
		if (!Array.isArray(source[key])) continue
		output[key] = source[key].map((item) => child(item))
	}
	for (const key of [
		"contains",
		"additionalItems",
		"unevaluatedItems",
		"not",
		"if",
		"then",
		"else",
		"propertyNames",
	] as const) {
		const candidate = source[key]
		if (candidate === true || candidate === false || objectRecord(candidate)) {
			output[key] = child(candidate)
		}
	}

	const required = new Set(
		Array.isArray(source.required)
			? source.required.filter(
					(candidate): candidate is string => typeof candidate === "string",
				)
			: [],
	)
	const properties = objectRecord(source.properties)
	if (properties) {
		output.type = output.type ?? "object"
		output.properties = Object.fromEntries(
			Object.entries(properties).map(([field, property]) => [
				field,
				child(property, path ? `${path}.${field}` : field),
			]),
		)
		for (const [field, property] of Object.entries(properties)) {
			if (objectRecord(property)?.required === true) required.add(field)
		}
	}
	if (required.size > 0) output.required = [...required]
	for (const key of [
		"patternProperties",
		"$defs",
		"definitions",
		"dependentSchemas",
	] as const) {
		const candidates = objectRecord(source[key])
		if (!candidates) continue
		output[key] = Object.fromEntries(
			Object.entries(candidates).map(([name, candidate]) => [
				name,
				child(candidate, path),
			]),
		)
	}
	const dependentRequired = objectRecord(source.dependentRequired)
	if (dependentRequired) {
		output.dependentRequired = Object.fromEntries(
			Object.entries(dependentRequired).flatMap(([field, dependencies]) =>
				Array.isArray(dependencies) &&
				dependencies.every((candidate) => typeof candidate === "string")
					? [[field, [...dependencies]]]
					: [],
			),
		)
	}
	const dependencies = objectRecord(source.dependencies)
	if (dependencies) {
		const normalizedDependencies: Array<[string, unknown]> = []
		for (const [field, dependency] of Object.entries(dependencies)) {
			if (
				Array.isArray(dependency) &&
				dependency.every((candidate) => typeof candidate === "string")
			) {
				normalizedDependencies.push([field, [...dependency]])
				continue
			}
			if (
				dependency === true ||
				dependency === false ||
				objectRecord(dependency)
			) {
				normalizedDependencies.push([field, child(dependency, path)])
			}
		}
		output.dependencies = Object.fromEntries(normalizedDependencies)
	}
	return output
}

function setSchemaAtPath(
	root: JsonObject,
	fieldPath: string,
	fieldSchema: JsonObject,
): void {
	const segments = fieldPath
		.replace(/\[\]/g, "")
		.split(".")
		.map((segment) => segment.trim())
		.filter(Boolean)
	if (segments.length === 0) return
	let current = root
	for (const [index, segment] of segments.entries()) {
		const properties = objectRecord(current.properties) ?? {}
		current.properties = properties
		if (index === segments.length - 1) {
			properties[segment] = fieldSchema
			return
		}
		const child = objectRecord(properties[segment]) ?? {
			type: "object",
			properties: {},
		}
		properties[segment] = child
		current = child
	}
}

export function materializeCommandWrapperToolSchema(
	tool: Pick<CommandWrapperToolContract, "inputSchema" | "fieldSchemas">,
): { inputSchema: JsonObject; unresolvedSchemaPaths: string[] } {
	const unresolved = new Set<string>()
	const materialized = sanitizeSchemaNode(tool.inputSchema, "", unresolved)
	for (const [fieldPath, fieldSchema] of Object.entries(tool.fieldSchemas)) {
		const fieldUnresolved = new Set<string>()
		const resolved = sanitizeSchemaNode(fieldSchema, fieldPath, fieldUnresolved)
		setSchemaAtPath(materialized, fieldPath, resolved)
		for (const path of [...unresolved]) {
			if (path === fieldPath || path.startsWith(`${fieldPath}.`)) {
				unresolved.delete(path)
			}
		}
		for (const path of fieldUnresolved) unresolved.add(path)
	}
	return {
		inputSchema: materialized,
		unresolvedSchemaPaths: [...unresolved].filter(Boolean).sort(),
	}
}

type NormalizedSchemaResult =
	| { ok: true; schema: JsonObject }
	| { ok: false; reason: string; detail?: string }

function normalizedBoundedSchema(value: unknown): NormalizedSchemaResult {
	const source = cloneJsonObject(value)
	if (!source) {
		return { ok: false, reason: "the returned schema is not valid JSON" }
	}
	let lastLength = 0
	for (const includeDocumentation of [true, false]) {
		try {
			const schema = sanitizeSchemaNode(source, "", new Set(), {
				includeDocumentation,
			})
			lastLength = JSON.stringify(schema).length
			if (lastLength <= MAX_WRAPPER_SCHEMA_CHARS) return { ok: true, schema }
		} catch (error) {
			return {
				ok: false,
				reason: "the returned schema cannot be validated safely",
				detail: error instanceof Error ? error.message : String(error),
			}
		}
	}
	return {
		ok: false,
		reason: `the compact validation schema is ${lastLength} characters, above the ${MAX_WRAPPER_SCHEMA_CHARS}-character per-method bound`,
	}
}

function hydrationFailureKey(toolName: string, fieldPath?: string): string {
	return JSON.stringify(
		fieldPath === undefined
			? ["info", toolName]
			: ["schema", toolName, fieldPath],
	)
}

function hydrationFailureFor(
	contract: CommandWrapperContract,
	toolName: string,
	fieldPath?: string,
): CommandWrapperHydrationFailure | undefined {
	return contract.failures?.[hydrationFailureKey(toolName, fieldPath)]
}

function withHydrationFailure(args: {
	contract: CommandWrapperContract
	toolName: string
	fieldPath?: string
	reason: string
	detail?: string
	now?: number
}): {
	contract: CommandWrapperContract
	changed: boolean
	failure: CommandWrapperHydrationFailure
} {
	const failure: CommandWrapperHydrationFailure = {
		toolName: args.toolName.slice(0, 160),
		fieldPath: args.fieldPath?.slice(0, 240),
		reason: args.reason.replace(/\s+/g, " ").trim().slice(0, 500),
		detail: args.detail?.replace(/\s+/g, " ").trim().slice(0, 1_000),
		observedAt: args.now ?? Date.now(),
	}
	const key = hydrationFailureKey(failure.toolName, failure.fieldPath)
	const contract = boundedCommandWrapperContract({
		...args.contract,
		failures: { ...args.contract.failures, [key]: failure },
	})
	return {
		contract,
		changed: JSON.stringify(contract) !== JSON.stringify(args.contract),
		failure,
	}
}

function withoutHydrationFailures(
	contract: CommandWrapperContract,
	toolName: string,
	fieldPath?: string,
): CommandWrapperContract {
	const failures = Object.fromEntries(
		Object.entries(contract.failures ?? {}).filter(([, failure]) => {
			if (failure.toolName !== toolName) return true
			return fieldPath
				? failure.fieldPath !== fieldPath
				: failure.fieldPath !== undefined
		}),
	)
	return { ...contract, failures }
}

function parsedAnnotations(
	value: unknown,
): CommandWrapperToolAnnotations | undefined {
	const annotations = objectRecord(value)
	if (!annotations) return undefined
	const result: CommandWrapperToolAnnotations = {}
	for (const field of [
		"readOnlyHint",
		"destructiveHint",
		"idempotentHint",
		"openWorldHint",
	] as const) {
		if (typeof annotations[field] === "boolean")
			result[field] = annotations[field]
	}
	return Object.keys(result).length > 0 ? result : undefined
}

export function captureCommandWrapperResult(args: {
	contract: CommandWrapperContract
	command: string
	result: unknown
}): {
	contract: CommandWrapperContract
	changed: boolean
	failure?: CommandWrapperHydrationFailure
} {
	const parsed = parseCommandWrapperCommand(args.contract, args.command)
	const result = structuredObject(args.result)
	if (parsed.kind === "info") {
		if (!result) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				reason:
					"the successful inspection response did not contain a structured input schema",
			})
		}
		if (result.name !== parsed.toolName) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				reason: "the inspection response named a different nested method",
				detail:
					typeof result.name === "string"
						? `returned name ${JSON.stringify(result.name)}`
						: "returned name is missing",
			})
		}
		const normalized = normalizedBoundedSchema(result.inputSchema)
		if (!normalized.ok) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				reason: normalized.reason,
				detail: normalized.detail,
			})
		}
		const existing = args.contract.tools[parsed.toolName]
		if (
			!existing &&
			Object.keys(args.contract.tools).length >= MAX_WRAPPER_TOOLS
		) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				reason: `the wrapper already contains the ${MAX_WRAPPER_TOOLS}-method safety maximum`,
			})
		}
		const nextTool: CommandWrapperToolContract = {
			name: parsed.toolName,
			description:
				typeof result.description === "string"
					? result.description.replace(/\s+/g, " ").trim().slice(0, 4_000)
					: existing?.description,
			inputSchema: normalized.schema,
			annotations:
				parsedAnnotations(result.annotations) ?? existing?.annotations,
			fieldSchemas: existing?.fieldSchemas ?? {},
			unresolvedSchemaPaths: [],
		}
		nextTool.unresolvedSchemaPaths =
			materializeCommandWrapperToolSchema(nextTool).unresolvedSchemaPaths
		if (JSON.stringify(nextTool).length > MAX_WRAPPER_TOOL_CHARS) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				reason: `the independently compacted method contract exceeds the ${MAX_WRAPPER_TOOL_CHARS}-character storage bound`,
			})
		}
		const cleared = withoutHydrationFailures(args.contract, parsed.toolName)
		const next = boundedCommandWrapperContract({
			...cleared,
			tools: { ...cleared.tools, [parsed.toolName]: nextTool },
		})
		return {
			contract: next,
			changed: JSON.stringify(next) !== JSON.stringify(args.contract),
		}
	}
	if (parsed.kind === "schema" && parsed.fieldPath) {
		if (!result) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				fieldPath: parsed.fieldPath,
				reason:
					"the successful field inspection response did not contain a structured schema",
			})
		}
		const existing = args.contract.tools[parsed.toolName]
		if (!existing) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				fieldPath: parsed.fieldPath,
				reason:
					"the parent nested method is not registered; inspect the method before inspecting a field",
			})
		}
		const normalized = normalizedBoundedSchema(result.schema)
		if (!normalized.ok) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				fieldPath: parsed.fieldPath,
				reason: normalized.reason,
				detail: normalized.detail,
			})
		}
		if (
			!(parsed.fieldPath in existing.fieldSchemas) &&
			Object.keys(existing.fieldSchemas).length >= MAX_WRAPPER_FIELDS_PER_TOOL
		) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				fieldPath: parsed.fieldPath,
				reason: `the method already contains the ${MAX_WRAPPER_FIELDS_PER_TOOL}-field-schema safety maximum`,
			})
		}
		const returnedField =
			typeof result.field === "string" ? result.field : undefined
		if (returnedField && returnedField !== parsed.fieldPath) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				fieldPath: parsed.fieldPath,
				reason: "the field inspection response named a different field",
				detail: `returned field ${JSON.stringify(returnedField)}`,
			})
		}
		const nextTool = {
			...existing,
			fieldSchemas: {
				...existing.fieldSchemas,
				[parsed.fieldPath]: normalized.schema,
			},
		}
		nextTool.unresolvedSchemaPaths =
			materializeCommandWrapperToolSchema(nextTool).unresolvedSchemaPaths
		if (JSON.stringify(nextTool).length > MAX_WRAPPER_TOOL_CHARS) {
			return withHydrationFailure({
				contract: args.contract,
				toolName: parsed.toolName,
				fieldPath: parsed.fieldPath,
				reason: `the independently compacted method contract exceeds the ${MAX_WRAPPER_TOOL_CHARS}-character storage bound`,
			})
		}
		const cleared = withoutHydrationFailures(
			args.contract,
			parsed.toolName,
			parsed.fieldPath,
		)
		const next = boundedCommandWrapperContract({
			...cleared,
			tools: { ...cleared.tools, [parsed.toolName]: nextTool },
		})
		return {
			contract: next,
			changed: JSON.stringify(next) !== JSON.stringify(args.contract),
		}
	}
	return { contract: args.contract, changed: false }
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(36).slice(0, 6)
}

export function commandWrapperVirtualMethodName(
	parentMethod: string,
	toolName: string,
): string {
	const safe = toolName.replace(/[^a-zA-Z0-9_$]/g, "_").slice(0, 80) || "tool"
	return `${parentMethod}__${safe}_${stableHash(toolName)}`
}

export function commandWrapperVirtualMethods(
	parentMethod: string,
	contract: CommandWrapperContract | undefined,
): CommandWrapperVirtualMethod[] {
	if (!contract) return []
	return Object.values(contract.tools)
		.map((tool) => ({
			methodName: commandWrapperVirtualMethodName(parentMethod, tool.name),
			tool,
			inputSchema: materializeCommandWrapperToolSchema(tool).inputSchema,
		}))
		.sort((left, right) => left.methodName.localeCompare(right.methodName))
}

export function commandWrapperLogicalInvocation(args: {
	parentMethod: string
	invokedMethod: string
	input?: unknown
	contract: CommandWrapperContract | undefined
}): { toolName: string; input: unknown } | undefined {
	if (!args.contract) return undefined
	if (
		args.invokedMethod === args.parentMethod &&
		args.input &&
		typeof args.input === "object" &&
		!Array.isArray(args.input)
	) {
		const command = (args.input as JsonObject)[args.contract.commandField]
		if (typeof command === "string") {
			try {
				const decoded = decodeCommandWrapperCall(args.contract, command)
				return decoded
					? { toolName: decoded.tool.name, input: decoded.input }
					: undefined
			} catch {
				return undefined
			}
		}
	}
	const virtual = commandWrapperVirtualMethods(
		args.parentMethod,
		args.contract,
	).find((candidate) => candidate.methodName === args.invokedMethod)
	return virtual
		? { toolName: virtual.tool.name, input: args.input }
		: undefined
}

export function commandWrapperCommandViolation(args: {
	contract: CommandWrapperContract
	command: string
	path: string
}): string | undefined {
	const parsed = parseCommandWrapperCommand(args.contract, args.command)
	if (parsed.kind === "info") {
		const failure = hydrationFailureFor(args.contract, parsed.toolName)
		if (failure) {
			return `${args.path}.${args.contract.commandField} cannot re-inspect ${parsed.toolName}: ${failure.reason}. Do not repeat this inspection until the app catalog is refreshed.`
		}
	}
	if (parsed.kind === "schema" && parsed.fieldPath) {
		const failure = hydrationFailureFor(
			args.contract,
			parsed.toolName,
			parsed.fieldPath,
		)
		if (failure) {
			return `${args.path}.${args.contract.commandField} cannot re-inspect ${parsed.toolName}.${parsed.fieldPath}: ${failure.reason}. Do not repeat this inspection until the app catalog is refreshed.`
		}
	}
	if (parsed.kind === "malformed") {
		return `${args.path}.${args.contract.commandField} has malformed ${parsed.leadingToken} syntax; use the exact discovered command grammar.`
	}
	if (parsed.kind === "schema" && !args.contract.tools[parsed.toolName]) {
		return `${args.path} must inspect ${parsed.toolName} with ${args.contract.commands.info} --json before requesting field schemas.`
	}
	if (parsed.kind === "call") {
		try {
			decodeCommandWrapperCall(args.contract, args.command)
		} catch (error) {
			return `${args.path}.${args.contract.commandField} is not a valid nested call: ${error instanceof Error ? error.message : String(error)}`
		}
	}
	return undefined
}

/**
 * Decode a documented raw nested call only after the inner tool contract is
 * known. The same schema validator is used by raw and structured entry points.
 */
export function decodeCommandWrapperCall(
	contract: CommandWrapperContract,
	command: string,
): DecodedCommandWrapperCall | undefined {
	const parsed = parseCommandWrapperCommand(contract, command)
	if (parsed.kind !== "call") return undefined
	const tool = contract.tools[parsed.toolName]
	if (!tool) {
		const failure = hydrationFailureFor(contract, parsed.toolName)
		if (failure) {
			throw new Error(
				`Nested tool ${parsed.toolName} is unavailable because schema hydration failed: ${failure.reason}. Do not repeat the inspection until the app catalog is refreshed.`,
			)
		}
		throw new Error(
			`Unknown nested tool ${parsed.toolName}; run ${contract.commands.info}${contract.infoJsonFlag ? ` ${contract.infoJsonFlag}` : ""} ${parsed.toolName} first.`,
		)
	}
	let input: unknown
	try {
		input = JSON.parse(parsed.jsonInput)
	} catch {
		throw new Error(
			`Nested tool ${parsed.toolName} requires valid JSON input after the tool name.`,
		)
	}
	validateCommandWrapperToolInput(tool, input)
	return { tool, input }
}

export function prepareCommandWrapperOuterInput(args: {
	contract: CommandWrapperContract
	input: unknown
	parentMethod: string
}): JsonObject {
	const input = objectRecord(args.input)
	if (!input) throw new Error("MCP command wrapper input must be an object.")
	const command = input[args.contract.commandField]
	if (typeof command !== "string") {
		throw new Error(
			`MCP command wrapper requires string field ${args.contract.commandField}.`,
		)
	}
	const violation = commandWrapperCommandViolation({
		contract: args.contract,
		command,
		path: args.parentMethod,
	})
	if (violation) throw new Error(`MCP_COMMAND_WRAPPER_REJECTED: ${violation}`)
	const parsed = parseCommandWrapperCommand(args.contract, command)
	if (
		parsed.kind === "other" &&
		!args.contract.leadingTokens.includes(parsed.leadingToken)
	) {
		throw new Error(
			`MCP_COMMAND_WRAPPER_REJECTED: Unsupported leading command ${JSON.stringify(parsed.leadingToken)}.`,
		)
	}
	if (parsed.kind !== "info" || !args.contract.infoJsonFlag) return { ...input }
	return {
		...input,
		[args.contract.commandField]:
			`${args.contract.commands.info} ${args.contract.infoJsonFlag} ${parsed.toolName}`,
	}
}

function auxiliaryValue(
	field: CommandWrapperContract["requiredAuxiliaryFields"][number],
	context: string,
): unknown {
	if (field.defaultValue !== undefined) return field.defaultValue
	if (field.type === "string") return context
	if (field.type === "object" || field.type === undefined)
		return { reason: context }
	throw new Error(
		`Nested MCP wrapper field ${field.name} cannot be synthesized safely (type ${field.type}).`,
	)
}

export function encodeCommandWrapperCall(args: {
	contract: CommandWrapperContract
	toolName: string
	input: unknown
	context: string
	confirm: boolean
}): JsonObject {
	const flags = [
		args.contract.callJsonFlag,
		args.confirm ? args.contract.callConfirmFlag : undefined,
	].filter((value): value is string => Boolean(value))
	const command = [
		args.contract.commands.call,
		...flags,
		args.toolName,
		JSON.stringify(args.input),
	].join(" ")
	return {
		[args.contract.commandField]: command,
		...Object.fromEntries(
			args.contract.requiredAuxiliaryFields.map((field) => [
				field.name,
				auxiliaryValue(field, args.context),
			]),
		),
	}
}

function pathValue(value: unknown, path: string): unknown {
	let current = value
	for (const segment of path.replace(/\[\]/g, "").split(".")) {
		const record = objectRecord(current)
		if (!record || !(segment in record)) return undefined
		current = record[segment]
	}
	return current
}

export function validateCommandWrapperToolInput(
	tool: CommandWrapperToolContract,
	input: unknown,
): void {
	const materialized = materializeCommandWrapperToolSchema(tool)
	for (const fieldPath of materialized.unresolvedSchemaPaths) {
		if (pathValue(input, fieldPath) !== undefined) {
			throw new Error(
				`MCP_NESTED_SCHEMA_REQUIRED: Inspect schema ${tool.name} ${fieldPath} before populating that field.`,
			)
		}
	}
	try {
		const validate = new CfWorkerJsonSchemaValidator({
			shortcircuit: false,
		}).getValidator(materialized.inputSchema)
		const result = validate(input)
		if (!result.valid) {
			throw new Error(
				`MCP_NESTED_INVALID_ARGUMENTS: ${tool.name}: ${result.errorMessage ?? "input does not match the discovered schema"}`,
			)
		}
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.startsWith("MCP_NESTED_") ||
				error.message.startsWith("MCP command"))
		) {
			throw error
		}
		throw new Error(
			`MCP_NESTED_SCHEMA_INVALID: ${tool.name} returned an unusable input schema. Inspect the exact field schema before calling it.`,
		)
	}
}

export function mergeCommandWrapperContracts(
	base: CommandWrapperContract | undefined,
	remembered: CommandWrapperContract | undefined,
): CommandWrapperContract | undefined {
	if (!base)
		return remembered ? boundedCommandWrapperContract(remembered) : undefined
	if (!remembered) return boundedCommandWrapperContract(base)
	if (
		base.commandField !== remembered.commandField ||
		JSON.stringify(base.commands) !== JSON.stringify(remembered.commands)
	) {
		return boundedCommandWrapperContract(base)
	}
	return boundedCommandWrapperContract({
		...base,
		leadingTokens: [
			...new Set([...base.leadingTokens, ...remembered.leadingTokens]),
		],
		tools: { ...base.tools, ...remembered.tools },
		failures: { ...base.failures, ...remembered.failures },
	})
}

export function boundedCommandWrapperContract(
	contract: CommandWrapperContract,
): CommandWrapperContract {
	const failures: Record<string, CommandWrapperHydrationFailure> = {}
	for (const failure of Object.values(contract.failures ?? {}).slice(
		-MAX_WRAPPER_TOOLS,
	)) {
		const toolName = failure.toolName.slice(0, 160)
		const fieldPath = failure.fieldPath?.slice(0, 240)
		failures[hydrationFailureKey(toolName, fieldPath)] = {
			toolName,
			fieldPath,
			reason: failure.reason.replace(/\s+/g, " ").trim().slice(0, 500),
			detail: failure.detail?.replace(/\s+/g, " ").trim().slice(0, 1_000),
			observedAt: Number.isFinite(failure.observedAt) ? failure.observedAt : 0,
		}
	}
	const bounded: CommandWrapperContract = {
		commandField: contract.commandField.slice(0, 120),
		commands: {
			info: contract.commands.info.slice(0, 80),
			schema: contract.commands.schema.slice(0, 80),
			call: contract.commands.call.slice(0, 80),
		},
		infoJsonFlag: contract.infoJsonFlag?.slice(0, 40),
		callJsonFlag: contract.callJsonFlag?.slice(0, 40),
		callConfirmFlag: contract.callConfirmFlag?.slice(0, 40),
		leadingTokens: contract.leadingTokens
			.map((value) => value.slice(0, 80))
			.slice(0, 32),
		requiredAuxiliaryFields: contract.requiredAuxiliaryFields
			.map((field) => ({
				name: field.name.slice(0, 120),
				type: field.type?.slice(0, 40),
				defaultValue: field.defaultValue,
			}))
			.slice(0, 16),
		tools: {},
		failures,
	}
	for (const [index, tool] of Object.values(contract.tools).entries()) {
		if (index >= MAX_WRAPPER_TOOLS) {
			const failure: CommandWrapperHydrationFailure = {
				toolName: tool.name.slice(0, 160),
				reason: `the wrapper exceeds the ${MAX_WRAPPER_TOOLS}-method safety maximum`,
				observedAt: 0,
			}
			bounded.failures = {
				...bounded.failures,
				[hydrationFailureKey(failure.toolName)]: failure,
			}
			continue
		}
		const input = normalizedBoundedSchema(tool.inputSchema)
		if (!input.ok) {
			const failure: CommandWrapperHydrationFailure = {
				toolName: tool.name.slice(0, 160),
				reason: input.reason,
				detail: input.detail,
				observedAt: 0,
			}
			bounded.failures = {
				...bounded.failures,
				[hydrationFailureKey(failure.toolName)]: failure,
			}
			continue
		}
		const fieldSchemas: Record<string, JsonObject> = {}
		for (const [fieldIndex, [path, schema]] of Object.entries(
			tool.fieldSchemas,
		).entries()) {
			if (fieldIndex >= MAX_WRAPPER_FIELDS_PER_TOOL) {
				const failure: CommandWrapperHydrationFailure = {
					toolName: tool.name.slice(0, 160),
					fieldPath: path.slice(0, 240),
					reason: `the method exceeds the ${MAX_WRAPPER_FIELDS_PER_TOOL}-field-schema safety maximum`,
					observedAt: 0,
				}
				bounded.failures = {
					...bounded.failures,
					[hydrationFailureKey(failure.toolName, failure.fieldPath)]: failure,
				}
				continue
			}
			const field = normalizedBoundedSchema(schema)
			if (field.ok) fieldSchemas[path.slice(0, 240)] = field.schema
			else {
				const failure: CommandWrapperHydrationFailure = {
					toolName: tool.name.slice(0, 160),
					fieldPath: path.slice(0, 240),
					reason: field.reason,
					detail: field.detail,
					observedAt: 0,
				}
				bounded.failures = {
					...bounded.failures,
					[hydrationFailureKey(failure.toolName, failure.fieldPath)]: failure,
				}
			}
		}
		const candidate: CommandWrapperToolContract = {
			name: tool.name.slice(0, 160),
			description: tool.description?.slice(0, 4_000),
			inputSchema: input.schema,
			annotations: tool.annotations,
			fieldSchemas,
			unresolvedSchemaPaths: tool.unresolvedSchemaPaths
				.map((path) => path.slice(0, 240))
				.slice(0, 32),
		}
		if (JSON.stringify(candidate).length > MAX_WRAPPER_TOOL_CHARS) {
			const failure: CommandWrapperHydrationFailure = {
				toolName: candidate.name,
				reason: `the independently compacted method contract exceeds the ${MAX_WRAPPER_TOOL_CHARS}-character storage bound`,
				observedAt: 0,
			}
			bounded.failures = {
				...bounded.failures,
				[hydrationFailureKey(failure.toolName)]: failure,
			}
			continue
		}
		bounded.tools[candidate.name] = candidate
		delete bounded.failures?.[hydrationFailureKey(candidate.name)]
		for (const fieldPath of Object.keys(fieldSchemas)) {
			delete bounded.failures?.[hydrationFailureKey(candidate.name, fieldPath)]
		}
	}
	return bounded
}
