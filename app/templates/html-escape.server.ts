/** Escape untrusted values for HTML email bodies and attributes. */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/** Strip control characters for plain-text email parts. */
export function sanitizePlainText(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentional control-char strip for email text
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}
