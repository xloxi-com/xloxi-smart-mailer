ALTER TABLE "AutomationSettings"
  ADD COLUMN IF NOT EXISTS "maxEmailsPerDay" INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS "dataRetentionDays" INTEGER NOT NULL DEFAULT 365,
  ADD COLUMN IF NOT EXISTS "emailProviderLabel" TEXT NOT NULL DEFAULT 'dry_run',
  ADD COLUMN IF NOT EXISTS "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 360,
  ADD COLUMN IF NOT EXISTS "sendingEmailAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "excludedCollectionGids" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "excludedFromAutomation" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Product_shopId_excludedFromAutomation_idx"
  ON "Product"("shopId", "excludedFromAutomation");

ALTER TABLE "Subscriber"
  ADD COLUMN IF NOT EXISTS "paused" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Subscriber_shopId_paused_idx"
  ON "Subscriber"("shopId", "paused");
