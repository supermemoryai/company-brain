import { parse } from "acorn"
import {
	type CommandWrapperContract,
	commandWrapperCommandViolation,
	detectCommandWrapperContract,
} from "./router-wrapper"

type AstNode = {
	type: string
	[key: string]: unknown
}

export type CodeModePreflightResult = {
	undiscoveredPaths: string[]
	dynamicConnectors: string[]
	calledPaths: string[]
	nativeCallCount: number
	argumentViolations: string[]
}

export type NativeMethodInputContract = {
	requiredFields: string[]
	literalValues: Record<string, string[]>
	leadingTokenValues?: Record<string, string[]>
	jsonTextFields: string[]
	commandWrapper?: CommandWrapperContract
}

type ConnectorMethods =
	| ReadonlySet<string>
	| ReadonlyMap<string, NativeMethodInputContract>

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

export function nativeMethodInputContract(
	inputSchema: unknown,
): NativeMethodInputContract {
	const schema = objectRecord(inputSchema)
	const properties = objectRecord(schema?.properties) ?? {}
	const requiredFields = Array.isArray(schema?.required)
		? schema.required.filter(
				(field): field is string => typeof field === "string",
			)
		: []
	const literalValues: Record<string, string[]> = {}
	const leadingTokenValues: Record<string, string[]> = {}
	const jsonTextFields: string[] = []
	for (const [field, value] of Object.entries(properties)) {
		const property = objectRecord(value)
		if (!property) continue
		const advertised = [
			...(Array.isArray(property.enum)
				? property.enum.filter(
						(item): item is string => typeof item === "string",
					)
				: []),
			...(typeof property.const === "string" ? [property.const] : []),
		]
		const uniqueAdvertised = [...new Set(advertised)].slice(0, 32)
		if (uniqueAdvertised.length > 0) literalValues[field] = uniqueAdvertised
		if (
			property.type === "string" &&
			(property.contentMediaType === "application/json" ||
				property.format === "json" ||
				property.format === "json-string")
		) {
			jsonTextFields.push(field)
		}
	}
	const commandWrapper = detectCommandWrapperContract(inputSchema)
	if (commandWrapper) {
		leadingTokenValues[commandWrapper.commandField] =
			commandWrapper.leadingTokens
	}
	return {
		requiredFields: [...new Set(requiredFields)].sort(),
		literalValues,
		leadingTokenValues,
		jsonTextFields: [...new Set(jsonTextFields)].sort(),
		commandWrapper,
	}
}

export function nativeMethodInputContractSummary(
	contract: NativeMethodInputContract | undefined,
): string | undefined {
	if (!contract) return undefined
	const parts: string[] = []
	if (contract.requiredFields.length > 0) {
		parts.push(`required=${contract.requiredFields.join(",")}`)
	}
	for (const [field, values] of Object.entries(contract.literalValues)) {
		parts.push(`${field}=${values.join("|")}`)
	}
	for (const [field, values] of Object.entries(
		contract.leadingTokenValues ?? {},
	)) {
		parts.push(`${field} starts with ${values.join("|")}`)
	}
	if (contract.jsonTextFields.length > 0) {
		parts.push(`JSON.stringify fields=${contract.jsonTextFields.join(",")}`)
	}
	if (contract.commandWrapper) {
		const virtualTools = Object.values(contract.commandWrapper.tools)
		const failedTools = Object.values(contract.commandWrapper.failures ?? {})
		parts.push(
			`nested wrapper=${contract.commandWrapper.commands.info}/${contract.commandWrapper.commands.schema}/${contract.commandWrapper.commands.call}`,
		)
		if (virtualTools.length > 0) {
			parts.push(
				`learned nested tools=${virtualTools
					.map((tool) =>
						tool.unresolvedSchemaPaths.length > 0
							? `${tool.name}(inspect ${tool.unresolvedSchemaPaths.join(",")})`
							: tool.name,
					)
					.join(",")}`,
			)
		}
		if (failedTools.length > 0) {
			parts.push(
				`unavailable nested schemas=${failedTools
					.map((failure) =>
						failure.fieldPath
							? `${failure.toolName}.${failure.fieldPath}`
							: failure.toolName,
					)
					.join(",")}`,
			)
		}
	}
	return parts.length > 0 ? parts.join("; ") : undefined
}

function astNode(value: unknown): AstNode | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		!("type" in value) ||
		typeof value.type !== "string"
	) {
		return undefined
	}
	return value as AstNode
}

function staticArrayLength(node: AstNode | undefined): number | undefined {
	if (node?.type !== "ArrayExpression" || !Array.isArray(node.elements)) {
		return undefined
	}
	if (
		node.elements.some((element) => astNode(element)?.type === "SpreadElement")
	) {
		return undefined
	}
	return node.elements.length
}

