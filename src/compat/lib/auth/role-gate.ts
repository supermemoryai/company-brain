import type { MiddlewareHandler } from "hono"
import { type MemberRole, roleAtLeast } from "@repo/lib/permissions"
import type { AppContext } from "@/types"

/** Refuse a request whose actor is below `minimum` in the org. */
export function roleGate(options: {
	minimum: MemberRole
}): MiddlewareHandler<AppContext> {
	return async (c, next) => {
		if (!roleAtLeast(c.get("memberRole"), options.minimum)) {
			return c.json({ error: "insufficient_role" }, 403)
		}
		await next()
	}
}
