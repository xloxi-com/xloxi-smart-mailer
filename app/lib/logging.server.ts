type LogFields = Record<string, unknown>;

const REDACT_KEYS = new Set([
  "email",
  "emailNormalized",
  "to",
  "accessToken",
  "refreshToken",
  "apiKey",
  "apiSecret",
  "password",
  "authorization",
  "token",
  "secret",
  "unsubscribeToken",
  "unsubscribeUrl",
  "rawBody",
]);

function keyLooksSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  if (REDACT_KEYS.has(key) || REDACT_KEYS.has(lower)) return true;
  return (
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("authorization") ||
    lower.endsWith("email") ||
    lower === "to"
  );
}

function sanitize(value: unknown, key?: string): unknown {
  if (key && keyLooksSensitive(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v, k);
    }
    return out;
  }
  return value;
}

function write(level: "info" | "warn" | "error", message: string, fields?: LogFields) {
  const payload = {
    level,
    message,
    time: new Date().toISOString(),
    ...(fields ? (sanitize(fields) as LogFields) : {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};
