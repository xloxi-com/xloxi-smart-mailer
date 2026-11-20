import { describe, expect, it } from "vitest";
import {
  InvalidShopDomainError,
  assertShopMatchesSession,
  normalizeShopDomain,
  shopsEqual,
} from "./shop-domain.server";

describe("normalizeShopDomain", () => {
  it("accepts myshopify hostnames", () => {
    expect(normalizeShopDomain("Seductiv-Store.myshopify.com")).toBe(
      "seductiv-store.myshopify.com",
    );
  });

  it("parses URLs", () => {
    expect(
      normalizeShopDomain("https://seductiv-store.myshopify.com/admin"),
    ).toBe("seductiv-store.myshopify.com");
  });

  it("rejects arbitrary domains", () => {
    expect(() => normalizeShopDomain("evil.example.com")).toThrow(
      InvalidShopDomainError,
    );
  });

  it("allows configured custom domains", () => {
    expect(
      normalizeShopDomain("seductiv.net", {
        customShopDomains: ["seductiv.net"],
      }),
    ).toBe("seductiv.net");
  });
});

describe("assertShopMatchesSession", () => {
  it("returns session shop when candidate omitted", () => {
    expect(assertShopMatchesSession("a.myshopify.com", null)).toBe(
      "a.myshopify.com",
    );
  });

  it("rejects mismatched shops", () => {
    expect(() =>
      assertShopMatchesSession("a.myshopify.com", "b.myshopify.com"),
    ).toThrow();
  });
});

describe("shopsEqual", () => {
  it("compares normalized hosts", () => {
    expect(shopsEqual("A.myshopify.com", "a.myshopify.com")).toBe(true);
    expect(shopsEqual("a.myshopify.com", "b.myshopify.com")).toBe(false);
  });
});
