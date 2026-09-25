import { useAuth } from "@lib/auth-context"

// The session already carries the role, so there is nothing to fetch; the
// query shape stays for call sites that read `query.isPending`.
export function useOrgMemberRole(_enabled = true) {
	const { role, isRestoring } = useAuth()
	return {
		role: role ?? "",
		isAdmin: role === "owner" || role === "admin",
		query: { isPending: isRestoring, isLoading: isRestoring },
	}
}
