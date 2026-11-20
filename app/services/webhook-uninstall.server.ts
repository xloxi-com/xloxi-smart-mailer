/**
 * App uninstall: stop automation, cancel durable jobs, drop sessions.
 */
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import { EmailJobStatus, SyncJobStatus } from "../lib/prisma.server";
import { normalizeShopDomain } from "../lib/shop-domain.server";

const ACTIVE_EMAIL = [
  EmailJobStatus.PENDING,
  EmailJobStatus.PROCESSING,
  EmailJobStatus.RETRY_SCHEDULED,
  EmailJobStatus.UNKNOWN,
] as const;

export async function handleAppUninstalled(options: {
  shopDomain: string;
  shopId?: string | null;
}): Promise<void> {
  const shopDomain = normalizeShopDomain(options.shopDomain);
  const shop =
    options.shopId != null
      ? await prisma.shop.findUnique({ where: { id: options.shopId } })
      : await prisma.shop.findUnique({ where: { shopDomain } });

  if (!shop) {
    await prisma.session.deleteMany({ where: { shop: shopDomain } });
    logger.info("app_uninstalled_no_shop_row", { shop: shopDomain });
    return;
  }

  await prisma.automationSettings.updateMany({
    where: { shopId: shop.id },
    data: { automationEnabled: false },
  });

  await prisma.shop.update({
    where: { id: shop.id },
    data: { uninstalledAt: new Date() },
  });

  await prisma.syncJob.updateMany({
    where: {
      shopId: shop.id,
      status: { in: [SyncJobStatus.PENDING, SyncJobStatus.RUNNING] },
    },
    data: {
      status: SyncJobStatus.CANCELLED,
      completedAt: new Date(),
      lastError: "app_uninstalled",
    },
  });

  await prisma.emailJob.updateMany({
    where: {
      shopId: shop.id,
      status: { in: [...ACTIVE_EMAIL] },
    },
    data: {
      status: EmailJobStatus.CANCELLED,
      completedAt: new Date(),
      lastErrorCode: "app_uninstalled",
      lastErrorMessage: "App uninstalled",
    },
  });

  await prisma.session.deleteMany({ where: { shop: shopDomain } });

  await prisma.auditLog.create({
    data: {
      shopId: shop.id,
      action: "WEBHOOK",
      entityType: "Shop",
      entityId: shop.id,
      actorType: "shopify",
      metadata: {
        topic: "app/uninstalled",
        automationStopped: true,
      } as Prisma.InputJsonValue,
    },
  });

  logger.info("app_uninstalled_processed", {
    shop: shopDomain,
    shopId: shop.id,
  });
}
