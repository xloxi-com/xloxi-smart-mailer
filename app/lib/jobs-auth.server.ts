/**
 * Auth for Cloud Scheduler / Cloud Run Job HTTP triggers.
 *
 * Production / deployed environments: JOBS_SHARED_SECRET (or CRON_SECRET) is required.
 * Spoofable Google auth headers alone are never sufficient — shared secret must match.
 * Local/dev may opt into insecure mode only with JOBS_ALLOW_INSECURE=true.
 */
export function authorizeJobsRequest(request: Request): boolean {
  const expected =
    process.env.JOBS_SHARED_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (!expected) {
    // Fail closed unless an explicit insecure opt-in is set outside production.
    if (
      process.env.JOBS_ALLOW_INSECURE === "true" &&
      process.env.NODE_ENV !== "production"
    ) {
      return true;
    }
    return false;
  }

  const bearer = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    ?.trim();
  const header = request.headers.get("x-jobs-secret")?.trim();
  if (bearer === expected || header === expected) return true;

  // Optional second factor: when OIDC audience is configured, still require the
  // shared secret (already checked above). Header-only Google auth is rejected.
  return false;
}
