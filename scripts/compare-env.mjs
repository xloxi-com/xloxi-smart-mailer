import fs from "node:fs";
import crypto from "node:crypto";

function parse(path) {
  const out = {};
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function hash(s) {
  return crypto
    .createHash("sha256")
    .update(s || "")
    .digest("hex")
    .slice(0, 12);
}

const local = parse(".env");
const prod = parse(".env.vercel.prod");
const keys = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
  "DATABASE_URL",
  "DIRECT_URL",
];

for (const k of keys) {
  const l = local[k] || "";
  const p = prod[k] || "";
  const row = {
    key: k,
    same: l === p,
    localHash: hash(l),
    prodHash: hash(p),
    localLen: l.length,
    prodLen: p.length,
  };
  if (
    k.includes("URL") ||
    k === "SCOPES" ||
    k === "SHOPIFY_API_KEY"
  ) {
    row.local = l.slice(0, 80);
    row.prod = p.slice(0, 80);
  }
  console.log(JSON.stringify(row));
}
