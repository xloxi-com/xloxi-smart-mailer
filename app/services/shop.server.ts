import type { AutomationSettings, Shop } from "@prisma/client";
import prisma from "../db.server";
import { normalizeShopDomain } from "../lib/shop-domain.server";

export type ShopWithSettings = Shop & {
  automationSettings: AutomationSettings | null;
};

/**
 * Ensure a Shop + AutomationSettings row exists for an authenticated shop domain.
 */
export async function ensureShop(
  shopDomainInput: string,
  extras?: { name?: string | null; currencyCode?: string | null },
): Promise<ShopWithSettings> {
  const shopDomain = normalizeShopDomain(shopDomainInput);

  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      name: extras?.name ?? null,
      currencyCode: extras?.currencyCode ?? null,
      automationSettings: { create: {} },
    },
    update: {
      ...(extras?.name != null ? { name: extras.name } : {}),
      ...(extras?.currencyCode != null
        ? { currencyCode: extras.currencyCode }
        : {}),
      uninstalledAt: null,
    },
    include: { automationSettings: true },
  });

  if (!shop.automationSettings) {
    await prisma.automationSettings.create({ data: { shopId: shop.id } });
    return prisma.shop.findUniqueOrThrow({
      where: { id: shop.id },
      include: { automationSettings: true },
    });
  }

  return shop;
}

export async function getShopByDomain(
  shopDomainInput: string,
): Promise<ShopWithSettings | null> {
  const shopDomain = normalizeShopDomain(shopDomainInput);
  return prisma.shop.findUnique({
    where: { shopDomain },
    include: { automationSettings: true },
  });
}
