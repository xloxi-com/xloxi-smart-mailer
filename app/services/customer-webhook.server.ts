export function extractCustomerGidFromWebhookPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.admin_graphql_api_id === "string") {
    return body.admin_graphql_api_id;
  }
  if (typeof body.id === "number" || typeof body.id === "string") {
    return `gid://shopify/Customer/${body.id}`;
  }
  return null;
}

export function extractEmailFromWebhookPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.email === "string") return body.email;
  return null;
}
