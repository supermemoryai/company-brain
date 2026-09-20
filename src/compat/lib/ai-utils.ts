import { NoObjectGeneratedError, NoOutputGeneratedError } from "ai"
import { jsonrepair } from "jsonrepair"
import type { z } from "zod"

/** Gemini moderation surfaces as a ZodError wrapped in AI_APICallError — walk `cause` to find it. */
export function isGeminiContentBlock(error: unknown): boolean {
	const seen = new Set<unknown>()
	let cur: unknown = error
	while (cur && !seen.has(cur)) {
		seen.add(cur)
		const e = cur as Record<string, unknown>
		const parts: string[] = [typeof cur === "string" ? cur : String(cur)]
		for (const key of ["message", "responseBody", "text"]) {
			const v = e[key]
			if (typeof v === "string") parts.push(v)
		}
		const value = e.value
		if (value !== undefined) {
			try {
				parts.push(typeof value === "string" ? value : JSON.stringify(value))
			} catch {}
		}
		const haystack = parts.join(" ")
		if (
			haystack.includes("PROHIBITED_CONTENT") ||
			haystack.includes("blockReason") ||
			(haystack.includes("candidates") && haystack.includes("expected array"))
		) {
			return true
		}
		cur = e.cause
	}
	return false
}

/**
 * `generateText` + `Output.object` can throw on `result.output` when `finishReason` is
 * missing from gateway/proxy responses even though `result.text` has valid JSON
 * (https://github.com/vercel/ai/issues/11348). Fall back to parsing `text`.
 */
export function getGenerateTextStructuredOutput<S extends z.ZodTypeAny>(
	result: { readonly text: string; readonly output: z.infer<S> },
	schema: S,
): z.infer<S> {
	try {
		return result.output
	} catch (error) {
		if (
			!NoOutputGeneratedError.isInstance(error) &&
			!NoObjectGeneratedError.isInstance(error)
		) {
			throw error
		}
		const raw = result.text.trim()
		if (!raw) {
			throw error
		}
		let value: unknown
		try {
			value = JSON.parse(raw)
		} catch {
			try {
				value = JSON.parse(jsonrepair(raw))
			} catch {
				throw error
			}
		}
		return schema.parse(value)
	}
}

export async function getStreamTextStructuredOutput<S extends z.ZodTypeAny>(
	result: {
		readonly text: PromiseLike<string>
		readonly output: PromiseLike<z.infer<S>>
	},
	schema: S,
): Promise<z.infer<S>> {
	try {
		return await result.output
	} catch (error) {
		if (
			!NoOutputGeneratedError.isInstance(error) &&
			!NoObjectGeneratedError.isInstance(error)
		) {
			throw error
		}
		const raw = (await result.text).trim()
		if (!raw) {
			throw error
		}
		let value: unknown
		try {
			value = JSON.parse(raw)
		} catch {
			try {
				value = JSON.parse(jsonrepair(raw))
			} catch {
				throw error
			}
		}
		return schema.parse(value)
	}
}

export const repairJsonOutput = async ({
	text,
}: {
	text: string
	error: unknown
}): Promise<string | null> => {
	try {
		return jsonrepair(text)
	} catch {
		return null
	}
}
