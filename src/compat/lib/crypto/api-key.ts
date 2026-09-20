/**
 * Shared encryption utilities for API keys
 * Uses PBKDF2 + AES-GCM encryption with ENCRYPTION_SECRET
 */

export async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
	const encoder = new TextEncoder()
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		"PBKDF2",
		false,
		["deriveKey"],
	)

	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: encoder.encode("supermemory-api-key-salt"),
			iterations: 100000,
			hash: "SHA-256",
		},
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	)
}

export async function encryptApiKey(
	apiKey: string,
	secret: string,
): Promise<string> {
	const key = await deriveEncryptionKey(secret)
	const encoder = new TextEncoder()
	const iv = crypto.getRandomValues(new Uint8Array(12))

	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encoder.encode(apiKey),
	)

	// Combine IV + encrypted data and encode as base64
	const combined = new Uint8Array(iv.length + encrypted.byteLength)
	combined.set(iv)
	combined.set(new Uint8Array(encrypted), iv.length)

	return btoa(String.fromCharCode(...combined))
}

export async function decryptApiKey(
	encryptedKey: string,
	secret: string,
): Promise<string> {
	const key = await deriveEncryptionKey(secret)
	const combined = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0))

	const iv = combined.slice(0, 12)
	const data = combined.slice(12)

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		data,
	)

	return new TextDecoder().decode(decrypted)
}

export async function hashApiKey(key: string): Promise<string> {
	const encoder = new TextEncoder()
	const data = encoder.encode(key)
	const hashBuffer = await crypto.subtle.digest("SHA-256", data)
	const bytes = new Uint8Array(hashBuffer)
	const base64 = btoa(String.fromCharCode(...bytes))
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

/**
 * Length of the random portion of generated API keys.
 * Used by customKeyGenerator in the auth plugin and by manual key creation in routes.
 */
export const API_KEY_RANDOM_LENGTH = 64

export function generateRandomString(length: number): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	const randomValues = new Uint8Array(length)
	crypto.getRandomValues(randomValues)
	return Array.from(randomValues, (v) => chars[v % chars.length]).join("")
}
