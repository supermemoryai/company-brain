import {
	SkillConflictError,
	SkillForbiddenError,
	SkillNotFoundError,
} from "@/lib/brain/skills/store"
import { SkillValidationError } from "@/lib/brain/skills/validation"

export function classifySkillHttpError(error: unknown): {
	message: string
	status: 400 | 403 | 404 | 409
} {
	const message =
		error instanceof Error ? error.message : "failed to save skill"
	const name = error instanceof Error ? error.name : ""
	if (
		error instanceof SkillForbiddenError ||
		name === "SkillForbiddenError" ||
		message.startsWith("forbidden")
	) {
		return { message, status: 403 }
	}
	if (
		error instanceof SkillNotFoundError ||
		name === "SkillNotFoundError" ||
		/\bskill not found\b/i.test(message)
	) {
		return { message, status: 404 }
	}
	if (
		error instanceof SkillConflictError ||
		name === "SkillConflictError" ||
		(error instanceof SkillValidationError && error.code === "name_conflict") ||
		/(?:already exists|newer version exists)/i.test(message)
	) {
		return { message, status: 409 }
	}
	return { message, status: 400 }
}