function collectStaticArrayLengths(root: AstNode): Map<string, number> {
	const lengths = new Map<string, number>()
	const seen = new Set<AstNode>()
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item)
			return
		}
		const node = astNode(value)
		if (!node || seen.has(node)) return
		seen.add(node)

		if (
			node.type === "VariableDeclaration" &&
			node.kind === "const" &&
			Array.isArray(node.declarations)
		) {
			for (const value of node.declarations) {
				const declaration = astNode(value)
				const id = astNode(declaration?.id)
				const length = staticArrayLength(astNode(declaration?.init))
				if (
					declaration?.type === "VariableDeclarator" &&
					id?.type === "Identifier" &&
					typeof id.name === "string" &&
					length !== undefined
				) {
					lengths.set(id.name, length)
				}
			}
		}

		for (const [key, child] of Object.entries(node)) {
			if (key === "start" || key === "end" || key === "loc") continue
			visit(child)
		}
	}
	visit(root)
	return lengths
}

function staticForOfIterations(
	node: AstNode | undefined,
	staticArrays: ReadonlyMap<string, number>,
): number | undefined {
	const literalLength = staticArrayLength(node)
	if (literalLength !== undefined) return literalLength
	if (node?.type === "Identifier" && typeof node.name === "string") {
		return staticArrays.get(node.name)
	}
	return undefined
}

function connectorMethodReference(
	node: AstNode,
	connectors: ReadonlyMap<string, ConnectorMethods>,
): { connector: string; method?: string } | undefined {
	if (node.type !== "MemberExpression") return undefined
	const object = astNode(node.object)
	if (object?.type !== "Identifier" || typeof object.name !== "string") {
		return undefined
	}
	if (!connectors.has(object.name)) return undefined

	const property = astNode(node.property)
	if (node.computed === false && property?.type === "Identifier") {
		return typeof property.name === "string"
			? { connector: object.name, method: property.name }
			: { connector: object.name }
	}
	if (
		node.computed === true &&
		property?.type === "Literal" &&
		typeof property.value === "string"
	) {
		return { connector: object.name, method: property.value }
	}
	return { connector: object.name }
}

function connectorHasMethod(
	methods: ConnectorMethods | undefined,
	method: string,
): boolean {
	return Boolean(methods?.has(method))
}

function connectorMethodContract(
	methods: ConnectorMethods | undefined,
	method: string,
): NativeMethodInputContract | undefined {
	return methods instanceof Map ? methods.get(method) : undefined
}

function staticPropertyName(node: AstNode | undefined): string | undefined {
	if (!node) return undefined
	if (node.type === "Identifier" && typeof node.name === "string") {
		return node.name
	}
	if (node.type === "Literal" && typeof node.value === "string") {
		return node.value
	}
	return undefined
}

function staticObjectProperties(
	node: AstNode,
): Map<string, AstNode> | undefined {
	if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
		return undefined
	}
	const properties = new Map<string, AstNode>()
	for (const value of node.properties) {
		const property = astNode(value)
		if (
			!property ||
			property.type !== "Property" ||
			property.computed === true
		) {
			// A spread or computed key can supply required fields dynamically. Skip
			// static validation instead of reporting a false missing-field error.
			return undefined
		}
		const name = staticPropertyName(astNode(property.key))
		const propertyValue = astNode(property.value)
		if (name && propertyValue) properties.set(name, propertyValue)
	}
	return properties
}

function literalString(node: AstNode | undefined): string | undefined {
	return node?.type === "Literal" && typeof node.value === "string"
		? node.value
		: undefined
}

function isJsonStringifyCall(node: AstNode | undefined): boolean {
	if (node?.type !== "CallExpression") return false
	const callee = astNode(node.callee)
	if (callee?.type !== "MemberExpression" || callee.computed === true)
		return false
	const object = astNode(callee.object)
	const property = astNode(callee.property)
	return (
		object?.type === "Identifier" &&
		object.name === "JSON" &&
		property?.type === "Identifier" &&
		property.name === "stringify"
	)
}

