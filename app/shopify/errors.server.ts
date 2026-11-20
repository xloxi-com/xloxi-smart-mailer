export class ShopifySessionInvalidError extends Error {
  readonly shop: string;
  readonly code: "EXPIRED" | "REVOKED" | "MISSING" | "UNAUTHORIZED";

  constructor(
    shop: string,
    code: ShopifySessionInvalidError["code"],
    message?: string,
  ) {
    super(message ?? `Shopify session invalid for shop (${code})`);
    this.name = "ShopifySessionInvalidError";
    this.shop = shop;
    this.code = code;
  }
}

export class ShopifyGraphqlError extends Error {
  readonly status?: number;
  readonly retriable: boolean;

  constructor(message: string, options?: { status?: number; retriable?: boolean }) {
    super(message);
    this.name = "ShopifyGraphqlError";
    this.status = options?.status;
    this.retriable = options?.retriable ?? false;
  }
}
