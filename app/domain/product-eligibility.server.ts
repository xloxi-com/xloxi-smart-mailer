/**
 * Product / variant eligibility and stock rules for Smart Product Mailer.
 *
 * Explicit inventory policy:
 * - Untracked inventory (`tracksInventory === false`): treated as sellable /
 *   in-stock regardless of quantity (Shopify can sell without tracking).
 * - `inventoryPolicy === "CONTINUE"`: sellable even when quantity <= 0.
 * - `inventoryPolicy === "DENY"` (default): sellable only when quantity > 0
 *   if inventory is tracked.
 *
 * Shopify `availableForSale` is also required when provided — it reflects
 * channel/market sellability beyond raw inventory math.
 *
 * Prices for unavailable variants must not be advertised (see
 * `advertisableVariantPrices`).
 */

export type InventoryPolicy = "DENY" | "CONTINUE";

export type VariantStockInput = {
  tracksInventory: boolean;
  inventoryPolicy: InventoryPolicy | string;
  inventoryQuantity: number;
  /** Shopify Admin `availableForSale` when known; omit to use stock rules only. */
  availableForSale?: boolean;
  deleted?: boolean;
};

export type ProductEligibilityInput = {
  status: string;
  publishedToOnlineStore: boolean;
  deleted?: boolean;
  /** When true (default), require at least one sellable variant. */
  inStockOnly?: boolean;
  variants: VariantStockInput[];
};

export function normalizeInventoryPolicy(
  value: string | null | undefined,
): InventoryPolicy {
  return value === "CONTINUE" ? "CONTINUE" : "DENY";
}

/**
 * Whether a variant can be sold online under configured stock rules.
 */
export function isVariantSellable(variant: VariantStockInput): boolean {
  if (variant.deleted) return false;

  const policy = normalizeInventoryPolicy(variant.inventoryPolicy);
  let stockOk: boolean;

  if (!variant.tracksInventory) {
    // Untracked: always considered available from an inventory standpoint.
    stockOk = true;
  } else if (policy === "CONTINUE") {
    // Continue selling when out of stock.
    stockOk = true;
  } else {
    stockOk = variant.inventoryQuantity > 0;
  }

  if (!stockOk) return false;

  // When Shopify reports availableForSale, require it for online sellability.
  if (variant.availableForSale === false) return false;

  return true;
}

export function computeProductInStock(variants: VariantStockInput[]): boolean {
  return variants.some((v) => isVariantSellable(v));
}

/**
 * Eligible for marketing emails: ACTIVE, Online Store published, not deleted,
 * and (when inStockOnly) at least one sellable variant.
 */
export function isProductEligible(input: ProductEligibilityInput): boolean {
  if (input.deleted) return false;
  if (input.status.toUpperCase() !== "ACTIVE") return false;
  if (!input.publishedToOnlineStore) return false;

  const inStockOnly = input.inStockOnly !== false;
  if (!inStockOnly) return true;

  return computeProductInStock(input.variants);
}

export type AdvertisablePrice = {
  price: string | null;
  compareAtPrice: string | null;
};

/**
 * Only return prices for sellable variants — never advertise unavailable prices.
 */
export function advertisableVariantPrices<
  T extends VariantStockInput & {
    price: string | null;
    compareAtPrice: string | null;
  },
>(variants: T[]): AdvertisablePrice[] {
  return variants
    .filter((v) => isVariantSellable(v))
    .map((v) => ({
      price: v.price,
      compareAtPrice: v.compareAtPrice,
    }));
}

export function minMaxAdvertisablePrices(
  prices: AdvertisablePrice[],
): { min: string | null; max: string | null } {
  const amounts = prices
    .map((p) => p.price)
    .filter((p): p is string => p != null && p !== "")
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n));

  if (amounts.length === 0) return { min: null, max: null };
  return {
    min: String(Math.min(...amounts)),
    max: String(Math.max(...amounts)),
  };
}
