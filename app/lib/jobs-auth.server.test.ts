import { afterEach, describe, expect, it } from "vitest";
import { authorizeJobsRequest } from "./jobs-auth.server";

describe("authorizeJobsRequest", () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env.JOBS_SHARED_SECRET = prev.JOBS_SHARED_SECRET;
    process.env.CRON_SECRET = prev.CRON_SECRET;
    process.env.JOBS_ALLOW_INSECURE = prev.JOBS_ALLOW_INSECURE;
    process.env.NODE_ENV = prev.NODE_ENV;
    process.env.JOBS_OIDC_AUDIENCE = prev.JOBS_OIDC_AUDIENCE;
  });

  it("denies requests when no secret is configured", () => {
    delete process.env.JOBS_SHARED_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.JOBS_ALLOW_INSECURE;
    process.env.NODE_ENV = "development";

    expect(
      authorizeJobsRequest(new Request("https://app.example/api/jobs/scheduler")),
    ).toBe(false);
  });

  it("denies production requests without a secret even if insecure flag is set", () => {
    delete process.env.JOBS_SHARED_SECRET;
    delete process.env.CRON_SECRET;
    process.env.JOBS_ALLOW_INSECURE = "true";
    process.env.NODE_ENV = "production";

    expect(
      authorizeJobsRequest(new Request("https://app.example/api/jobs/scheduler")),
    ).toBe(false);
  });

  it("allows insecure opt-in only outside production", () => {
    delete process.env.JOBS_SHARED_SECRET;
    delete process.env.CRON_SECRET;
    process.env.JOBS_ALLOW_INSECURE = "true";
    process.env.NODE_ENV = "test";

    expect(
      authorizeJobsRequest(new Request("https://app.example/api/jobs/scheduler")),
    ).toBe(true);
  });

  it("accepts shared secret via header or bearer", () => {
    process.env.JOBS_SHARED_SECRET = "jobs-secret-value";
    process.env.NODE_ENV = "production";

    expect(
      authorizeJobsRequest(
        new Request("https://app.example/api/jobs/scheduler", {
          headers: { "x-jobs-secret": "jobs-secret-value" },
        }),
      ),
    ).toBe(true);

    expect(
      authorizeJobsRequest(
        new Request("https://app.example/api/jobs/scheduler", {
          headers: { authorization: "Bearer jobs-secret-value" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects spoofed Google OIDC headers without the shared secret", () => {
    process.env.JOBS_SHARED_SECRET = "jobs-secret-value";
    process.env.JOBS_OIDC_AUDIENCE = "https://app.example/api/jobs";
    process.env.NODE_ENV = "production";

    expect(
      authorizeJobsRequest(
        new Request("https://app.example/api/jobs/scheduler", {
          headers: {
            "x-goog-authenticated-user-email": "attacker@evil.test",
            "x-jobs-audience": "https://app.example/api/jobs",
          },
        }),
      ),
    ).toBe(false);
  });
});
