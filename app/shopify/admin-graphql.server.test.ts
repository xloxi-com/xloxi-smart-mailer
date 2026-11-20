import { describe, expect, it, vi } from "vitest";
import { adminGraphql } from "./admin-graphql.server";
import { ShopifyGraphqlError } from "./errors.server";

describe("adminGraphql", () => {
  it("returns data on success", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { shop: { name: "X" } } }), {
          status: 200,
        }),
      ),
    };

    const result = await adminGraphql<{ shop: { name: string } }>(
      admin,
      "{ shop { name } }",
      { shop: "test.myshopify.com", maxAttempts: 1 },
    );

    expect(result.data.shop.name).toBe("X");
  });

  it("retries on HTTP 429 then succeeds", async () => {
    const admin = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce(new Response("slow", { status: 429 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
          }),
        ),
    };

    const result = await adminGraphql<{ ok: boolean }>(admin, "{ ok }", {
      shop: "test.myshopify.com",
      maxAttempts: 3,
      baseDelayMs: 1,
    });

    expect(result.data.ok).toBe(true);
    expect(admin.graphql).toHaveBeenCalledTimes(2);
  });

  it("invokes onUnauthorized for 401", async () => {
    const onUnauthorized = vi.fn().mockResolvedValue(undefined);
    const admin = {
      graphql: vi.fn().mockResolvedValue(new Response("nope", { status: 401 })),
    };

    await expect(
      adminGraphql(admin, "{ shop { id } }", {
        shop: "test.myshopify.com",
        maxAttempts: 1,
        onUnauthorized,
      }),
    ).rejects.toMatchObject({ code: "EXPIRED" });

    expect(onUnauthorized).toHaveBeenCalledWith("test.myshopify.com");
  });

  it("fails closed on non-retriable GraphQL errors", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [{ message: "Field undefined" }],
          }),
          { status: 200 },
        ),
      ),
    };

    await expect(
      adminGraphql(admin, "{ nope }", {
        shop: "test.myshopify.com",
        maxAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(ShopifyGraphqlError);
  });
});
