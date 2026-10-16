import type { AccountStatus, BackendSummary } from './contract'

/** Selection uses detected installation and known sign-in failures, never the full catalog. */
export function backendAvailable(backend: BackendSummary, account?: AccountStatus): boolean {
  const installed = account?.installed ?? backend.installed
  if (installed === false || account?.signedIn === false) return false
  // Custom plugins without a status probe can still provide their own launch contract.
  return installed === true || (!backend.account && installed === undefined)
}
