-- AlterTable
ALTER TABLE "AutomationSettings"
  ADD COLUMN IF NOT EXISTS "maxEmailsPerRun" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "maxEmailsPerHour" INTEGER NOT NULL DEFAULT 200;

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkerHeartbeat" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "workerType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "metrics" JSONB,
  "lastError" TEXT,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(3),
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WorkerHeartbeat_workerType_updatedAt_idx"
  ON "WorkerHeartbeat"("workerType", "updatedAt");

CREATE INDEX IF NOT EXISTS "WorkerHeartbeat_workerId_startedAt_idx"
  ON "WorkerHeartbeat"("workerId", "startedAt");

CREATE TABLE IF NOT EXISTS "DurableLock" (
  "id" TEXT NOT NULL,
  "lockedBy" TEXT,
  "lockedUntil" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DurableLock_pkey" PRIMARY KEY ("id")
);

INSERT INTO "DurableLock" ("id", "updatedAt")
VALUES ('email-scheduler', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
