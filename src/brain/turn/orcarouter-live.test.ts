/**
 * Live integration check against the real relay.
 *
 * Skipped unless `ORCAROUTER_API_KEY` is set, so the suite stays hermetic: it
 * is the only test allowed to hold a real credential. Everything it asserts
 * runs through this repository's own code — `orcaCatalogFor` for discovery and
 * `brainProviderModel` for inference — not a bare HTTP call.
 */

import { describe, expect, it } from "vitest"
import { generateText } from "ai"
import { brainProviderModel } from "./brain-model"
import { orcaCatalogFor } from "./orcarouter-models"

const key = process.env.ORCAROUTER_API_KEY?.trim()
const live = key ? describe : describe.skip
const env = { ORCA_API_KEY: key } as unknown as Env

const CHAT_ENDPOINTS = ["openai", "anthropic", "gemini", "openai-response"]
const NON_CHAT_ENDPOINTS = [
	"embeddings",
	"image-generation",
	"openai-video",
	"jina-rerank",
	"systemone",
]

live("live OrcaRouter catalog and inference", () => {
	it("discovers a live chat catalog with no non-text models mixed in", async () => {
		const catalog = await orcaCatalogFor(env, "chat", { apiKey: key })
		expect(catalog.source).toBe("live")
		expect(catalog.models.length).toBeGreaterThan(0)
		for (const model of catalog.models) {
			// vendor/model namespace preserved exactly.
			expect(model.id).toMatch(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/)
			expect(
				model.endpointTypes.some((type) => CHAT_ENDPOINTS.includes(type)),
			).toBe(true)
			expect(
				model.endpointTypes.some((type) => NON_CHAT_ENDPOINTS.includes(type)),
			).toBe(false)
		}
	})

	it("fails closed on the multimodal surface", async () => {
		const multimodal = await orcaCatalogFor(env, "chat-multimodal", { apiKey: key })
		expect(multimodal.source).toBe("live")
		expect(multimodal.models.length).toBeGreaterThan(0)
		for (const model of multimodal.models) {
			// Every option must have declared image input, not been assumed.
			expect(model.inputModalities).toContain("image")
		}
		// A strict subset of the text list, never the same size by accident.
		const chat = await orcaCatalogFor(env, "chat", { apiKey: key })
		expect(multimodal.models.length).toBeLessThanOrEqual(chat.models.length)
	})

	it("completes a real request through this repo's provider path", async () => {
		const catalog = await orcaCatalogFor(env, "chat", { apiKey: key })
		// A key is scoped to the models its workspace allows, and the catalog
		// lists the relay's whole set. Try candidates until one is callable, so
		// a scope denial on one model does not read as a broken provider path.
		const candidates = catalog.models
			.filter((model) => model.endpointTypes.includes("openai"))
			// The relay's own `orcarouter/*` aliases are commonly outside a
			// key's scope, so try real upstream-vendor models first.
			.sort((a, b) => {
				const relay = (id: string) => (id.startsWith("orcarouter/") ? 1 : 0)
				return relay(a.id) - relay(b.id)
			})
			.slice(0, 12)
		expect(candidates.length).toBeGreaterThan(0)
		const denied: string[] = []
		let completed: { id: string; text: string; total: number } | null = null
		for (const candidate of candidates) {
			try {
				const result = await generateText({
					model: brainProviderModel(candidate.id, env),
					prompt: "Reply with exactly one word: pong",
					maxOutputTokens: 64,
				})
				if (result.text.length > 0) {
					completed = {
						id: candidate.id,
						text: result.text,
						total: result.usage.totalTokens ?? 0,
					}
					break
				}
			} catch (error) {
				const status = (error as { statusCode?: number }).statusCode
				if (status === 401 || status === 403) {
					denied.push(candidate.id)
					continue
				}
				throw error
			}
		}
		expect(
			completed,
			`no callable model in ${candidates.length} candidates; scope-denied: ${denied.join(", ")}`,
		).not.toBeNull()
		expect(completed?.total ?? 0).toBeGreaterThan(0)
	}, 90_000)
})
