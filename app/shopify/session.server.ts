import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import { normalizeShopDomain } from "../lib/shop-domain.server";
import { sessionStorage } from "../shopify.server";

/**
 * Delete all stored sessions for a shop after revoke/expiry.
 * Safe to call from job workers; never logs tokens.
 */
export async function invalidateShopSessions(shopInput: string): Promise<void> {
  const shop = normalizeShopDomain(shopInput);
  const sessions = await sessionStorage.findSessionsByShop(shop);
  if (sessions.length > 0) {
    await sessionStorage.deleteSessions(sessions.map((s) => s.id));
  }
  // Belt-and-suspenders for any rows not visible through the adapter.
  await prisma.session.deleteMany({ where: { shop } });
  logger.warn("shop_sessions_invalidated", { shop, count: sessions.length });
}

export async function hasOfflineSession(shopInput: string): Promise<boolean> {
  const shop = normalizeShopDomain(shopInput);
  const sessions = await sessionStorage.findSessionsByShop(shop);
  return sessions.some((s) => !s.isOnline && Boolean(s.accessToken));
}
