import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { ensureShop } from "./shop.server";

export type ProductListFilter = {
  shopId: string;
  q?: string | null;
  eligible?: boolean | null;
  inStock?: boolean | null;
  excluded?: boolean | null;
  page?: number;
  pageSize?: number;
};

export async function listAdminProducts(filter: ProductListFilter) {
  const page = Math.max(filter.page ?? 1, 1);
  const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 100);
  const where: Prisma.ProductWhereInput = {
    shopId: filter.shopId,
    deletedAt: null,
  };

  if (filter.eligible != null) where.eligible = filter.eligible;
  if (filter.inStock != null) where.inStock = filter.inStock;
  if (filter.excluded != null) where.excludedFromAutomation = filter.excluded;
  if (filter.q) {
    const q = filter.q.trim();
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { handle: { contains: q, mode: "insensitive" } },
      { shopifyProductGid: { contains: q } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: [{ eligible: "desc" }, { title: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        handle: true,
        imageUrl: true,
        priceMin: true,
        priceMax: true,
        currencyCode: true,
        totalInventory: true,
        inStock: true,
        eligible: true,
        excludedFromAutomation: true,
        status: true,
        publishedToOnlineStore: true,
        lastSyncedAt: true,
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    rows: rows.map((r) => ({
      ...r,
      priceMin: r.priceMin?.toString() ?? null,
      priceMax: r.priceMax?.toString() ?? null,
      lastSyncedAt: r.lastSyncedAt.toISOString(),
    })),
  };
}

export async function setProductsExcluded(
  shopId: string,
  productIds: string[],
  excluded: boolean,
): Promise<number> {
  if (productIds.length === 0) return 0;
  const result = await prisma.product.updateMany({
    where: { shopId, id: { in: productIds }, deletedAt: null },
    data: { excludedFromAutomation: excluded },
  });
  return result.count;
}

export function parseCollectionGids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v).trim())
    .filter((v) => v.startsWith("gid://shopify/Collection/"));
}

export async function getExcludedCollections(shopId: string): Promise<string[]> {
  const settings = await prisma.automationSettings.findUnique({
    where: { shopId },
    select: { excludedCollectionGids: true },
  });
  return parseCollectionGids(settings?.excludedCollectionGids);
}

export async function saveExcludedCollections(
  shopDomain: string,
  gids: string[],
): Promise<string[]> {
  const shop = await ensureShop(shopDomain);
  const cleaned = [
    ...new Set(
      gids
        .map((g) => g.trim())
        .filter((g) => g.startsWith("gid://shopify/Collection/")),
    ),
  ];
  await prisma.automationSettings.update({
    where: { shopId: shop.id },
    data: { excludedCollectionGids: cleaned },
  });
  return cleaned;
}
