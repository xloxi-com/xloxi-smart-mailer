import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authorizeJobsRequest } from "../lib/jobs-auth.server";
import { logger } from "../lib/logging.server";
import { runEmailScheduler } from "../services/scheduler.server";

/**
 * Cloud Scheduler target (every 5 minutes).
 * Authenticate with JOBS_SHARED_SECRET / OIDC service account.
 */
async function run(request: Request) {
  if (!authorizeJobsRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await runEmailScheduler();
  logger.info("api_jobs_scheduler", {
    locked: result.locked,
    reserved: result.metrics.accepted,
    workerId: result.workerId,
  });
  return Response.json(result);
}

export const loader = async ({ request }: LoaderFunctionArgs) => run(request);
export const action = async ({ request }: ActionFunctionArgs) => run(request);
