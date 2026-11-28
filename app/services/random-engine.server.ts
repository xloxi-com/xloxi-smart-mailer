/**
 * Customer-wise random non-repeating product selection.
 *
 * Scalability: never loads the full catalog or full history into memory.
 * Selection uses indexed filters + SQL `ORDER BY random() LIMIT n` on the
 * remaining eligible set (or takes all remaining when count <= batchSize).
 *
 * Cycle rules:
 * - Per-subscriber independent cycles (Subscriber.currentCycleNumber).
 * - No repeats within a cycle (ProductHistory unique constraint).
 * - New eligible products are naturally included (not yet in history).
 * - Exhausted cycle → bump cycle on next reservation (no empty cycles).
 * - Across cycle boundaries, prefer avoiding the previous email's products
 *   when enough alternatives exist.
 */
import type { Prisma } from "@prisma/client";
import { Prisma as PrismaSql } from "../lib/prisma.server";
import { getPreviousAcceptedEmailProductIds } from "./product-history.server";

export const DEFAULT_BATCH_SIZE = 4;

type Tx = Prisma.TransactionClient;

export type SelectedProduct = {
  id: string;
  shopifyProductGid: string;
  title: string;
  handle: string | null;
  imageUrl: string | null;
  storefrontUrl: string | null;
  priceMin: Prisma.Decimal | null;
  currencyCode: string | null;
};

export type CycleSelection = {
  cycleNumber: number;
  startedNewCycle: boolean;
  products: SelectedProduct[];
};

type SelectParams = {
  shopId: string;
  subscriberId: string;
  cycleNumber: number;
  batchSize?: number;
  inStockOnly?: boolean;
  /** Soft-exclude these IDs when enough alternatives exist. */
  preferExcludeIds?: string[];
  /** Never return these IDs (already in batch / known unavailable). */
  hardExcludeIds?: string[];
};

function eligibleProductSql(
  shopId: string,
  subscriberId: string,
  cycleNumber: number,
  inStockOnly: boolean,
): Prisma.Sql {
  return PrismaSql.sql`
    p."shopId" = ${shopId}
    AND p.eligible = true
    AND p."excludedFromAutomation" = false
    AND p."deletedAt" IS NULL
    AND p.status = 'ACTIVE'
    AND p."publishedToOnlineStore" = true
    AND (${inStockOnly} = false OR p."inStock" = true)
    AND NOT EXISTS (
      SELECT 1
      FROM "ProductHistory" h
      WHERE h."shopId" = p."shopId"
        AND h."subscriberId" = ${subscriberId}
        AND h."cycleNumber" = ${cycleNumber}
        AND h."productId" = p.id
    )
  `;
}

/**
 * Count eligible products not yet sent in the given cycle.
 * Uses NOT EXISTS against ProductHistory (indexed) — does not load rows.
 */
