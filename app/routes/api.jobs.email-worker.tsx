import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authorizeJobsRequest } from "../lib/jobs-auth.server";
import { logger } from "../lib/logging.server";
import { runEmailWorker } from "../services/email-worker.server";

/**
 * Cloud Run Job / Scheduler target for bounded email delivery workers.
 */
async function run(request: Request) {
  if (!authorizeJobsRequest(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const batchSize = Number(url.searchParams.get("batchSize") || "") || undefined;
  const concurrency =
    Number(url.searchParams.get("concurrency") || "") || undefined;
  const maxRuntimeMs =
    Number(url.searchParams.get("maxRuntimeMs") || "") || undefined;

  const result = await runEmailWorker({
    batchSize,
    concurrency,
    maxRuntimeMs,
  });
  logger.info("api_jobs_email_worker", {
    workerId: result.workerId,
    ...result.metrics,
  });
  return Response.json(result);
}

export const loader = async ({ request }: LoaderFunctionArgs) => run(request);
export const action = async ({ request }: ActionFunctionArgs) => run(request);
