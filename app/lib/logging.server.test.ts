import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logging.server";

describe("logger PII redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts email, tokens, secrets, and nested sensitive keys", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logger.info("audit_log", {
      email: "person@example.com",
      emailNormalized: "person@example.com",
      to: "person@example.com",
      unsubscribeToken: "abc.def",
      accessToken: "shopify-token",
      nested: { secret: "x", safe: "ok" },
      toHash: "abcd1234",
      shopId: "shop_1",
    });

    const line = String(spy.mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.email).toBe("[REDACTED]");
    expect(parsed.emailNormalized).toBe("[REDACTED]");
    expect(parsed.to).toBe("[REDACTED]");
    expect(parsed.unsubscribeToken).toBe("[REDACTED]");
    expect(parsed.accessToken).toBe("[REDACTED]");
    expect((parsed.nested as Record<string, unknown>).secret).toBe("[REDACTED]");
    expect((parsed.nested as Record<string, unknown>).safe).toBe("ok");
    expect(parsed.toHash).toBe("abcd1234");
    expect(parsed.shopId).toBe("shop_1");
    expect(line).not.toContain("person@example.com");
    expect(line).not.toContain("shopify-token");
  });
});
