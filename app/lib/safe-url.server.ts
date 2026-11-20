/**
 * Allow only http(s) absolute URLs for email HTML attributes.
 * Blocks javascript:, data:, and other schemes that escapeAttr alone cannot stop.
 */
export function sanitizeHttpUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
