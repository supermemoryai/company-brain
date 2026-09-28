import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { SlackBotIdentity } from "../slack/client"
import {
	buildSystemPrompt,
	buildSystemPromptMessages,
	formatBotIdentityBlock,
} from "./system"

// Golden-file characterization of the Slack system prompt. Regenerate on
// purpose with UPDATE_FIXTURES=1; a diff here means the prompt text changed.
const FIXTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"__fixtures__/system-prompt.slack.txt",
)

type Opts = NonNullable<Parameters<typeof buildSystemPrompt>[0]>

function optionMatrix(): Opts[] {
	const out: Opts[] = []
	for (const toolMode of ["apps", "memory_only"] as const)
		for (const appPolicy of ["compact", "detailed", undefined] as const)
			for (const hasSandbox of [false, true])
				for (const canRequestAccessLease of [false, true])
					for (const connectedAppRouting of ["code", "direct", "none"] as const)
						for (const allowMemoryWriteback of [true, false])
							for (const explicitFinish of [false, true])
								out.push({
									toolMode,
									appPolicy,
									hasSandbox,
									canRequestAccessLease,
									connectedAppRouting,
									allowMemoryWriteback,
									explicitFinish,
								})
	return out
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

const identities: SlackBotIdentity[] = [
	{ slackUserId: "UBOT", productName: "" },
	{
		slackUserId: "UBOT",
		productName: "Acme Brain",
		name: "brain",
		displayName: "Acme <Brain>\n& co",
		handle: "@brain",
	},
	{ slackUserId: "", productName: "" },
]

function render(): string {
	const sections: string[] = []
	sections.push(`### default\n${buildSystemPrompt()}`)
	sections.push(
		`### all-on\n${buildSystemPrompt({
			toolMode: "apps",
			appPolicy: "detailed",
			hasSandbox: true,
			canRequestAccessLease: true,
			connectedAppRouting: "code",
			allowMemoryWriteback: true,
			explicitFinish: true,
		})}`,
	)
	sections.push(
		`### matrix sha256 (${optionMatrix().length} option combinations)\n${optionMatrix()
			.map((o) => `${JSON.stringify(o)} ${sha(buildSystemPrompt(o))}`)
			.join("\n")}`,
	)
	sections.push(
		`### bot identity blocks\n${identities
			.map((i) => JSON.stringify(formatBotIdentityBlock(i)))
			.join("\n")}`,
	)
	sections.push(
		`### system messages\n${JSON.stringify(
			buildSystemPromptMessages("POLICY", identities[1]),
		)}\n${JSON.stringify(buildSystemPromptMessages("POLICY"))}`,
	)
	return `${sections.join("\n\n")}\n`
}

describe("Slack system prompt", () => {
	it("matches the recorded golden output", () => {
		const actual = render()
		if (process.env.UPDATE_FIXTURES) {
			mkdirSync(dirname(FIXTURE), { recursive: true })
			writeFileSync(FIXTURE, actual)
		}
		expect(actual).toBe(readFileSync(FIXTURE, "utf8"))
	})

	it("only adds the identity message when the bot has a Slack user id", () => {
		expect(buildSystemPromptMessages("P")).toHaveLength(1)
		expect(buildSystemPromptMessages("P", { slackUserId: "", productName: "" })).toHaveLength(1)
		expect(buildSystemPromptMessages("P", { slackUserId: "U1", productName: "" })).toHaveLength(2)
	})
})
