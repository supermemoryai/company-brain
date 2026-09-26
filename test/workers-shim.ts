import { mock } from "bun:test"

// `bun test` runs outside workerd, so modules that import the Workers runtime
// get inert stand-ins for its base classes.
mock.module("cloudflare:workers", () => ({
	RpcTarget: class {},
	DurableObject: class {},
	WorkerEntrypoint: class {},
	WorkflowEntrypoint: class {},
	env: {},
}))
