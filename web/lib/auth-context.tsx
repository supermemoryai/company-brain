import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createContext, type ReactNode, useContext, useMemo } from "react"

export type SessionUser = {
	id: string
	email: string
	name: string
	image: string | null
}

export type SessionOrg = {
	id: string
	name: string
	slug: string
	logo: string | null
	metadata?: Record<string, unknown> | null
}

export type MemberRole = "owner" | "admin" | "member"

type Session = {
	user: SessionUser | null
	org: SessionOrg | null
	role: MemberRole | null
}

type AuthValue = Session & {
	isRestoring: boolean
	isAdmin: boolean
	signOut: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient()
	const session = useQuery({
		queryKey: ["session"],
		queryFn: async (): Promise<Session> => {
			const res = await fetch("/auth/session", { credentials: "include" })
			if (!res.ok) return { user: null, org: null, role: null }
			return res.json()
		},
		staleTime: 5 * 60_000,
	})

	const value = useMemo<AuthValue>(() => {
		const data = session.data ?? { user: null, org: null, role: null }
		return {
			...data,
			isRestoring: session.isPending,
			isAdmin: data.role === "owner" || data.role === "admin",
			signOut: async () => {
				await fetch("/auth/logout", { method: "POST", credentials: "include" })
				queryClient.clear()
				window.location.href = "/"
			},
		}
	}, [session.data, session.isPending, queryClient])

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
	const value = useContext(AuthContext)
	if (!value) throw new Error("useAuth must be used inside <AuthProvider>")
	return value
}
