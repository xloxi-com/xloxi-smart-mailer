-- CreateEnum
CREATE TYPE "FlowBatchStatus" AS ENUM ('NONE', 'PENDING', 'READY', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED');

-- AlterTable AutomationSettings
ALTER TABLE "AutomationSettings" ADD COLUMN IF NOT EXISTS "testMode" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AutomationSettings" ADD COLUMN IF NOT EXISTS "appSchedulerEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutomationSettings" ALTER COLUMN "emailProviderLabel" SET DEFAULT 'shopify_messaging';

-- AlterTable Subscriber
ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "pendingBatchId" TEXT;
ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "processedBatchId" TEXT;
ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "lastProcessedAt" TIMESTAMPTZ(3);

-- AlterTable EmailJob
ALTER TABLE "EmailJob" ADD COLUMN IF NOT EXISTS "flowStatus" "FlowBatchStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "EmailJob" ADD COLUMN IF NOT EXISTS "triggerSource" TEXT;
ALTER TABLE "EmailJob" ADD COLUMN IF NOT EXISTS "flowReadyAt" TIMESTAMPTZ(3);
ALTER TABLE "EmailJob" ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmailJob_shopId_flowStatus_createdAt_idx" ON "EmailJob"("shopId", "flowStatus", "createdAt");
