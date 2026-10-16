/**
 * The demo agent (canned replies, no account) exists only for automated tests
 * and screenshots: ANCORA_DEMO_AGENT=1, or any vitest run.
 */
export function demoAgentEnabled(): boolean {
  return process.env.ANCORA_DEMO_AGENT === '1' || !!process.env.VITEST
}
