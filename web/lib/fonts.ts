import { cn } from "@lib/utils"

// The hosted app loaded these through next/font; here globals.css pulls them
// from Google Fonts and these helpers keep the same call sites.
export function dmSansClassName(additionalClasses?: string) {
	return cn("font-dm-sans", "tracking-[-0.01em]", "leading-[135%]", additionalClasses)
}

export function dmSans125ClassName(additionalClasses?: string) {
	return cn("font-dm-sans", "tracking-[-0.01em]", "leading-[125%]", additionalClasses)
}

export function dmMonoClassName(additionalClasses?: string) {
	return cn("font-dm-mono", "tracking-[-0.01em]", "leading-[135%]", additionalClasses)
}
