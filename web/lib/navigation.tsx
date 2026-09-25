import type { AnchorHTMLAttributes, MouseEvent } from "react"
import { useCallback, useMemo } from "react"
import { Link as WouterLink, useLocation, useSearch } from "wouter"

// Stand-ins for next/navigation and next/link, so ported components keep
// their call sites. Routing is wouter over the History API.

export function usePathname(): string {
	return useLocation()[0]
}

export function useSearchParams(): URLSearchParams {
	const search = useSearch()
	return useMemo(() => new URLSearchParams(search), [search])
}

export function useRouter() {
	const [, navigate] = useLocation()
	return useMemo(
		() => ({
			push: (href: string) => navigate(href),
			replace: (href: string) => navigate(href, { replace: true }),
			back: () => window.history.back(),
			refresh: () => window.location.reload(),
		}),
		[navigate],
	)
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
	href: string
	replace?: boolean
	prefetch?: boolean
	scroll?: boolean
}

export function Link({
	href,
	replace,
	prefetch: _prefetch,
	scroll: _scroll,
	onClick,
	...rest
}: LinkProps) {
	const external = /^[a-z]+:\/\//i.test(href) || rest.target === "_blank"
	const handleClick = useCallback(
		(event: MouseEvent<HTMLAnchorElement>) => onClick?.(event),
		[onClick],
	)
	if (external) return <a href={href} onClick={handleClick} {...rest} />
	return (
		<WouterLink href={href} replace={replace} onClick={handleClick} {...rest} />
	)
}

/**
 * A single string query parameter, like nuqs's useQueryState without a parser.
 * Setting null removes it. Updates replace the history entry.
 */
export function useQueryParam(
	key: string,
): [string | null, (value: string | null) => void] {
	const params = useSearchParams()
	const [location, navigate] = useLocation()
	const value = params.get(key)
	const setValue = useCallback(
		(next: string | null) => {
			const updated = new URLSearchParams(window.location.search)
			if (next === null) updated.delete(key)
			else updated.set(key, next)
			const qs = updated.toString()
			navigate(`${location}${qs ? `?${qs}` : ""}`, { replace: true })
		},
		[key, location, navigate],
	)
	return [value, setValue]
}
