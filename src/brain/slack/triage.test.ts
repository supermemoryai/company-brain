import { describe, expect, it, vi } from "vitest"

vi.mock("../billing/cost", () => ({
	BrainCostLedger: class {},
	responseBodyFromResult: vi.fn(),
	scheduleChargeBrainLlmCost: vi.fn(),
}))

vi.mock("../tools/mcp/access-intent", () => ({
	requesterLacksPersonalAppAccess: vi.fn(),
}))

vi.mock("../turn/model-profile", () => ({
	BRAIN_TRIAGE_EFFORT: "low",
	TRIAGE_MODEL: "claude-haiku-4.5",
	createModelProfile: vi.fn(),
}))

import { parseTriageResult } from "./triage"

describe("parseTriageResult", () => {
	it("accepts ANSWER output without an optional audit reason", () => {
		expect(
			parseTriageResult(`ANSWER
Priority: normal`),
		).toEqual({
			decision: "answer",
			source: "model",
			priority: "normal",
		})
	})

	it.each([
		"Reason",
		"reason",
		"ReAsOn",
	])("accepts ANSWER output with a %s audit reason", (reasonField) => {
		expect(
			parseTriageResult(`ANSWER
Priority: normal
${reasonField}: The user asked a direct question.`),
		).toEqual({
			decision: "answer",
			source: "model",
			priority: "normal",
		})
	})

	it("accepts ANSWER output with both fallback and an audit reason", () => {
		expect(
			parseTriageResult(`ANSWER
Priority: low
Fallback: ack tada
Reason: A reaction would be sufficient if no fuller reply is needed.`),
		).toEqual({
			decision: "answer",
			source: "model",
			priority: "low",
			fallbackEmoji: "tada",
		})
	})

	it("parses the main-agent effort", () => {
		expect(
			parseTriageResult(`ANSWER
Priority: normal
AgentMainEffort: high`),
		).toEqual({
			decision: "answer",
			source: "model",
			priority: "normal",
			agentMainEffort: "high",
		})
	})

	it.each([
		`ANSWER
Priority: normal
Reason:`,
		`ANSWER
Priority: normal
Reason: First rationale.
rEaSoN: Second rationale.`,
		`ANSWER
Priority: normal
Unexpected: value`,
	])("keeps malformed ANSWER output on the safe fallback path", (output) => {
		expect(parseTriageResult(output, "channel")).toMatchObject({
			decision: "pass",
			source: "parse_fallback",
		})
	})
})
