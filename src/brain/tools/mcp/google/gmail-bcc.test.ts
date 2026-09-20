import { describe, expect, it } from "vitest"
import { GMAIL_TOOLS, gmailValidation } from "./gmail"

describe("embedded Gmail hidden recipients", () => {
	it("does not advertise or accept Bcc recipients", () => {
		const sendEmail = GMAIL_TOOLS.find((tool) => tool.name === "send_email")
		const properties = sendEmail?.inputSchema.properties

		expect(properties).not.toHaveProperty("bcc")
		expect(() =>
			gmailValidation.buildRawEmail({
				to: ["owner@example.com"],
				bcc: ["hidden@example.com"],
				subject: "Status",
				text: "hello",
			}),
		).toThrow("unsupported email argument: bcc")
	})
})
