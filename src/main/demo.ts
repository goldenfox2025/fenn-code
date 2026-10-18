/**
 * The demo agent (canned replies, no account) exists only for automated tests
 * and screenshots in development: FENN_DEMO_AGENT=1, or any vitest run.
 * Production builds cannot enable it with environment variables.
 */
export function demoAgentEnabled(): boolean {
  return import.meta.env.DEV && (process.env.FENN_DEMO_AGENT === '1' || !!process.env.VITEST)
}
