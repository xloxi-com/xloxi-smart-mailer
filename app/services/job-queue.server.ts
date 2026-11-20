/**
 * PostgreSQL durable email job queue.
 * Claiming uses SELECT … FOR UPDATE SKIP LOCKED; leases recover after crashes.
 */
import type { EmailJob, EmailJobProduct } from "@prisma/client";
import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { logger } from "../lib/logging.server";
import { EmailJobStatus, Prisma } from "../lib/prisma.server";
import { computeEmailBackoffMs } from "./email-provider.server";

export type EmailJobWithProducts = EmailJob & { products: EmailJobProduct[] };

export type WorkerMetrics = {
  claimed: number;
  processed: number;
  accepted: number;
  failed: number;
  skipped: number;
  retried: number;
  deadLetter: number;
  staleRecovered: number;
  errors: number;
};

export function emptyWorkerMetrics(): WorkerMetrics {
  return {
    claimed: 0,
    processed: 0,
    accepted: 0,
    failed: 0,
    skipped: 0,
    retried: 0,
    deadLetter: 0,
    staleRecovered: 0,
    errors: 0,
  };
}

export function createWorkerId(prefix: string): string {
  return `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export const DURABLE_LOCKS = {
  scheduler: "email-scheduler",
  emailWorker: "email-worker",
} as const;

/**
 * Pool-safe mutex using DurableLock rows (works with PgBouncer / Prisma pools).
 * Expired locks are stealable.
 */
export async function tryDurableLock(options: {
  lockId: string;
  owner: string;
  ttlMs?: number;
}): Promise<boolean> {
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const until = new Date(Date.now() + ttlMs);

  await prisma.durableLock.upsert({
    where: { id: options.lockId },
    create: { id: options.lockId },
    update: {},
  });

  const result = await prisma.$executeRaw`
    UPDATE "DurableLock"
    SET
      "lockedBy" = ${options.owner},
      "lockedUntil" = ${until},
      "updatedAt" = NOW()
    WHERE id = ${options.lockId}
      AND (
        "lockedUntil" IS NULL
        OR "lockedUntil" < NOW()
        OR "lockedBy" = ${options.owner}
      )
  `;

  return Number(result) === 1;
}

export async function releaseDurableLock(options: {
  lockId: string;
  owner: string;
}): Promise<void> {
  await prisma.durableLock.updateMany({
    where: { id: options.lockId, lockedBy: options.owner },
    data: { lockedBy: null, lockedUntil: null },
  });
}

/** @deprecated Use tryDurableLock — kept for call-site compatibility during migrate. */
export async function tryAdvisoryLock(lockKey: number): Promise<boolean> {
  const id =
    lockKey === 872_314_001
      ? DURABLE_LOCKS.scheduler
      : DURABLE_LOCKS.emailWorker;
  return tryDurableLock({ lockId: id, owner: `legacy-${lockKey}` });
}

/** @deprecated Use releaseDurableLock */
export async function releaseAdvisoryLock(lockKey: number): Promise<void> {
  const id =
    lockKey === 872_314_001
      ? DURABLE_LOCKS.scheduler
      : DURABLE_LOCKS.emailWorker;
  await releaseDurableLock({ lockId: id, owner: `legacy-${lockKey}` });
}

export const ADVISORY_LOCKS = {
  scheduler: 872_314_001,
  emailWorker: 872_314_002,
} as const;

/**
 * Return expired PROCESSING leases to PENDING / RETRY_SCHEDULED without
 * consuming an attempt (crash recovery).
 */
export async function recoverStaleEmailJobLeases(
  now = new Date(),
): Promise<number> {
  const stale = await prisma.emailJob.findMany({
    where: {
      status: EmailJobStatus.PROCESSING,
      leaseExpiresAt: { lt: now },
    },
    select: { id: true, attemptCount: true, nextRetryAt: true },
    take: 200,
  });

  let recovered = 0;
  for (const job of stale) {
    const nextStatus =
      job.attemptCount > 0 && job.nextRetryAt
        ? EmailJobStatus.RETRY_SCHEDULED
        : EmailJobStatus.PENDING;
    const updated = await prisma.emailJob.updateMany({
      where: {
        id: job.id,
        status: EmailJobStatus.PROCESSING,
        leaseExpiresAt: { lt: now },
      },
      data: {
        status: nextStatus,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "stale_lease_recovered",
        lastErrorMessage: "Worker lease expired; re-queued",
      },
    });
    recovered += updated.count;
  }

  if (recovered > 0) {
    logger.warn("email_jobs_stale_lease_recovered", { recovered });
  }
  return recovered;
}

/**
 * Claim due email jobs with SKIP LOCKED (safe concurrent workers).
 */
export async function claimEmailJobs(options: {
  limit: number;
  leaseOwner: string;
  leaseMs?: number;
  shopId?: string;
}): Promise<EmailJobWithProducts[]> {
  const limit = Math.max(1, Math.min(options.limit, 100));
  const leaseMs = options.leaseMs ?? 120_000;
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const claimed = await prisma.$transaction(async (tx) => {
    const shopFilter = options.shopId
      ? Prisma.sql`AND e."shopId" = ${options.shopId}`
      : Prisma.empty;

    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT e.id
      FROM "EmailJob" e
      WHERE (
          (e.status = 'PENDING' AND e."runAt" <= ${now})
          OR (e.status = 'RETRY_SCHEDULED' AND e."nextRetryAt" IS NOT NULL AND e."nextRetryAt" <= ${now})
        )
        ${shopFilter}
      ORDER BY COALESCE(e."nextRetryAt", e."runAt") ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `;

    if (rows.length === 0) return [] as string[];

    const ids = rows.map((r) => r.id);
    await tx.emailJob.updateMany({
      where: { id: { in: ids } },
      data: {
        status: EmailJobStatus.PROCESSING,
        leaseOwner: options.leaseOwner,
        leaseExpiresAt,
        processingStartedAt: now,
        attemptCount: { increment: 1 },
      },
    });
    return ids;
  });

  if (claimed.length === 0) return [];

  return prisma.emailJob.findMany({
    where: { id: { in: claimed } },
    include: { products: { orderBy: { position: "asc" } } },
  });
}

