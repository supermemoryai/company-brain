// One re-run is safe: completed calls replay from the ledger and writes sit behind approval pauses.
export async function executeWithResetRetry<
	R,
	O extends { status: string; error?: string },
>(args: {
	build: () => R
	run: (runtime: R) => Promise<O>
	isTransient: (error: unknown) => boolean
	onRetry: () => void
}): Promise<{ runtime: R; output: O }> {
	let runtime = args.build()
	for (let attempt = 0; ; attempt++) {
		let output: O
		try {
			output = await args.run(runtime)
		} catch (error) {
			if (attempt > 0 || !args.isTransient(error)) throw error
			args.onRetry()
			runtime = args.build()
			continue
		}
		if (
			attempt === 0 &&
			output.status === "error" &&
			args.isTransient(output.error ?? "")
		) {
			args.onRetry()
			runtime = args.build()
			continue
		}
		return { runtime, output }
	}
}