function callArgumentViolations(args: {
	call: AstNode
	path: string
	contract: NativeMethodInputContract
}): string[] {
	const callArguments = Array.isArray(args.call.arguments)
		? args.call.arguments
		: []
	const first = astNode(callArguments[0])
	if (!first) {
		return args.contract.requiredFields.length > 0
			? [
					`${args.path} requires an object containing ${args.contract.requiredFields.join(", ")}.`,
				]
			: []
	}
	const properties = staticObjectProperties(first)
	if (!properties) return []
	const violations: string[] = []
	const missing = args.contract.requiredFields.filter(
		(field) => !properties.has(field),
	)
	if (missing.length > 0) {
		violations.push(
			`${args.path} is missing required field(s): ${missing.join(", ")}.`,
		)
	}
	for (const [field, allowed] of Object.entries(args.contract.literalValues)) {
		const value = literalString(properties.get(field))
		if (value !== undefined && !allowed.includes(value)) {
			violations.push(
				`${args.path}.${field}=${JSON.stringify(value)} is unsupported; use one of ${allowed.join(", ")}.`,
			)
		}
	}
	for (const [field, allowed] of Object.entries(
		args.contract.leadingTokenValues ?? {},
	)) {
		const value = literalString(properties.get(field))
		if (value === undefined) continue
		const leadingToken = value.trim().split(/\s+/, 1)[0] ?? ""
		if (!allowed.includes(leadingToken)) {
			violations.push(
				`${args.path}.${field}=${JSON.stringify(value)} must start with one of ${allowed.join(", ")}.`,
			)
		}
	}
	for (const field of args.contract.jsonTextFields) {
		const value = properties.get(field)
		if (!value || isJsonStringifyCall(value)) continue
		const literal = literalString(value)
		if (literal === undefined) continue
		try {
			JSON.parse(literal)
		} catch {
			violations.push(
				`${args.path}.${field} must contain valid JSON text; build an object and pass JSON.stringify(object).`,
			)
		}
	}
	const wrapper = args.contract.commandWrapper
	const command = wrapper
		? literalString(properties.get(wrapper.commandField))
		: undefined
	if (wrapper && command !== undefined) {
		const violation = commandWrapperCommandViolation({
			contract: wrapper,
			command,
			path: args.path,
		})
		if (violation) violations.push(violation)
	}
	return violations
}

/**
 * Reject connector methods that were not returned with schemas by discovery.
 * This runs before the Code Mode runtime, so rejected programs make no native calls.
 */
export function preflightCodeModeProgram(
	code: string,
	connectors: ReadonlyMap<string, ConnectorMethods>,
): CodeModePreflightResult {
	const root = parse(`(${code})`, {
		ecmaVersion: "latest",
	}) as unknown as AstNode
	const undiscoveredPaths = new Set<string>()
	const dynamicConnectors = new Set<string>()
	const calledPaths = new Set<string>()
	const argumentViolations = new Set<string>()
	let nativeCallCount = 0
	const seen = new Set<AstNode>()
	const staticArrays = collectStaticArrayLengths(root)

	const callPath = (reference: { connector: string; method?: string }) =>
		reference.method
			? `${reference.connector}.${reference.method}`
			: `${reference.connector}.[dynamic method]`

	const visit = (value: unknown, multiplier = 1): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item, multiplier)
			return
		}
		const node = astNode(value)
		if (!node || seen.has(node)) return
		seen.add(node)

		if (node.type === "ForOfStatement") {
			visit(node.left, multiplier)
			visit(node.right, multiplier)
			const iterations = staticForOfIterations(
				astNode(node.right),
				staticArrays,
			)
			visit(
				node.body,
				iterations === undefined ? multiplier : multiplier * iterations,
			)
			return
		}

		if (node.type === "CallExpression") {
			const callee = astNode(node.callee)
			const callReference = callee
				? connectorMethodReference(callee, connectors)
				: undefined
			if (callReference) {
				nativeCallCount += multiplier
				const path = callPath(callReference)
				if (callReference.method) {
					calledPaths.add(path)
					const contract = connectorMethodContract(
						connectors.get(callReference.connector),
						callReference.method,
					)
					if (contract) {
						for (const violation of callArgumentViolations({
							call: node,
							path: `${callReference.connector}.${callReference.method}`,
							contract,
						})) {
							argumentViolations.add(violation)
						}
					}
				}
			}
		}

		const reference = connectorMethodReference(node, connectors)
		if (reference) {
			if (!reference.method) {
				dynamicConnectors.add(reference.connector)
			} else if (
				!connectorHasMethod(
					connectors.get(reference.connector),
					reference.method,
				)
			) {
				undiscoveredPaths.add(`${reference.connector}.${reference.method}`)
			}
		}

		for (const [key, child] of Object.entries(node)) {
			if (key === "start" || key === "end" || key === "loc") continue
			visit(child, multiplier)
		}
	}

	visit(root)
	return {
		undiscoveredPaths: [...undiscoveredPaths].sort(),
		dynamicConnectors: [...dynamicConnectors].sort(),
		calledPaths: [...calledPaths].sort(),
		nativeCallCount,
		argumentViolations: [...argumentViolations].sort(),
	}
}
