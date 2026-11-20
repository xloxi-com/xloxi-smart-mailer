-- At most one active marketing email job per subscriber (final concurrency safeguard).
CREATE UNIQUE INDEX "EmailJob_one_active_per_subscriber_idx"
ON "EmailJob" ("shopId", "subscriberId")
WHERE status IN ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'UNKNOWN');
