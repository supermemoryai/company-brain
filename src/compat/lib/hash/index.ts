import crypto from "node:crypto"

export const generateContentHash = (content: string | ArrayBuffer) => {
	const contentToHash =
		content instanceof ArrayBuffer ? Buffer.from(content) : content
	return crypto.createHash("sha1").update(contentToHash).digest("hex")
}
