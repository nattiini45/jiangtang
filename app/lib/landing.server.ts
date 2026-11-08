/**
 * The public `/welcome` landing page is opt-in. A self-hosted team instance serves only the
 * sign-in page to strangers; an operator who wants the marketing page sets
 * `LANDING_PAGE_ENABLED=1`.
 */
export function landingPageEnabled(): boolean {
  return process.env.LANDING_PAGE_ENABLED === "1";
}
