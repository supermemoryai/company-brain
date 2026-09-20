// Encryption helpers
export async function generateKey(secret: string): Promise<CryptoKey> {
	const encoder = new TextEncoder()
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "PBKDF2" },
		false,
		["deriveBits", "deriveKey"],
	)

	return crypto.subtle.deriveKey(
		{
			hash: "SHA-256",
			iterations: 100000,
			name: "PBKDF2",
			salt: encoder.encode("supermemory-connections").buffer as ArrayBuffer,
		},
		keyMaterial,
		{ length: 256, name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	)
}

export async function encryptToken(
	token: string,
	secret: string,
): Promise<string> {
	const encoder = new TextEncoder()
	const key = await generateKey(secret)
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const encryptedData = await crypto.subtle.encrypt(
		{ iv: iv.buffer, name: "AES-GCM" },
		key,
		encoder.encode(token),
	)

	const encryptedArray = new Uint8Array(encryptedData)
	const combined = new Uint8Array(iv.length + encryptedArray.length)
	combined.set(iv)
	combined.set(encryptedArray, iv.length)

	return btoa(String.fromCharCode(...combined))
}

export async function decryptToken(
	encryptedToken: string,
	secret: string,
): Promise<string> {
	const decoder = new TextDecoder()
	const key = await generateKey(secret)
	const combined = new Uint8Array(
		[...atob(encryptedToken)].map((char) => char.charCodeAt(0)),
	)

	const iv = combined.slice(0, 12)
	const encryptedData = combined.slice(12)

	const decryptedData = await crypto.subtle.decrypt(
		{ iv: iv.buffer, name: "AES-GCM" },
		key,
		encryptedData,
	)

	return decoder.decode(decryptedData)
}

export async function encryptClientSecret(
	clientSecret: string,
	secret: string,
): Promise<string> {
	return `encrypted_${await encryptToken(clientSecret, secret)}`
}

export async function decryptClientSecret(
	encryptedClientSecret: string,
	secret: string,
): Promise<string> {
	if (!encryptedClientSecret.startsWith("encrypted_")) {
		return encryptedClientSecret
	}
	const encryptedValue = encryptedClientSecret.slice("encrypted_".length)
	return decryptToken(encryptedValue, secret)
}
