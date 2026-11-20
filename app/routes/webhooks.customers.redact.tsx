import type { ActionFunctionArgs } from "react-router";
import { webhookAction } from "../services/webhook-ingress.server";

/** Mandatory compliance: customers/redact */
export const action = async ({ request }: ActionFunctionArgs) =>
  webhookAction(request);
