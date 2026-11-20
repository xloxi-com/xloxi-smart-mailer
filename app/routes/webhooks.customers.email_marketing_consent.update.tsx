import type { ActionFunctionArgs } from "react-router";
import { webhookAction } from "../services/webhook-ingress.server";

/** Topic: customers_email_marketing_consent/update (API 2026-10). */
export const action = async ({ request }: ActionFunctionArgs) =>
  webhookAction(request);
