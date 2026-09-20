// Light surface only; CompanyBrainAgent stays out (its agents/cloudflare deps would leak into self-hosted startup) and is exported directly from worker.ts.
export { writeCompanyContext } from "./memory/company-context"
