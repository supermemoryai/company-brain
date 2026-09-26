import { describe, expect, it } from "vitest"
import { sandboxToolsConfigured } from "./availability"

const sandbox = {} as Env["Sandbox"]
const loader = {} as Env["LOADER"]

describe("sandboxToolsConfigured", () => {
	it("stays off on the free plan without Daytona", () => {
		expect(sandboxToolsConfigured({ Sandbox: sandbox } as Env)).toBe(false)
	})
	it("uses Daytona on any plan when its key is set", () => {
		expect(
			sandboxToolsConfigured({ Sandbox: sandbox, DAYTONA_API_KEY: "k" } as Env),
		).toBe(true)
	})
	it("uses the container once the paid block is enabled", () => {
		expect(
			sandboxToolsConfigured({ Sandbox: sandbox, LOADER: loader } as Env),
		).toBe(true)
	})
})
