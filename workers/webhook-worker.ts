/**
 * Cloud Run Job / CLI entry: process due Shopify webhook events.
 *
 * Bounded batch — exits after one tick (no setInterval).
 */
import { processDueWebhookEvents } from "../app/jobs/webhook-processor.server";
import { logger } from "../app/lib/logging.server";

async function main() {
  const limit = Math.max(
    1,
    Math.min(Number(process.env.WEBHOOK_WORKER_BATCH_SIZE ?? "25"), 100),
  );
  const result = await processDueWebhookEvents({ limit });
  logger.info("webhook_worker_cli_complete", result);
  if (result.failed > 0 && result.succeeded === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error("webhook_worker_cli_fatal", {
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
