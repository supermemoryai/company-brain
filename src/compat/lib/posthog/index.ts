/**
 * Product analytics in the hosted brain. Self-hosted deployments send nothing;
 * these keep the call sites intact.
 */
export function captureAiTrace(..._args: unknown[]): void {}
export function captureAiSpan(..._args: unknown[]): void {}
export function captureAiGeneration(..._args: unknown[]): void {}
export async function captureAiSpanAwaitable(
	..._args: unknown[]
): Promise<void> {}
export async function captureAiGenerationAwaitable(
	..._args: unknown[]
): Promise<void> {}
export function captureBeatSent(..._args: unknown[]): void {}
export function captureBeatSuppressed(..._args: unknown[]): void {}
export function captureJourneyExited(..._args: unknown[]): void {}
export async function flushTelemetry(..._args: unknown[]): Promise<void> {}

export type LeaseRequestOutcome = string

export function captureActivationRung(..._args: unknown[]): void {}
export function captureLeaseRequest(..._args: unknown[]): void {}
export function captureBrainSkillEvent(..._args: unknown[]): void {}
