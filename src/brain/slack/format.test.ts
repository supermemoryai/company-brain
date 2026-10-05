import { describe, expect, it } from "vitest"
import { toSlackMrkdwn } from "./format"

describe("toSlackMrkdwn", () => {
	it("still converts markdown outside code", () => {
		expect(
			toSlackMrkdwn(
				"## Setup\n**Run** the [docs](https://example.com) steps\n---\n| a | b |\n|---|---|\n| 1 | 2 |",
			),
		).toBe("*Setup*\n*Run* the <https://example.com|docs> steps\na  ·  b\n1  ·  2")
	})

	it("leaves fenced code blocks as written", () => {
		const code = [
			"```yaml",
			"---",
			"# deploy settings",
			"name: __app__",
			"```",
			"```bash",
			"cat log | grep error |",
			"```",
		].join("\n")
		expect(toSlackMrkdwn(`Try this:\n${code}\nDone.`)).toBe(
			`Try this:\n${code}\nDone.`,
		)
	})

	it("leaves inline code spans as written", () => {
		expect(toSlackMrkdwn("Override `__init__` and **not** `**kwargs**`")).toBe(
			"Override `__init__` and *not* `**kwargs**`",
		)
	})
})
