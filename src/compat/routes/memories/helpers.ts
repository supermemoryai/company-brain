export type BatchItemResult =
	| { id: string; status: string; error?: undefined; url?: undefined }
	| { id: string; status: "error"; error: string; url?: string }
