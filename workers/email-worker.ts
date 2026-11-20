/**
 * Cloud Run Job / CLI entry: process reserved marketing email jobs.
 *
 * Bounded by WORKER_MAX_RUNTIME_MS, WORKER_BATCH_SIZE, WORKER_CONCURRENCY.
 * Uses PostgreSQL SKIP LOCKED claiming — safe with concurrent replicas.
 */
import { runEmailWorker } from "../app/services/email-worker.server";
import { logger } from "../app/lib/logging.server";

async function main() {
  const result = await runEmailWorker();
  logger.info("email_worker_cli_complete", {
    workerId: result.workerId,
    ...result.metrics,
  });
  if (result.metrics.errors > 0 && result.metrics.accepted === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error("email_worker_cli_fatal", {
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
