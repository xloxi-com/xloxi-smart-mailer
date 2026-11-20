/**
 * Cloud Run Job / CLI entry: schedule due marketing emails.
 *
 * Cloud Scheduler (every 5 min) → HTTP `/api/jobs/scheduler` with a service
 * account, OR invoke this script as a Cloud Run Job.
 *
 * Do not use setInterval — this process exits after one bounded run.
 */
import { runEmailScheduler } from "../app/services/scheduler.server";
import { logger } from "../app/lib/logging.server";

async function main() {
  const result = await runEmailScheduler();
  logger.info("scheduler_cli_complete", {
    locked: result.locked,
    shops: result.shops.length,
    reserved: result.metrics.accepted,
    skipped: result.metrics.skipped,
    errors: result.metrics.errors,
  });
  if (result.metrics.errors > 0 && result.metrics.accepted === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error("scheduler_cli_fatal", {
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