/** Extend lease while processing a long send. */
export async function renewEmailJobLease(
  emailJobId: string,
  leaseOwner: string,
  leaseMs = 120_000,
): Promise<boolean> {
  const result = await prisma.emailJob.updateMany({
    where: {
      id: emailJobId,
      status: EmailJobStatus.PROCESSING,
      leaseOwner,
    },
    data: {
      leaseExpiresAt: new Date(Date.now() + leaseMs),
    },
  });
  return result.count === 1;
}

/** Dead-letter: mark FAILED after exhausting retries. */
export async function deadLetterEmailJob(
  emailJobId: string,
  error: { code?: string; message?: string },
): Promise<EmailJob> {
  const job = await prisma.emailJob.update({
    where: { id: emailJobId },
    data: {
      status: EmailJobStatus.FAILED,
      completedAt: new Date(),
      lastErrorCode: error.code ?? "dead_letter",
      lastErrorMessage: (error.message ?? "Max attempts exceeded").slice(0, 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
    },
  });
  logger.error("email_job_dead_letter", {
    emailJobId,
    code: job.lastErrorCode,
    attemptCount: job.attemptCount,
  });
  return job;
}

export async function scheduleRetryOrDeadLetter(
  job: EmailJob,
  error: { code?: string; message?: string; retryable?: boolean },
): Promise<"retried" | "dead_letter"> {
  if (!error.retryable || job.attemptCount >= job.maxAttempts) {
    await deadLetterEmailJob(job.id, error);
    return "dead_letter";
  }

  const backoff = computeEmailBackoffMs(job.attemptCount);
  await prisma.emailJob.update({
    where: { id: job.id },
    data: {
      status: EmailJobStatus.RETRY_SCHEDULED,
      nextRetryAt: new Date(Date.now() + backoff),
      lastErrorCode: error.code,
      lastErrorMessage: error.message?.slice(0, 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  return "retried";
}

export async function startWorkerHeartbeat(options: {
  workerId: string;
  workerType: string;
  metrics?: WorkerMetrics;
}): Promise<string> {
  const row = await prisma.workerHeartbeat.create({
    data: {
      workerId: options.workerId,
      workerType: options.workerType,
      status: "running",
      metrics: options.metrics ?? emptyWorkerMetrics(),
    },
  });
  return row.id;
}

export async function pulseWorkerHeartbeat(
  heartbeatId: string,
  metrics: WorkerMetrics,
  lastError?: string | null,
): Promise<void> {
  await prisma.workerHeartbeat.update({
    where: { id: heartbeatId },
    data: {
      metrics,
      lastError: lastError ?? null,
      status: "running",
    },
  });
}

export async function finishWorkerHeartbeat(
  heartbeatId: string,
  metrics: WorkerMetrics,
  status: "succeeded" | "failed" | "cancelled" = "succeeded",
  lastError?: string | null,
): Promise<void> {
  await prisma.workerHeartbeat.update({
    where: { id: heartbeatId },
    data: {
      metrics,
      status,
      lastError: lastError ?? null,
      finishedAt: new Date(),
    },
  });
}
