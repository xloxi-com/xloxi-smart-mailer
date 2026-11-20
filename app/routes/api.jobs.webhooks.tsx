import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { processDueWebhookEvents } from "../jobs/webhook-processor.server";
import { authorizeJobsRequest } from "../lib/jobs-auth.server";
import { logger } from "../lib/logging.server";

/**
 * Internal worker tick for durable webhook jobs.
 * Protect with JOBS_SHARED_SECRET / Cloud Scheduler OIDC.
 */
async function run(request: Request) {
  if (!authorizeJobsRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await processDueWebhookEvents({
    limit: 50,
    leaseOwner: "api.jobs.webhooks",
  });
  logger.info("webhook_worker_tick", result);
  return Response.json(result);
}

export const loader = async ({ request }: LoaderFunctionArgs) => run(request);
export const action = async ({ request }: ActionFunctionArgs) => run(request);
