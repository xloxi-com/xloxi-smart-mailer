/**
 * XLOXI customer tag + metafield bridge for Shopify Flow / Messaging.
 * App never sends email — Messaging is the only delivery channel.
 */
export const XLOXI_TAG_REQUEST = "xloxi-request";
export const XLOXI_TAG_READY = "xloxi-ready";
export const XLOXI_TAG_PICK_PREFIX = "xloxi-pick:";

export const XLOXI_METAFIELD_NAMESPACE = "xloxi";

export const XLOXI_METAFIELD_KEYS = {
  pendingBatchId: "pending_batch_id",
  processedBatchId: "processed_batch_id",
  lastProcessedAt: "last_processed_at",
  nextSelectionAt: "next_selection_at",
} as const;

export type XloxiMetafieldKey =
  (typeof XLOXI_METAFIELD_KEYS)[keyof typeof XLOXI_METAFIELD_KEYS];

export function pickTagForHandle(handle: string): string {
  return `${XLOXI_TAG_PICK_PREFIX}${handle.trim().toLowerCase()}`;
}

export function extractHandleFromPickTag(tag: string): string | null {
  const normalized = tag.trim().toLowerCase();
  if (!normalized.startsWith(XLOXI_TAG_PICK_PREFIX)) return null;
  const handle = normalized.slice(XLOXI_TAG_PICK_PREFIX.length).trim();
  return handle || null;
}

export function isXloxiAutomationTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return (
    t === XLOXI_TAG_REQUEST ||
    t === XLOXI_TAG_READY ||
    t.startsWith(XLOXI_TAG_PICK_PREFIX)
  );
}

export function listCompletedSelectionTags(tags: string[]): string[] {
  return tags.filter((tag) => {
    const t = tag.trim().toLowerCase();
    return t === XLOXI_TAG_READY || t.startsWith(XLOXI_TAG_PICK_PREFIX);
  });
}

export function hasRequestTag(tags: string[]): boolean {
  return tags.some((t) => t.trim().toLowerCase() === XLOXI_TAG_REQUEST);
}

export function hasReadyTag(tags: string[]): boolean {
  return tags.some((t) => t.trim().toLowerCase() === XLOXI_TAG_READY);
}
