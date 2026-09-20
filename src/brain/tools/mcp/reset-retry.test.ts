import { describe, expect, it } from "vitest"
import { executeWithResetRetry } from "./reset-retry"

const RESET_MESSAGE =
	"SQL query failed: Durable Object reset because its code was updated."
const STORAGE_RESET_MESSAGE =
	"SQL query failed: Internal error in Durable Object storage caused object to be reset; reference = h8jmnr8v4sodeiipb19tivle"
const OOM_MESSAGE =
	"SQL query failed: Durable Object's isolate exceeded its memory limit and was reset."

// Mirrors the agents SDK predicates; OOM deliberately excluded.
const isTransient = (error: unknown) => {
	const text =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: ""
	return (
		/reset because its code was updated|this script has been upgraded/i.test(
			text,
		) ||
		/Internal error in Durable Object storage caused object to be reset/i.test(
			text,
		)
	)
}

type FakeOutput = { status: string; error?: string; result?: unknown }

function harness(runs: Array<() => Promise<FakeOutput>>) {
	let builds = 0
	let retries = 0
	let call = 0
	return {
		builds: () => builds,
		retries: () => retries,
		execute: () =>
			executeWithResetRetry<{ id: number }, FakeOutput>({
				build: () => ({ id: ++builds }),
				run: () => {
					const next = runs[call]
					call += 1
					if (!next) throw new Error("no scripted run left")
					return next()
				},
				isTransient,
				onRetry: () => {
					retries += 1
				},
			}),
	}
}

describe("executeWithResetRetry", () => {
	it("retries once when the runtime throws a reset error, then succeeds", async () => {
		const h = harness([
			() => Promise.reject(new Error(RESET_MESSAGE)),
			() => Promise.resolve({ status: "completed", result: 42 }),
		])
		const { runtime, output } = await h.execute()
		expect(output).toEqual({ status: "completed", result: 42 })
		expect(h.retries()).toBe(1)
		expect(h.builds()).toBe(2)
		expect(runtime.id).toBe(2)
	})

	it("retries once when the runtime returns a reset error output", async () => {
		const h = harness([
			() => Promise.resolve({ status: "error", error: RESET_MESSAGE }),
			() => Promise.resolve({ status: "completed", result: "ok" }),
		])
		const { output } = await h.execute()
		expect(output.status).toBe("completed")
		expect(h.retries()).toBe(1)
	})

	it("does not retry ordinary program errors", async () => {
		const h = harness([
			() =>
				Promise.resolve({
					status: "error",
					error: "TypeError: x is undefined",
				}),
		])
		const { output } = await h.execute()
		expect(output.status).toBe("error")
		expect(h.retries()).toBe(0)
		expect(h.builds()).toBe(1)
	})

	it("does not retry thrown non-reset errors", async () => {
		const h = harness([() => Promise.reject(new Error("boom"))])
		await expect(h.execute()).rejects.toThrow("boom")
		expect(h.retries()).toBe(0)
	})

	it("gives up after one retry if the reset persists", async () => {
		const h = harness([
			() => Promise.reject(new Error(RESET_MESSAGE)),
			() => Promise.reject(new Error(RESET_MESSAGE)),
		])
		await expect(h.execute()).rejects.toThrow(RESET_MESSAGE)
		expect(h.retries()).toBe(1)
		expect(h.builds()).toBe(2)
	})

	it("surfaces a persistent reset error output after one retry", async () => {
		const h = harness([
			() => Promise.resolve({ status: "error", error: RESET_MESSAGE }),
			() => Promise.resolve({ status: "error", error: RESET_MESSAGE }),
		])
		const { output } = await h.execute()
		expect(output.status).toBe("error")
		expect(h.retries()).toBe(1)
	})

	it("retries a durable object storage reset", async () => {
		const h = harness([
			() => Promise.resolve({ status: "error", error: STORAGE_RESET_MESSAGE }),
			() => Promise.resolve({ status: "completed", result: "ok" }),
		])
		const { output } = await h.execute()
		expect(output.status).toBe("completed")
		expect(h.retries()).toBe(1)
	})

	it("never retries a memory-limit reset — it would re-OOM", async () => {
		const h = harness([
			() => Promise.resolve({ status: "error", error: OOM_MESSAGE }),
		])
		const { output } = await h.execute()
		expect(output.status).toBe("error")
		expect(h.retries()).toBe(0)
		expect(h.builds()).toBe(1)
	})

	it("does not retry a thrown memory-limit reset", async () => {
		const h = harness([() => Promise.reject(new Error(OOM_MESSAGE))])
		await expect(h.execute()).rejects.toThrow("memory limit")
		expect(h.retries()).toBe(0)
	})

	it("passes paused outputs through untouched", async () => {
		const h = harness([() => Promise.resolve({ status: "paused" })])
		const { output } = await h.execute()
		expect(output.status).toBe("paused")
		expect(h.retries()).toBe(0)
	})
})
