import releaseSync from "@jitl/quickjs-wasmfile-release-sync"
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import { describe, expect, it } from "vitest"
import { QuickJSExecutor } from "./quickjs-executor"

const loadModule = () => newQuickJSWASMModuleFromVariant(releaseSync)
const executor = new QuickJSExecutor({ loadModule, timeoutMs: 2_000 })

const people = {
	name: "people",
	fns: {
		list: async () => [
			{ name: "Ada", team: "eng" },
			{ name: "Grace", team: "eng" },
			{ name: "Linus", team: "design" },
		],
		lookup: async (who: unknown) => ({ who, found: true }),
		boom: async () => {
			throw new Error("tool exploded")
		},
	},
}

describe("QuickJSExecutor", () => {
	it("runs code against tool namespaces and returns the result", async () => {
		const out = await executor.execute(
			`async () => {
				const all = await people.list()
				console.log("loaded", all.length)
				return all.filter((p) => p.team === "eng").map((p) => p.name)
			}`,
			[people],
		)
		expect(out.error).toBeUndefined()
		expect(out.result).toEqual(["Ada", "Grace"])
		expect(out.logs).toEqual(["loaded 3"])
	})

	it("passes arguments and runs calls in parallel", async () => {
		const out = await executor.execute(
			`async () => Promise.all([people.lookup("a"), people.lookup({ id: 2 })])`,
			[people],
		)
		expect(out.result).toEqual([
			{ who: "a", found: true },
			{ who: { id: 2 }, found: true },
		])
	})

	it("surfaces tool and code errors as results, never throws", async () => {
		const toolError = await executor.execute(`async () => people.boom()`, [people])
		expect(toolError.error).toBe("tool exploded")
		const missing = await executor.execute(`async () => people.nope()`, [people])
		expect(missing.error).toContain('Tool "nope" not found')
		const syntax = await executor.execute(`async () => {`, [people])
		expect(syntax.error).toBeTruthy()
	})

	it("has no network and no host globals", async () => {
		const out = await executor.execute(
			`async () => [typeof fetch, typeof setTimeout, typeof process]`,
			[people],
		)
		expect(out.result).toEqual(["undefined", "undefined", "undefined"])
	})

	it("interrupts runaway loops and times out hung calls", async () => {
		const loop = await executor.execute(`async () => { while (true) {} }`, [people])
		expect(loop.error).toBeTruthy()
		const hung = await new QuickJSExecutor({ loadModule, timeoutMs: 200 }).execute(
			`async () => people.hang()`,
			[{ name: "people", fns: { hang: () => new Promise(() => {}) } }],
		)
		expect(hung.error).toBe("Execution timed out")
	})

	it("turns connector pause and error signals into throws", async () => {
		const binding = {
			callTool: async (method: string, args: unknown) =>
				method === "approve"
					? { __codemode_control__: "pause" }
					: method === "fail"
						? { __codemode_control__: "error", message: "denied" }
						: { method, args },
		}
		const connectors = [{ name: "github", binding }]
		const ok = await executor.execute(
			`async () => github.list_issues({ repo: "x" })`,
			[],
			{ connectors },
		)
		expect(ok.result).toEqual({ method: "list_issues", args: { repo: "x" } })
		const paused = await executor.execute(`async () => github.approve({})`, [], {
			connectors,
		})
		expect(paused.error).toBe("__CODEMODE_PAUSE__")
		const failed = await executor.execute(`async () => github.fail({})`, [], {
			connectors,
		})
		expect(failed.error).toBe("denied")
	})

	it("runs provider preludes and rejects reserved names", async () => {
		const out = await executor.execute(`async () => people.twice(21)`, [
			{ ...people, prelude: "people.twice = (n) => n * 2;" },
		])
		expect(out.result).toBe(42)
		const reserved = await executor.execute(`async () => 1`, [
			{ name: "console", fns: {} },
		])
		expect(reserved.error).toContain("reserved")
	})
})
