# Implementation Plan — XLOXI Smart Product Mailer

**Principle:** Complete one phase fully (code + tests + checklist) before starting the next.  
**Current phase:** **Phase 1 — Foundation (auth slice in progress).**

---

## Phase overview

| Phase | Name | Outcome |
| --- | --- | --- |
| **0** | Architecture & agent rules | Docs + Cursor rules; no feature code |
| **1** | Foundation | Postgres/Supabase, scopes, settings models, safety flags |
| **2** | Shopify sync | Product/customer/inventory mirrors + webhooks + reconcile |
| **3** | Cycle & selection | Algorithm + Vitest; no real email |
| **4** | Job queue & cadence | Durable jobs, cron tick, idempotency/locks |
| **5** | Email provider | Plugin + NoOp default; template rendering |
| **6** | Admin UI | Polaris dashboard/settings (replace demo gradually) |
| **7** | Cloud Run / Scheduler | Deploy plumbing (still no real sends without approval) |
| **8** | Hardening | Compliance, load tests, App Store prep |

---

## Phase 0 — Architecture (ACTIVE / COMPLETE WHEN DOCS LAND)

### Deliverables

- [x] Inspect existing React Router Shopify template
- [x] Verify Admin GraphQL consent + product concepts against official docs
- [x] `AGENTS.md`
- [x] `.cursor/rules/project.mdc`
- [x] `docs/ARCHITECTURE.md`
- [x] `docs/IMPLEMENTATION_PLAN.md`

### Explicitly out of scope

- Prisma schema changes beyond planning
- Scope changes in `shopify.app.toml`
- Job/email/UI implementation
- Deploy, Cloud Scheduler, real email

### Exit criteria

Stakeholders can approve architecture; engineering waits for “start Phase 1”.

---

## Phase 1 — Foundation

### Goals

- [x] Switch Prisma datasource to **PostgreSQL** (Supabase `DATABASE_URL` + `DIRECT_URL`).
- [x] Keep official `Session` model compatible with `@shopify/shopify-app-session-storage-prisma`.
- [x] Add full domain models (`Shop`, `AutomationSettings`, catalog, subscribers, jobs, …).
- [x] Auth helpers, scopes, API 2026-10, PCD docs, `.env.example`.
- [ ] Introduce provider factory stub beyond env flag (email phase).
- [x] Update `shopify.app.toml` scopes; align Admin API version pin.

### Planned scopes

```toml
scopes = "read_products,read_inventory,read_customers,write_customers"
```

`write_customers` is required for unsubscribe / consent synchronization.

### Tests

- Env parsing / flag defaults
- Shop isolation helper unit tests

### Exit criteria

App boots against Supabase Postgres locally; sessions still work; no mailer behavior yet.

---

## Phase 2 — Shopify synchronization

### Goals

- `ProductMirror` + `CustomerMirror` models and upsert services.
- Webhooks (2026-10): products CRUD, inventory_levels/update, customers CRUD, `customers_email_marketing_consent/update`, uninstall, scopes_update, compliance topics. Fast HMAC ack + durable `WebhookEvent` processor with retries.
- Eligibility computation for products and customers (see Architecture §4).
- `shop.reconcile` job (may be invoked manually/admin before queue is full).
- Cursor pagination; never assume catalog size.

### GraphQL (illustrative — validate at implement time)

- Products: `status`, publication/online store filters, inventory fields with `read_inventory`.
- Customers: `email`, `emailMarketingConsent { marketingState }`.

### Tests

- Eligibility pure functions (fixtures for ACTIVE/draft, published/unpublished, stock/untracked).
- Consent gate (`SUBSCRIBED` only).
- Webhook HMAC path uses official authenticate.webhook.

### Exit criteria

Mirrors stay fresh under webhook + reconcile; eligible counts visible in logs/metrics (no PII).

---

## Phase 3 — Product cycles & selection

### Goals

