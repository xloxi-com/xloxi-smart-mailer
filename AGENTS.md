# AGENTS.md — XLOXI Smart Product Mailer

**App:** XLOXI Smart Product Mailer  
**Developer:** XLOXI PVT LTD  
**Target store:** https://seductiv.net/ (Shopify Basic)  
**Repo root:** this directory (`xloxi-smart-mailer`)

## Mission

Build a production-ready Shopify **embedded** app that emails eligible marketing-subscribed customers every **3 days** with up to **6 random eligible products**, never repeating a product for the same customer within a product cycle, then starting a new cycle when the eligible catalog for that customer is exhausted.

## Non-negotiable rules

1. **Inspect before changing.** Read existing files; reuse official Shopify auth/session (`app/shopify.server.ts`, Prisma `Session`).
2. **Verify Shopify APIs.** Use Shopify AI Toolkit / Admin GraphQL docs. Never invent endpoints or fields.
3. **Shopify Basic only.** No Shopify Plus, paid Flow actions, n8n, or Messaging custom-send APIs.
4. **Shop isolation.** All app data keyed by `shop` / `shopId`. Never cross shops.
5. **Secrets stay server-side.** Never log customer emails, access tokens, API keys, or provider secrets.
6. **Email sending OFF by default.** `EMAIL_SENDING_ENABLED=false` with DryRun/Mock providers until an approved ESP adapter exists (`docs/EMAIL_PROVIDER.md`).
7. **No deploy / no real sends** without explicit human approval.
8. **Do not delete working features** unless replacing them in a planned phase.
9. **Strict TypeScript**, modular production code, validation, error handling, and Vitest for every feature.
10. **Follow** `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION_PLAN.md`. Do not skip phases or implement later phases early unless asked.

## Stack (locked)

| Layer | Choice |
| --- | --- |
| App template | Official Shopify React Router TypeScript |
| Admin UI | App Bridge + current Polaris web components |
| Shopify API | Admin GraphQL (pin via `ApiVersion` in `shopify.server.ts`) |
| DB | Supabase PostgreSQL + Prisma |
| Jobs | PostgreSQL-backed durable queue (SKIP LOCKED / pg-boss-style) |
| Runtime | Google Cloud Run |
| Schedule | Google Cloud Scheduler → authenticated cron HTTP |
| Email | Pluggable provider interface (default: disabled / NoOp) |
| Tests | Vitest |

## Current baseline (inspected)

- Scaffold: `@shopify/shopify-app-react-router` + Prisma session storage.
- DB: **PostgreSQL** via `DATABASE_URL` (Supabase); `Session` model for offline jobs.
- Distribution: **Custom** → `AppDistribution.SingleMerchant` (App Bridge preserved).
- Scopes: `read_products,read_inventory,read_customers,write_customers`.
- API: Admin GraphQL **2026-10** (`ApiVersion.October26`).
- Auth helpers: `app/shopify/auth.server.ts`, offline admin, GraphQL retry/throttle.
- PCD: `docs/PROTECTED_CUSTOMER_DATA.md`.

## Agent workflow

1. Read `docs/ARCHITECTURE.md` for domain model, eligibility, jobs, and safety.
2. Execute only the **active phase** in `docs/IMPLEMENTATION_PLAN.md`.
3. After code changes: typecheck, lint, Vitest for touched modules.
4. For Shopify GraphQL: search/validate against the project’s pinned Admin API version.
5. Prefer small, reviewable PRs per phase checklist item.

## Safety checklist (every PR)

- [ ] No real email send unless `EMAIL_SENDING_ENABLED=true` **and** provider configured **and** user approved
- [ ] Idempotent sends (unique constraints / idempotency keys)
- [ ] Concurrent job protection (locks / SKIP LOCKED)
- [ ] Unsubscribe / non-`SUBSCRIBED` customers never receive mail
- [ ] No secrets or PII in logs (webhook `safePayload` = GIDs/state only)
- [ ] Webhooks: HMAC via `authenticate.webhook`, dedupe by delivery id, fast 200 + durable jobs
- [ ] Shop-scoped queries only

## Docs map

| Doc | Purpose |
| --- | --- |
| `docs/ARCHITECTURE.md` | System design, data model, APIs, jobs, deployment |
| `docs/IMPLEMENTATION_PLAN.md` | Phased delivery; **Phase 0 = architecture only (done when docs land)** |
| `.cursor/rules/project.mdc` | Always-on Cursor rules for this repo |
