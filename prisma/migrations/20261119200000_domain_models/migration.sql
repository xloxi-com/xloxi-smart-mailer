-- CreateEnum
CREATE TYPE "MarketingConsentState" AS ENUM ('SUBSCRIBED', 'UNSUBSCRIBED', 'NOT_SUBSCRIBED', 'PENDING', 'INVALID', 'REDACTED');

-- CreateEnum
CREATE TYPE "EmailJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'ACCEPTED', 'FAILED', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('QUEUED', 'CLAIMED', 'SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED', 'FAILED', 'CANCELLED', 'RETRY');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'MANUAL', 'REDACTED', 'INVALID_EMAIL');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('PRODUCTS', 'CUSTOMERS', 'INVENTORY', 'FULL');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'SEND', 'SKIP', 'SYNC', 'SETTINGS', 'AUTH', 'WEBHOOK', 'SYSTEM');

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "expires" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "refreshTokenExpires" SET DATA TYPE TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "currencyCode" VARCHAR(3),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "installedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMPTZ(3),
    "lastSyncAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationSettings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "automationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalDays" INTEGER NOT NULL DEFAULT 3,
    "productsPerEmail" INTEGER NOT NULL DEFAULT 6,
    "randomSelection" BOOLEAN NOT NULL DEFAULT true,
    "inStockOnly" BOOLEAN NOT NULL DEFAULT true,
    "preventDuplicates" BOOLEAN NOT NULL DEFAULT true,
    "autoResetCycle" BOOLEAN NOT NULL DEFAULT true,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "fromName" TEXT,
    "replyTo" TEXT,
    "templateVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductGid" TEXT NOT NULL,
    "handle" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "publishedToOnlineStore" BOOLEAN NOT NULL DEFAULT false,
    "totalInventory" INTEGER NOT NULL DEFAULT 0,
    "tracksInventory" BOOLEAN NOT NULL DEFAULT true,
    "inStock" BOOLEAN NOT NULL DEFAULT false,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "imageUrl" TEXT,
    "priceMin" DECIMAL(18,2),
    "priceMax" DECIMAL(18,2),
    "currencyCode" VARCHAR(3),
    "shopifyUpdatedAt" TIMESTAMPTZ(3),
    "lastSyncedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyVariantGid" TEXT NOT NULL,
    "title" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "price" DECIMAL(18,2),
    "compareAtPrice" DECIMAL(18,2),
    "inventoryQuantity" INTEGER NOT NULL DEFAULT 0,
    "inventoryItemGid" TEXT,
    "tracksInventory" BOOLEAN NOT NULL DEFAULT true,
    "availableForSale" BOOLEAN NOT NULL DEFAULT false,
    "shopifyUpdatedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscriber" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyCustomerGid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "marketingConsentState" "MarketingConsentState" NOT NULL DEFAULT 'NOT_SUBSCRIBED',
    "consentUpdatedAt" TIMESTAMPTZ(3),
    "isSuppressed" BOOLEAN NOT NULL DEFAULT false,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "currentCycleNumber" INTEGER NOT NULL DEFAULT 1,
    "nextEmailAt" TIMESTAMPTZ(3),
    "lastSuccessfulEmailAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductHistory" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "emailJobId" TEXT,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "EmailJobStatus" NOT NULL DEFAULT 'PENDING',
    "cycleNumber" INTEGER NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "runAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextRetryAt" TIMESTAMPTZ(3),
    "processingStartedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "providerMessageId" TEXT,
    "providerName" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "productSnapshot" JSONB NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmailJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailJobProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "emailJobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "shopifyProductGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL(18,2),
    "currencyCode" VARCHAR(3),
    "productUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailJobProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "emailJobId" TEXT,
    "subscriberId" TEXT,
    "type" "EmailEventType" NOT NULL,
    "providerEventId" TEXT,
    "providerMessageId" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "subscriberId" TEXT,
    "emailNormalized" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "source" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "liftedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "apiVersion" TEXT,
    "payloadHash" TEXT,
    "processedAt" TIMESTAMPTZ(3),
    "processingError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" "SyncJobType" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "cursor" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "runAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "stats" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "actorId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationSettings_shopId_key" ON "AutomationSettings"("shopId");

-- CreateIndex
CREATE INDEX "Product_shopId_eligible_deletedAt_idx" ON "Product"("shopId", "eligible", "deletedAt");

-- CreateIndex
CREATE INDEX "Product_shopId_inStock_publishedToOnlineStore_status_idx" ON "Product"("shopId", "inStock", "publishedToOnlineStore", "status");

-- CreateIndex
CREATE INDEX "Product_shopId_handle_idx" ON "Product"("shopId", "handle");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopId_shopifyProductGid_key" ON "Product"("shopId", "shopifyProductGid");

-- CreateIndex
CREATE INDEX "ProductVariant_shopId_productId_idx" ON "ProductVariant"("shopId", "productId");