- `ProductCycle`, `CycleProductSend` models.
- Selection service: random up to 6, no repeats in cycle, rollover, remainder &lt; 6.
- SQL-friendly selection for large catalogs (avoid loading entire catalog into Node when possible).

### Tests (critical)

- Exhaustion → new cycle
- Remainder sends
- Independence across customers
- Ineligible products excluded mid-cycle
- Deterministic tests via seeded RNG injection

### Exit criteria

Pure domain logic green in Vitest; no provider calls.

---

## Phase 4 — Durable jobs & 3-day cadence

### Goals

- Postgres job table (or pg-boss) with `SKIP LOCKED` claiming.
- Job types: `shop.reconcile`, scheduler (`/api/jobs/scheduler`), email worker (`/api/jobs/email-worker`) — see `docs/JOBS_AND_SCHEDULER.md`.
- `/api/cron/tick` authenticated endpoint (secret/OIDC).
- Idempotency keys + unique constraints; cancel jobs on unsubscribe.
- Bounded batch processing for Cloud Run timeouts.

### Tests

- Double-claim impossible under concurrency (integration).
- Due customer selection respects 3-day cadence.
- Duplicate `EmailSend` rejected by unique key.
- Unsubscribe cancels/skips pending send.

### Exit criteria

Local cron tick schedules and processes jobs end-to-end with NoOp email.

---

## Phase 5 — Email sending (disabled by default)

### Goals

- `EmailProvider` interface + DryRun/Mock + delivery/unsubscribe services (`docs/EMAIL_PROVIDER.md`).
- HTML/text template for 6-product grid (Polaris not required in email HTML).
- Wire `customer.send_email` → create `EmailSend` → provider only if flags allow.
- Redacted logging.

### Tests

- Flag matrix: sending disabled → NoOp always.
- Skip when consent lost.
- Template renders required product fields from mirror snapshots.

### Exit criteria

Dry-run pipeline complete; **no real provider credentials required**.

---

## Phase 6 — Embedded Admin UI

### Goals

- Replace template demo gradually with Polaris web components + App Bridge.
- Pages: Home (health, eligible products/subscribers counts), Settings (enable mailer, cadence display), Activity (send counts, failures).
- Manual “Reconcile now” / “Run schedule (dry)” actions for merchants/devs.
- Preserve auth boundaries via `authenticate.admin`.

### Tests

- Loader/action authorization failures
- Settings validation

### Exit criteria

Merchant can understand status without leaving Admin; demo product-create removed or moved behind dev-only flag.

---

## Phase 7 — Google Cloud Run & Scheduler

### Goals

- Production Dockerfile/env for Cloud Run.
- Cloud Scheduler → `/api/cron/tick` with OIDC or strong secret.
- Secrets in Secret Manager / Cloud Run env (not in git).
- Runbook: migrate, smoke test with `EMAIL_SENDING_ENABLED=false`.

### Exit criteria

Staging deploy processes dry-run jobs; **real email and prod cutover still require explicit approval**.

---

## Phase 8 — Hardening & launch readiness

### Goals

- GDPR webhooks fully tested; uninstall cleanup.
- Rate-limit backoff; optional Bulk Operations for huge shops.
- Security review: scopes, logging, RLS-style shop filters.
- App Store listing copy / privacy policy hooks (content outside this repo as needed).
- Load test job throughput.

### Exit criteria

Checklist signed for production enablement of email (separate approval).

---

## Cross-phase rules (always)

1. No inventing Shopify APIs — search/validate docs.
2. No real emails or production deploys without explicit user approval.
3. Do not skip Vitest for new domain logic.
4. Do not break existing session auth.
5. Prefer additive migrations; shop-scope every table.
6. Update this plan’s checkboxes when a phase completes.

---

## Suggested first command after Phase 0 approval

> “Start Phase 1 — Foundation (Supabase Postgres, scopes, settings, email flags).”

Until then: **architecture only — no implementation.**
