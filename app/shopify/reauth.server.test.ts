import { describe, expect, it } from "vitest";
import {
  buildScopeUpdateUrl,
  getMissingRequiredScopes,
  parseGrantedScopes,
  shopHandleFromDomain,
} from "./reauth.server";

describe("parseGrantedScopes", () => {
  it("expands write_* to include read_*", () => {
    const granted = parseGrantedScopes(
      "read_inventory,read_products,write_customers",
    );
    expect(granted.has("write_customers")).toBe(true);
    expect(granted.has("read_customers")).toBe(true);
  });
});

describe("getMissingRequiredScopes", () => {
  it("does not flag read_customers when write_customers is granted", () => {
    expect(
      getMissingRequiredScopes(
        "read_inventory,read_products,write_customers",
      ),
    ).toEqual([]);
  });

  it("flags truly missing scopes", () => {
    expect(getMissingRequiredScopes("read_products")).toContain(
      "read_inventory",
    );
  });
});

describe("buildScopeUpdateUrl", () => {
  it("uses admin.shopify.com store path", () => {
    expect(
      buildScopeUpdateUrl({
        shopDomain: "offrefy-qzj4kjnw.myshopify.com",
        clientId: "abc123",
        optionalScopes: ["read_customers"],
      }),
    ).toBe(
      "https://admin.shopify.com/store/offrefy-qzj4kjnw/oauth/install?client_id=abc123&optional_scopes=read_customers",
    );
  });
});

describe("shopHandleFromDomain", () => {
  it("strips myshopify suffix", () => {
    expect(shopHandleFromDomain("offrefy-qzj4kjnw.myshopify.com")).toBe(
      "offrefy-qzj4kjnw",
    );
  });
});
