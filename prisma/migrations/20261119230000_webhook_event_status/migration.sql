-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'DUPLICATE');

-- AlterTable
ALTER TABLE "WebhookEvent"
  ADD COLUMN IF NOT EXISTS "status" "WebhookEventStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "leaseOwner" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "resourceGid" TEXT,
  ADD COLUMN IF NOT EXISTS "resourceUpdatedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "safePayload" JSONB,
  ADD COLUMN IF NOT EXISTS "lastError" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: previously claimed rows were marked with processedAt.
UPDATE "WebhookEvent"
SET "status" = 'SUCCEEDED'
WHERE "processedAt" IS NOT NULL AND "status" = 'PENDING';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookEvent_status_nextRetryAt_idx"
  ON "WebhookEvent"("status", "nextRetryAt");

CREATE INDEX IF NOT EXISTS "WebhookEvent_status_createdAt_idx"
  ON "WebhookEvent"("status", "createdAt");
