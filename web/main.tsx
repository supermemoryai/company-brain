import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import { AuthProvider } from "@lib/auth-context"
import { App } from "./app"

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const root = document.getElementById("root")
if (root) {
	createRoot(root).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<AuthProvider>
					<App />
					<Toaster theme="dark" position="bottom-right" />
				</AuthProvider>
			</QueryClientProvider>
		</StrictMode>,
	)
}
