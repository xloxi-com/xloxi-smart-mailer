import type { ActionFunctionArgs } from "react-router";
import { webhookAction } from "../services/webhook-ingress.server";

export const action = async ({ request }: ActionFunctionArgs) =>
  webhookAction(request);
