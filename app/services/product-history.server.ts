/**
 * Per-subscriber product send history (cycle-scoped).
 * History is written only after the email provider accepts a send.
 * Stock/eligibility changes never delete history rows.
 */
import type { EmailJob, EmailJobProduct, Prisma } from "@prisma/client";
import { EmailJobStatus, FlowBatchStatus } from "../lib/prisma.server";
import prisma from "../db.server";

type Tx = Prisma.TransactionClient;

export async function getSentProductIdsInCycle(
  tx: Tx,
  options: {
    shopId: string;
    subscriberId: string;
    cycleNumber: number;
  },
): Promise<string[]> {
  const rows = await tx.productHistory.findMany({
    where: {
      shopId: options.shopId,
      subscriberId: options.subscriberId,
      cycleNumber: options.cycleNumber,
    },
    select: { productId: true },
  });
  return rows.map((r) => r.productId);
}

/**
 * Product IDs from the most recently accepted email for this subscriber
 * (used to avoid immediate repeats across cycle boundaries when alternatives exist).
 */
export async function getPreviousAcceptedEmailProductIds(
  tx: Tx,
  options: { shopId: string; subscriberId: string },
): Promise<string[]> {
  const last = await tx.emailJob.findFirst({
    where: {
      shopId: options.shopId,
      subscriberId: options.subscriberId,
      OR: [
        { status: EmailJobStatus.ACCEPTED },
        {
          flowStatus: {
            in: [FlowBatchStatus.READY, FlowBatchStatus.ACKNOWLEDGED],
          },
        },
      ],
    },
    orderBy: [{ acknowledgedAt: "desc" }, { completedAt: "desc" }],
    include: {
      products: { select: { productId: true }, orderBy: { position: "asc" } },
    },
  });
  return last?.products.map((p) => p.productId) ?? [];
}

/**
 * Persist immutable cycle history after provider acceptance.
 * Unique (shopId, subscriberId, productId, cycleNumber) is the final safeguard.
 */
export async function commitProductHistoryAfterAcceptance(
  tx: Tx,
  options: {
    shopId: string;
    subscriberId: string;
    cycleNumber: number;
    emailJobId: string;
    productIds: string[];
    sentAt?: Date;
  },
): Promise<number> {
  if (options.productIds.length === 0) return 0;

  const sentAt = options.sentAt ?? new Date();
  let written = 0;

  for (const productId of options.productIds) {
    try {
      await tx.productHistory.create({
        data: {
          shopId: options.shopId,
          subscriberId: options.subscriberId,
          productId,
          cycleNumber: options.cycleNumber,
          emailJobId: options.emailJobId,
          sentAt,
        },
      });
      written += 1;
    } catch (error) {
      // Unique violation → already recorded (retry-safe); keep going.
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: string }).code)
          : "";
      if (code !== "P2002") throw error;
    }
  }

  return written;
}

export async function commitHistoryForAcceptedJob(
  job: EmailJob & { products: EmailJobProduct[] },
  client: Tx = prisma,
): Promise<number> {
  return commitProductHistoryAfterAcceptance(client, {
    shopId: job.shopId,
    subscriberId: job.subscriberId,
    cycleNumber: job.cycleNumber,
    emailJobId: job.id,
    productIds: job.products.map((p) => p.productId),
    sentAt: job.completedAt ?? new Date(),
  });
}

export async function countHistoryInCycle(
  tx: Tx,
  options: { shopId: string; subscriberId: string; cycleNumber: number },
): Promise<number> {
  return tx.productHistory.count({
    where: {
      shopId: options.shopId,
      subscriberId: options.subscriberId,
      cycleNumber: options.cycleNumber,
    },
  });
}