-- CreateIndex
CREATE INDEX "ProductVariant_shopId_inventoryItemGid_idx" ON "ProductVariant"("shopId", "inventoryItemGid");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_shopId_shopifyVariantGid_key" ON "ProductVariant"("shopId", "shopifyVariantGid");

-- CreateIndex
CREATE INDEX "Subscriber_shopId_eligible_isSuppressed_nextEmailAt_idx" ON "Subscriber"("shopId", "eligible", "isSuppressed", "nextEmailAt");

-- CreateIndex
CREATE INDEX "Subscriber_shopId_nextEmailAt_idx" ON "Subscriber"("shopId", "nextEmailAt");

-- CreateIndex
CREATE INDEX "Subscriber_shopId_marketingConsentState_idx" ON "Subscriber"("shopId", "marketingConsentState");

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_shopId_shopifyCustomerGid_key" ON "Subscriber"("shopId", "shopifyCustomerGid");

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_shopId_emailNormalized_key" ON "Subscriber"("shopId", "emailNormalized");

-- CreateIndex
CREATE INDEX "ProductHistory_shopId_subscriberId_cycleNumber_idx" ON "ProductHistory"("shopId", "subscriberId", "cycleNumber");

-- CreateIndex
CREATE INDEX "ProductHistory_shopId_productId_idx" ON "ProductHistory"("shopId", "productId");

-- CreateIndex
CREATE INDEX "ProductHistory_emailJobId_idx" ON "ProductHistory"("emailJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductHistory_shopId_subscriberId_productId_cycleNumber_key" ON "ProductHistory"("shopId", "subscriberId", "productId", "cycleNumber");

-- CreateIndex
CREATE INDEX "EmailJob_shopId_status_runAt_idx" ON "EmailJob"("shopId", "status", "runAt");

-- CreateIndex
CREATE INDEX "EmailJob_shopId_status_nextRetryAt_idx" ON "EmailJob"("shopId", "status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "EmailJob_shopId_subscriberId_status_idx" ON "EmailJob"("shopId", "subscriberId", "status");

-- CreateIndex
CREATE INDEX "EmailJob_status_leaseExpiresAt_idx" ON "EmailJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "EmailJob_providerMessageId_idx" ON "EmailJob"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailJob_shopId_idempotencyKey_key" ON "EmailJob"("shopId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "EmailJobProduct_shopId_emailJobId_idx" ON "EmailJobProduct"("shopId", "emailJobId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailJobProduct_emailJobId_productId_key" ON "EmailJobProduct"("emailJobId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailJobProduct_emailJobId_position_key" ON "EmailJobProduct"("emailJobId", "position");

-- CreateIndex
CREATE INDEX "EmailEvent_shopId_type_occurredAt_idx" ON "EmailEvent"("shopId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_shopId_emailJobId_idx" ON "EmailEvent"("shopId", "emailJobId");

-- CreateIndex
CREATE INDEX "EmailEvent_shopId_subscriberId_idx" ON "EmailEvent"("shopId", "subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_shopId_providerEventId_key" ON "EmailEvent"("shopId", "providerEventId");

-- CreateIndex
CREATE INDEX "Suppression_shopId_active_emailNormalized_idx" ON "Suppression"("shopId", "active", "emailNormalized");

-- CreateIndex
CREATE INDEX "Suppression_shopId_subscriberId_idx" ON "Suppression"("shopId", "subscriberId");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_shopId_emailNormalized_reason_key" ON "Suppression"("shopId", "emailNormalized", "reason");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopDomain_topic_createdAt_idx" ON "WebhookEvent"("shopDomain", "topic", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopId_createdAt_idx" ON "WebhookEvent"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_shopDomain_topic_webhookId_key" ON "WebhookEvent"("shopDomain", "topic", "webhookId");

-- CreateIndex
CREATE INDEX "SyncJob_shopId_status_runAt_idx" ON "SyncJob"("shopId", "status", "runAt");

-- CreateIndex
CREATE INDEX "SyncJob_shopId_type_status_idx" ON "SyncJob"("shopId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SyncJob_shopId_idempotencyKey_key" ON "SyncJob"("shopId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_createdAt_idx" ON "AuditLog"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_entityType_entityId_idx" ON "AuditLog"("shopId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscriber" ADD CONSTRAINT "Subscriber_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductHistory" ADD CONSTRAINT "ProductHistory_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductHistory" ADD CONSTRAINT "ProductHistory_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductHistory" ADD CONSTRAINT "ProductHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductHistory" ADD CONSTRAINT "ProductHistory_emailJobId_fkey" FOREIGN KEY ("emailJobId") REFERENCES "EmailJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailJob" ADD CONSTRAINT "EmailJob_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailJobProduct" ADD CONSTRAINT "EmailJobProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailJobProduct" ADD CONSTRAINT "EmailJobProduct_emailJobId_fkey" FOREIGN KEY ("emailJobId") REFERENCES "EmailJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailJobProduct" ADD CONSTRAINT "EmailJobProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_emailJobId_fkey" FOREIGN KEY ("emailJobId") REFERENCES "EmailJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
