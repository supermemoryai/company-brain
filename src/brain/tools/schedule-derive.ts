import type { ScheduledTaskPayload, ScheduleWhen } from "./scheduling"

// Day-of-week field pinned to a specific day => weekly, otherwise daily.
export function cronToCadence(cron: string): "daily" | "weekly" {
	const dow = cron.trim().split(/\s+/)[4]
	return dow && dow !== "*" ? "weekly" : "daily"
}

// Derived from timing and destination: inheriting these on replace leaks personal creds into channels.
export function derivedScheduleFields(args: {
	when: ScheduleWhen
	kind: ScheduledTaskPayload["kind"]
	deliverTo: ScheduledTaskPayload["deliverTo"]
}): Pick<
	ScheduledTaskPayload,
	"cadence" | "orgSharedOnly" | "readOnly" | "personalConnectionsOnly"
> {
	const orgScoped = args.kind === "digest" && args.deliverTo !== "dm"
	return {
		cadence:
			args.when.kind === "cron" ? cronToCadence(args.when.cron) : undefined,
		orgSharedOnly: orgScoped,
		// Every digest is read-only; only credential scope follows the destination.
		readOnly: args.kind === "digest" ? true : undefined,
		personalConnectionsOnly: orgScoped ? false : undefined,
	}
}
