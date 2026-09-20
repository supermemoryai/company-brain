export type ConditionInput = {
	filterType?: "metadata" | "numeric" | "array_contains" | "string_contains"
	key: string
	negate?: boolean | "true" | "false"
	ignoreCase?: boolean | "true" | "false" | undefined
	numericOperator?: ">" | "<" | ">=" | "<=" | "="
	value: string
}

export type LogicalExpression =
	| ConditionInput
	| { OR: LogicalExpression[] }
	| { AND: LogicalExpression[] }

export type Query = { OR: LogicalExpression[] } | { AND: LogicalExpression[] }