export async function countEligibleUnsent(
  tx: Tx,
  options: {
    shopId: string;
    subscriberId: string;
    cycleNumber: number;
    inStockOnly?: boolean;
  },
): Promise<number> {
  const inStockOnly = options.inStockOnly !== false;
  const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "Product" p
    WHERE ${eligibleProductSql(
      options.shopId,
      options.subscriberId,
      options.cycleNumber,
      inStockOnly,
    )}
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Scalable random pick of up to `limit` eligible unsent products.
 * Optionally soft-excludes preferExcludeIds (filled only if needed).
 */
export async function selectRandomEligibleProducts(
  tx: Tx,
  options: SelectParams & { limit: number },
): Promise<SelectedProduct[]> {
  const inStockOnly = options.inStockOnly !== false;
  const preferExclude = options.preferExcludeIds ?? [];
  const hardExclude = options.hardExcludeIds ?? [];
  const limit = Math.max(0, options.limit);
  if (limit === 0) return [];

  const primary = await pickRandom(tx, {
    shopId: options.shopId,
    subscriberId: options.subscriberId,
    cycleNumber: options.cycleNumber,
    inStockOnly,
    hardExcludeIds: hardExclude,
    softExcludeIds: preferExclude,
    limit,
  });

  if (primary.length >= limit || preferExclude.length === 0) {
    return dedupeById(primary).slice(0, limit);
  }

  const need = limit - primary.length;
  const already = new Set(primary.map((p) => p.id));
  const fillFrom = preferExclude.filter((id) => !already.has(id));
  if (fillFrom.length === 0) return dedupeById(primary);

  const fillers = await pickRandom(tx, {
    shopId: options.shopId,
    subscriberId: options.subscriberId,
    cycleNumber: options.cycleNumber,
    inStockOnly,
    hardExcludeIds: [...hardExclude, ...already],
    softExcludeIds: [],
    limit: need,
    onlyIds: fillFrom,
  });

  return dedupeById([...primary, ...fillers]).slice(0, limit);
}

type PickArgs = {
  shopId: string;
  subscriberId: string;
  cycleNumber: number;
  inStockOnly: boolean;
  hardExcludeIds: string[];
  softExcludeIds: string[];
  limit: number;
  onlyIds?: string[];
};

async function pickRandom(tx: Tx, args: PickArgs): Promise<SelectedProduct[]> {
  const hardClause =
    args.hardExcludeIds.length > 0
      ? PrismaSql.sql`AND p.id <> ALL (${args.hardExcludeIds}::text[])`
      : PrismaSql.empty;
  const softClause =
    args.softExcludeIds.length > 0
      ? PrismaSql.sql`AND p.id <> ALL (${args.softExcludeIds}::text[])`
      : PrismaSql.empty;
  const onlyClause =
    args.onlyIds && args.onlyIds.length > 0
      ? PrismaSql.sql`AND p.id = ANY (${args.onlyIds}::text[])`
      : PrismaSql.empty;

  return tx.$queryRaw<SelectedProduct[]>`
    SELECT
      p.id,
      p."shopifyProductGid",
      p.title,
      p.handle,
      p."imageUrl",
      p."storefrontUrl",
      p."priceMin",
      p."currencyCode"
    FROM "Product" p
    WHERE ${eligibleProductSql(
      args.shopId,
      args.subscriberId,
      args.cycleNumber,
      args.inStockOnly,
    )}
    ${hardClause}
    ${softClause}
    ${onlyClause}
    ORDER BY random()
    LIMIT ${args.limit}
  `;
}

function dedupeById(products: SelectedProduct[]): SelectedProduct[] {
  const seen = new Set<string>();
  const out: SelectedProduct[] = [];
  for (const p of products) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * Plan a batch for the subscriber's current cycle, advancing the cycle when
 * exhausted. Returns null when nothing can be sent (no empty cycles).
 */
export async function planCycleSelection(
  tx: Tx,
  options: {
    shopId: string;
    subscriberId: string;
    currentCycleNumber: number;
    batchSize?: number;
    inStockOnly?: boolean;
  },
): Promise<CycleSelection | null> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const inStockOnly = options.inStockOnly !== false;
  let cycleNumber = options.currentCycleNumber;
  let startedNewCycle = false;

  let remaining = await countEligibleUnsent(tx, {
    shopId: options.shopId,
    subscriberId: options.subscriberId,
    cycleNumber,
    inStockOnly,
  });

  if (remaining === 0) {
    const catalogEligible = await tx.product.count({
      where: {
        shopId: options.shopId,
        eligible: true,
        excludedFromAutomation: false,
        deletedAt: null,
        status: "ACTIVE",
        publishedToOnlineStore: true,
        ...(inStockOnly ? { inStock: true } : {}),
      },
    });

    if (catalogEligible === 0) {
      return null;
    }

    cycleNumber += 1;
    startedNewCycle = true;
    remaining = catalogEligible;
  }

  const preferExclude = startedNewCycle
    ? await getPreviousAcceptedEmailProductIds(tx, {
        shopId: options.shopId,
        subscriberId: options.subscriberId,
      })
    : [];

  const limit = Math.min(batchSize, remaining);
  const products = await selectRandomEligibleProducts(tx, {
    shopId: options.shopId,
    subscriberId: options.subscriberId,
    cycleNumber,
    inStockOnly,
    limit,
    preferExcludeIds: preferExclude,
  });

  if (products.length === 0) {
    return null;
  }

  if (new Set(products.map((p) => p.id)).size !== products.length) {
    throw new Error("random_engine_duplicate_product_ids");
  }

  // Targeted history check — only the selected IDs, not the full cycle history.
  const alreadySent = await tx.productHistory.findMany({
    where: {
      shopId: options.shopId,
      subscriberId: options.subscriberId,
      cycleNumber,
      productId: { in: products.map((p) => p.id) },
    },
    select: { productId: true },
  });
  const alreadySet = new Set(alreadySent.map((r) => r.productId));
  const filtered = products.filter((p) => !alreadySet.has(p.id));
  if (filtered.length === 0) {
    return null;
  }

  return {
    cycleNumber,
    startedNewCycle,
    products: filtered,
  };
}
