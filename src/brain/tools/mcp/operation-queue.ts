export type SerialOperationQueue = {
	acquire(): Promise<() => void>
	run<T>(operation: () => Promise<T>): Promise<T>
}

export function createSerialOperationQueue(): SerialOperationQueue {
	let tail: Promise<void> = Promise.resolve()
	const acquire = async (): Promise<() => void> => {
		const previous = tail
		let release!: () => void
		tail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		let released = false
		return () => {
			if (released) return
			released = true
			release()
		}
	}

	return {
		acquire,
		async run<T>(operation: () => Promise<T>): Promise<T> {
			const release = await acquire()
			try {
				return await operation()
			} finally {
				release()
			}
		},
	}
}
