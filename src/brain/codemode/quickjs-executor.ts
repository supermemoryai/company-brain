import {
	type ExecuteResult,
	type Executor,
	normalizeCode,
	type ResolvedProvider,
	sanitizeToolName,
} from "@cloudflare/codemode"
import {
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSWASMModule,
	shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core"

type ExecuteOptions = Parameters<Executor["execute"]>[2]
type HostFn = (...args: unknown[]) => Promise<unknown>

const DEFAULT_TIMEOUT_MS = 60_000
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
const MAX_STACK_BYTES = 1024 * 1024

// codemode connectors signal a pause (awaiting approval) or a hard error with
// this key on their result; the sandbox turns them into these throws.
const CONNECTOR_CONTROL_KEY = "__codemode_control__"
const PAUSE_SENTINEL = "__CODEMODE_PAUSE__"

const RESERVED = new Set([
	"console",
	"Promise",
	"Error",
	"JSON",
	"__call",
	"__connector",
	"__host_call",
	"__host_connector",
	"__host_log",
	"__host_done",
])
const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** A connector result may be an RPC stub; copy it out and release the stub. */
function detach(value: unknown): unknown {
	if (!value || typeof value !== "object") return value
	try {
		return JSON.parse(JSON.stringify(value))
	} finally {
		const dispose = (value as { [Symbol.dispose]?: () => void })[
			Symbol.dispose
		]
		if (typeof dispose === "function") {
			try {
				dispose.call(value)
			} catch {}
		}
	}
}

function namespaceProxy(name: string, call: string): string {
	return `const ${name} = new Proxy({}, {
	get: (target, tool) => {
		if (Object.prototype.hasOwnProperty.call(target, tool)) return target[tool]
		if (typeof tool !== "string") return undefined
		return (...args) => ${call}(${JSON.stringify(name)}, tool, args)
	}
});`
}

/**
 * Runs LLM-written Code Mode programs in QuickJS, compiled to WASM and running
 * inside this Worker. It stands in for codemode's DynamicWorkerExecutor, which
 * needs Dynamic Workers and so the Workers Paid plan.
 *
 * The sandbox has no fetch, timers or bindings: the only way out is the tool
 * namespaces and connectors it's handed, and every value crosses as JSON.
 * Synchronous code is bounded by an interrupt deadline, and the whole run,
 * awaited tool calls included, by the timeout.
 */
export class QuickJSExecutor implements Executor {
	#loadModule: () => Promise<QuickJSWASMModule>
	#timeoutMs: number

	constructor(options: {
		loadModule: () => Promise<QuickJSWASMModule>
		timeoutMs?: number
	}) {
		this.#loadModule = options.loadModule
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	async execute(
		code: string,
		providersOrFns: ResolvedProvider[] | Record<string, HostFn>,
		options?: ExecuteOptions,
	): Promise<ExecuteResult> {
		const providers: ResolvedProvider[] = Array.isArray(providersOrFns)
			? providersOrFns
			: [{ name: "codemode", fns: providersOrFns }]
		const connectors = options?.connectors ?? []

		const seen = new Set<string>()
		for (const { name } of [...providers, ...connectors]) {
			if (RESERVED.has(name)) {
				return { result: undefined, error: `Name "${name}" is reserved` }
			}
			if (!VALID_IDENT.test(name)) {
				return {
					result: undefined,
					error: `Name "${name}" is not a valid JavaScript identifier`,
				}
			}
			if (seen.has(name)) {
				return { result: undefined, error: `Duplicate name "${name}"` }
			}
			seen.add(name)
		}

		const connectorNames = new Set(connectors.map((c) => c.name))
		const toolFns = new Map<string, Map<string, HostFn>>()
		for (const provider of providers) {
			if (connectorNames.has(provider.name)) continue
			const fns = new Map<string, HostFn>()
			for (const [name, fn] of Object.entries(provider.fns)) {
				const sanitized = sanitizeToolName(name)
				if (fns.has(sanitized)) {
					return {
						result: undefined,
						error: `Two tools in "${provider.name}" both sanitize to "${sanitized}"`,
					}
				}
				fns.set(sanitized, fn)
			}
			toolFns.set(provider.name, fns)
		}
		const connectorBindings = new Map(
			connectors.map((c) => [c.name, c.binding] as const),
		)

		const program = [
			`const __logs = (level) => (...a) => __host_log(level, a.map(String).join(" "));`,
			`const console = { log: __logs(""), info: __logs(""), warn: __logs("[warn] "), error: __logs("[error] ") };`,
			`const __unwrap = (json) => {
	const r = JSON.parse(json);
	if (r.control === "pause") throw new Error(${JSON.stringify(PAUSE_SENTINEL)});
	if (r.control === "error" || r.error !== undefined) throw new Error(String(r.error));
	return r.result;
};`,
			`const __call = async (ns, tool, args) => __unwrap(await __host_call(ns, tool, JSON.stringify(args)));`,
			`const __connector = async (name, tool, args) => __unwrap(await __host_connector(name, tool, JSON.stringify(args[0] === undefined ? null : args[0])));`,
			...providers
				.filter((p) => !connectorNames.has(p.name))
				.map((p) => namespaceProxy(p.name, "__call")),
			...connectors.map((c) => namespaceProxy(c.name, "__connector")),
			...providers
				.filter((p) => !connectorNames.has(p.name) && p.prelude)
				.map((p) => p.prelude as string),
			`(async () => await (${normalizeCode(code)})())().then(
	(value) => __host_done(JSON.stringify({ result: value === undefined ? null : value, undefined: value === undefined })),
	(err) => __host_done(JSON.stringify({ error: err && err.message !== undefined ? err.message : String(err) })),
);`,
		].join("\n")

		const QuickJS = await this.#loadModule()
		const runtime = QuickJS.newRuntime()
		runtime.setMemoryLimit(MEMORY_LIMIT_BYTES)
		runtime.setMaxStackSize(MAX_STACK_BYTES)
		runtime.setInterruptHandler(
			shouldInterruptAfterDeadline(Date.now() + this.#timeoutMs),
		)
		const ctx = runtime.newContext()
		const logs: string[] = []
		let alive = true
		let finish: (json: string) => void = () => {}
		const done = new Promise<string>((resolve) => {
			finish = resolve
		})

		const drain = () => {
			if (!alive) return
			const jobs = runtime.executePendingJobs()
			if (jobs.error) {
				const message = ctx.dump(jobs.error)
				jobs.error.dispose()
				finish(JSON.stringify({ error: errorMessage(message?.message ?? message) }))
			}
		}

		// Tool calls return a sandbox promise that settles with a JSON envelope.
		// Unsettled ones are released at teardown so the runtime frees cleanly.
		const pending = new Set<ReturnType<QuickJSContext["newPromise"]>>()
		const bridge = (run: () => Promise<Record<string, unknown>>) => {
			const deferred = ctx.newPromise()
			pending.add(deferred)
			run()
				.catch((error) => ({ error: errorMessage(error) }))
				.then((envelope) => {
					if (!alive) return
					pending.delete(deferred)
					const value = ctx.newString(JSON.stringify(envelope))
					deferred.resolve(value)
					value.dispose()
				})
			deferred.settled.then(drain)
			return deferred.handle
		}

		const define = (
			name: string,
			fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined,
		) => {
			const handle = ctx.newFunction(name, fn)
			ctx.setProp(ctx.global, name, handle)
			handle.dispose()
		}

		define("__host_log", (level, text) => {
			logs.push(`${ctx.getString(level)}${ctx.getString(text)}`)
			return undefined
		})
		define("__host_done", (json) => {
			finish(ctx.getString(json))
			return undefined
		})
		define("__host_call", (nsHandle, toolHandle, argsHandle) => {
			const ns = ctx.getString(nsHandle)
			const tool = ctx.getString(toolHandle)
			const argsJson = ctx.getString(argsHandle)
			return bridge(async () => {
				const fn = toolFns.get(ns)?.get(tool)
				if (!fn) return { error: `Tool "${tool}" not found` }
				const args = JSON.parse(argsJson) as unknown
				return {
					result: await fn(...(Array.isArray(args) ? args : [args])),
				}
			})
		})
		define("__host_connector", (nameHandle, toolHandle, argHandle) => {
			const name = ctx.getString(nameHandle)
			const tool = ctx.getString(toolHandle)
			const argJson = ctx.getString(argHandle)
			return bridge(async () => {
				const binding = connectorBindings.get(name) as
					| { callTool(method: string, args: unknown): Promise<unknown> }
					| undefined
				if (!binding) return { error: `Connector "${name}" not found` }
				const result = detach(
					await binding.callTool(tool, JSON.parse(argJson)),
				) as Record<string, unknown> | null
				const control = result?.[CONNECTOR_CONTROL_KEY]
				if (control === "pause") return { control: "pause" }
				if (control === "error") {
					return { control: "error", error: String(result?.message) }
				}
				return { result }
			})
		})

		let timer: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<string>((resolve) => {
			timer = setTimeout(
				() => resolve(JSON.stringify({ error: "Execution timed out" })),
				this.#timeoutMs,
			)
		})

		try {
			const evaluated = ctx.evalCode(program, "codemode.js")
			if (evaluated.error) {
				const failure = ctx.dump(evaluated.error)
				evaluated.error.dispose()
				return {
					result: undefined,
					error: errorMessage(failure?.message ?? failure),
					logs,
				}
			}
			evaluated.value.dispose()
			drain()
			const outcome = JSON.parse(await Promise.race([done, timeout])) as {
				result?: unknown
				undefined?: boolean
				error?: string
			}
			if (outcome.error !== undefined) {
				return { result: undefined, error: outcome.error, logs }
			}
			return { result: outcome.undefined ? undefined : outcome.result, logs }
		} catch (error) {
			return { result: undefined, error: errorMessage(error), logs }
		} finally {
			alive = false
			clearTimeout(timer)
			for (const deferred of pending) deferred.dispose()
			try {
				ctx.dispose()
				runtime.dispose()
			} catch (error) {
				console.warn("[codemode] QuickJS teardown:", errorMessage(error))
			}
		}
	}
}
