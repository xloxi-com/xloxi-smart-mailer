# Architecture — XLOXI Smart Product Mailer

**Status:** Phase 1 auth foundation in progress  
**App:** XLOXI Smart Product Mailer · XLOXI PVT LTD  
**Store:** https://seductiv.net/ · Shopify plan: **Basic**  
**Codebase:** official Shopify React Router TypeScript template under `xloxi-smart-mailer/`

---

## 1. Goals

| Goal | Behavior |
| --- | --- |
| Cadence | Every **3 days**, send one marketing email to each eligible subscribed customer |
| Catalog pick | Up to **6 random** eligible products per email |
| No repeats in cycle | Same customer never receives the same product twice in one **product cycle** |
| Cross-customer OK | Different customers may receive the same products |
| Cycle rollover | When a customer has exhausted all eligible products in the current cycle, start a **new cycle** and continue |
| Remainder | If fewer than 6 unsent eligible products remain, send only those |
| Eligibility | Active + Online Store published + in stock; marketing consent `SUBSCRIBED` |
| Sync | Products, inventory, and consent stay current via webhooks + periodic reconciliation |
| Scale | Unknown catalog size; large subscriber lists — cursor pagination, batched jobs |
| Unsubscribe | Stop sends immediately when consent is no longer `SUBSCRIBED` |
| Safety | No duplicate emails, no concurrent double-sends, email disabled by default |

**Out of scope for v1:** Shopify Plus features, n8n, paid Flow actions, assuming Shopify Messaging custom send API, multi-channel SMS, A/B content experiments.

---

## 2. Current repository baseline

| Area | Today | Target |
| --- | --- | --- |
| Framework | React Router 7 + `@shopify/shopify-app-react-router` | Keep |
| Auth / sessions | Prisma `Session` + `authenticate.admin` / webhooks | Keep; move DB to Postgres |
| Database | SQLite `file:dev.sqlite` | Supabase PostgreSQL |
| Scopes | `write_products`, metaobject writes (template) | Mailer read scopes (below) |
| API version | `ApiVersion.October26` in `shopify.server.ts`; toml webhooks `2026-10` | Keep code + toml aligned |
| UI | Template product-create demo | Merchant dashboard (settings, runs, health) |
| Jobs / email | None | Postgres queue + pluggable email |
| Deploy | `Dockerfile` present | Google Cloud Run + Cloud Scheduler |

---

## 3. High-level system diagram

```text
┌─────────────────────┐     OIDC / shared secret      ┌──────────────────────────┐
│ Google Cloud        │ ─────────────────────────────►│ Cloud Run (app)          │
│ Scheduler (cron)    │   POST /api/cron/tick         │ React Router server      │
└─────────────────────┘                               │  · Admin UI loaders      │
                                                      │  · Webhooks              │
┌─────────────────────┐   Admin GraphQL + webhooks    │  · Cron + job workers    │
│ Shopify Admin       │ ◄────────────────────────────►│                          │
│ (seductiv.net)      │                               └────────────┬─────────────┘
└─────────────────────┘                                            │
                                                                   │ Prisma
                                                                   ▼
                                                      ┌──────────────────────────┐
                                                      │ Supabase PostgreSQL      │
                                                      │  · Session               │
                                                      │  · Shop / sync mirrors   │
                                                      │  · Cycles / sends        │
                                                      │  · Job queue            │
                                                      └──────────────────────────┘
                                                                   │
                                                      ┌────────────▼─────────────┐
                                                      │ EmailProvider (pluggable)│
                                                      │  NoOp (default)          │
                                                      │  + future SMTP/API       │
                                                      └──────────────────────────┘
```

---

## 4. Shopify Admin API contract (verified)

Pinned Admin GraphQL version: **2026-10** (`ApiVersion.October26` in `app/shopify.server.ts` and `shopify.app.toml` webhooks).

**Distribution:** Custom (Partner Dashboard) → `AppDistribution.SingleMerchant` (OAuth + App Bridge). Not `ShopifyAdmin` merchant-token apps.

**Protected customer data:** see `docs/PROTECTED_CUSTOMER_DATA.md`.

### 4.1 Access scopes (Basic-compatible)

| Scope | Why |
| --- | --- |
| `read_products` | Product status, publication, media, variants |
| `read_inventory` | Inventory quantities / levels for in-stock checks |
| `read_customers` | `emailMarketingConsent` (required by Admin API for consent objects) |
| `write_customers` | Unsubscribe / marketing consent synchronization |

Prefer **least privilege**. Re-auth merchants after scope changes.

**Not required for Basic mailer:** Plus-only APIs, Flow paid actions, Marketing Activities send APIs as the primary transport.

### 4.2 Customer eligibility (consent)

Use Customer fields (requires `read_customers`):

- `id`, `email` (presence required)
- `emailMarketingConsent.marketingState` → only **`SUBSCRIBED`**
- Treat `UNSUBSCRIBED`, `NOT_SUBSCRIBED`, `PENDING`, `INVALID`, `REDACTED` as **ineligible**
- On any non-`SUBSCRIBED` transition: mark local subscriber inactive and **cancel pending send jobs** for that customer

Docs: [CustomerEmailMarketingConsentState](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/CustomerEmailMarketingConsentState), [CustomerEmailMarketingState](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/CustomerEmailMarketingState).

**Filter strategy:** paginate `customers` with query filters where supported (e.g. email marketing subscribed), then re-check consent at send time (defense in depth).

### 4.3 Product eligibility

A product is **eligible** when all are true:

1. **`status` = `ACTIVE`** (Shopify only displays ACTIVE products in online stores).
2. **Published to Online Store** — use product search/filter `published_status:published` / online-store channel publication, and/or fields such as `publishedAt` / publication membership. Prefer server-side filters + local mirror flags.
3. **In stock** — at least one sellable path with available inventory:
   - Prefer aggregate / variant inventory (`totalInventory` or variant `inventoryQuantity` / inventory levels via `read_inventory`).
   - Variants that **do not track inventory** are treated as available (standard Shopify behavior).
   - Continuously tracked variants need available quantity **> 0**.

Exclude drafts, archived, unpublished, and zero-stock tracked products.

### 4.4 Sync & webhooks

Declarative subscriptions in `shopify.app.toml` (plus compliance topics for App Store):

| Topic | Purpose |
| --- | --- |
| `app/uninstalled` | Stop automation, cancel jobs, delete sessions |
| `app/scopes_update` | Refresh stored offline scopes |
| `products/create`, `products/update`, `products/delete` | Product mirror |
| `inventory_levels/update` | Stock eligibility |
| `customers/create`, `customers/update`, `customers/delete` | Consent + subscriber mirror |
| `customers_email_marketing_consent/update` | Marketing consent (re-fetch Customer) |
| `customers/data_request`, `customers/redact`, `shop/redact` | GDPR / compliance |

Verified for Admin API **2026-10** (`WebhookSubscriptionTopic`). Declared in `shopify.app.toml` with `api_version = "2026-10"`.

**Ingress path:** `authenticate.webhook` (HMAC) → dedupe on `X-Shopify-Webhook-Id` → store `WebhookEvent` (PENDING + safe metadata only) → HTTP 200 → async `webhook-processor` (retries/backoff, authoritative GraphQL refresh). Worker tick: `GET/POST /api/jobs/webhooks`.

**Reconciliation:** nightly (or Scheduler-driven) full/cursor sync jobs repair missed webhooks. Webhooks are hints; **DB eligibility flags are authoritative for selection**, refreshed from Shopify.

Bulk operations: for large catalogs/customers, use Admin GraphQL pagination cursors; consider Bulk Operations API in a later scale phase if rate limits bind.

---

## 5. Domain model (Supabase / Prisma)

All business tables include `shop` (myshopify domain) or `shopId` FK. Unique indexes are **shop-scoped**.

### 5.1 Core entities (implemented in `prisma/schema.prisma`)

```text
Session                 # Shopify offline/online OAuth sessions
Shop                    # shopDomain unique, UTC timestamps
AutomationSettings      # 1:1 Shop; defaults: automationEnabled=false,
                        # intervalDays=3, productsPerEmail=6, randomSelection,
                        # inStockOnly, preventDuplicates, autoResetCycle, dryRun=true
Product / ProductVariant
Subscriber              # customer GID, email, consent, suppression, cycle, next/last email
ProductHistory          # UNIQUE (shopId, subscriberId, productId, cycleNumber)
EmailJob                # statuses PENDING|PROCESSING|RETRY_SCHEDULED|ACCEPTED|
                        # FAILED|CANCELLED|UNKNOWN; idempotencyKey; leases; retries;
                        # providerMessageId; immutable productSnapshot JSON
EmailJobProduct         # immutable line-item snapshot rows for a job batch
EmailEvent / Suppression / WebhookEvent / SyncJob / AuditLog
```

All business tables FK to `Shop` (shop-level isolation). Timestamps use `TIMESTAMPTZ` (UTC).

### 5.2 Job queue tables (PostgreSQL-backed)

Durable queue: `EmailJob` claimed with **`FOR UPDATE SKIP LOCKED`**, leases, dead-letter, and Cloud Scheduler → `/api/jobs/*` (see `docs/JOBS_AND_SCHEDULER.md`). Requirements:

- `id`, `shop`, `type`, `payload`, `runAt`, `status`, `attempts`, `lockedAt`, `lockedBy`, `idempotencyKey`
- Unique `(shop, type, idempotencyKey)` where applicable
- Dead-letter after N attempts with merchant-visible failure counts

**Job types (v1):**

| Type | Role |
| --- | --- |
| `shop.reconcile` | Sync products + customers for one shop |
| `shop.schedule_due_customers` | Find customers due (≥ cadenceDays since `lastEmailAt`) and enqueue sends |
| `customer.send_email` | Select products, create `EmailSend`, call provider |
| `shop.compliance_*` | GDPR handlers |

---

## 6. Product cycle & selection algorithm

Per customer, within a shop:

1. Ensure an open `ProductCycle` exists; if last cycle completed, create `cycleNumber + 1`.
2. Load eligible product GIDs from `ProductMirror` where `eligible = true`.
3. Subtract products already in `CycleProductSend` for the **current** cycle.
4. Let `remaining = eligible \ alreadySentInCycle`.
5. If `remaining` is empty → complete cycle, open new cycle, recompute `remaining` (= all currently eligible).
6. Sample `k = min(6, remaining.length)` products **uniformly at random without replacement**.
7. Persist selection + send atomically with the `EmailSend` row (transaction).
8. If after send `remaining - selected` is empty, mark cycle completed (next send starts a new cycle).

**Notes:**

- Catalog growth mid-cycle: new eligible products become part of `remaining` for the open cycle (they were never sent in this cycle).
- Products that become ineligible after selection but before send: drop them and optionally top-up from remaining, or skip/reduce count; never send ineligible SKUs.
- Different customers have independent cycles and independent random draws.

---

## 7. Cadence, idempotency, concurrency

### 7.1 Cadence

- Default: **3 days** since `CustomerMirror.lastEmailAt` (or since install enrollment if never sent).
- Cloud Scheduler invokes `/api/cron/tick` frequently (e.g. every 15–60 minutes). Tick only **enqueues** work; workers process due customers.
- Merchant timezone optional for “local morning” later; v1 uses UTC timestamps.

### 7.2 Idempotency

- `EmailSend.idempotencyKey` = hash(`shop|customerGid|cycleId|cadenceBucket`) where `cadenceBucket = floor(lastEmailAt or epoch / cadence)`.
- Unique constraint prevents duplicate rows.
- Provider calls only after row transitions `pending → sending` with conditional update (`WHERE status = pending`).

### 7.3 Concurrency

- Job claim: `UPDATE ... SET status='running', lockedBy=$worker WHERE id IN (SELECT id FROM job WHERE ... FOR UPDATE SKIP LOCKED)`.
- One active `customer.send_email` per customer (unique running job key).
- Shop-level advisory lock optional for `shop.schedule_due_customers`.

### 7.4 Unsubscribe race

At the start of `customer.send_email`:

1. Re-read `CustomerMirror.marketingState` (and optionally live Shopify consent if recently stale).
2. If not `SUBSCRIBED` → mark send `skipped`, cancel future jobs, do not call provider.

---

## 8. Email provider plugin

See **`docs/EMAIL_PROVIDER.md`** (SPF/DKIM/DMARC, approval gates). Interface in `app/services/email-provider.server.ts`:

`sendMarketingEmail` · `getMessageStatus` · `verifyWebhook` · `processDeliveryEvent` · `synchronizeSuppression`

| Provider | When |
| --- | --- |
| `DryRunEmailProvider` | Default when `EMAIL_SENDING_ENABLED=false` |
| `MockEmailProvider` | Tests / `EMAIL_PROVIDER=mock` |
| `UnapprovedEmailProvider` | Live flag on but no approved ESP adapter |
| Real ESP adapter | Only after documented category support + `EMAIL_PROVIDER_APPROVED=true` |

**Flags:** `EMAIL_SENDING_ENABLED=false` (default), test allowlist, signed `/api/unsubscribe`, provider webhooks at `/api/email/events`. Ambiguous sends → `UNKNOWN` + reconcile via `getMessageStatus` (no blind retry). Independent `Suppression` list; never mail suppressed recipients. Shopify Messaging APIs are **not** used.

---

## 9. Application modules (target layout)

```text
app/
  shopify.server.ts          # official auth (keep)
  db.server.ts               # Prisma client
  routes/
    app.*.tsx                # Polaris embedded UI
    webhooks.*.tsx           # Shopify webhooks
    api.cron.tick.ts         # Scheduler entry (HMAC/OIDC)
    api.jobs.worker.ts       # optional internal worker tick
  services/
    shops/
    products/                # sync + eligibility
    customers/               # consent sync
    cycles/                  # selection algorithm
    sends/                   # EmailSend lifecycle
  jobs/
    queue.ts
    processors/
  services/
    email-provider.server.ts
    email-delivery.server.ts
    unsubscribe.server.ts
  providers/
    mock.server.ts
    dry-run.server.ts
    unapproved.server.ts
  templates/
    product-email.server.ts  # SEDUCTIV HTML+text (table/inline CSS; no send)
  routes/
    app.email-preview.tsx    # Authenticated desktop/mobile preview
  shopify/
    admin/                   # typed GraphQL operations
  lib/
    crypto.ts                # email at-rest helpers
    logging.ts               # PII-safe logger
tests/                       # Vitest
docs/
```

Admin UI (Polaris web components + App Bridge): dashboard (last run, next due, eligible counts), settings (enable mailer, provider status read-only), recent sends (counts only / redacted), sync health.

---

## 10. Runtime: Cloud Run + Scheduler

| Piece | Design |
| --- | --- |
| Cloud Run | Container from existing `Dockerfile`; min instances optional; concurrency tuned for Node |
| Env | `DATABASE_URL` (Supabase), Shopify keys, `CRON_SECRET` or GCP OIDC audience, email flags |
| Scheduler | HTTP cron → `/api/cron/tick` with auth header / OIDC |
| Workers | Same service: cron tick processes a bounded batch of jobs per invocation (simpler than separate worker service for v1) |
| Timeouts | Keep job batches small enough for Cloud Run request timeout; chain via `runAt` requeue |

**Local dev:** `shopify app dev` + Supabase local or remote Postgres; Scheduler mocked by `npm run jobs:tick`.

---

## 11. Security & compliance

- Offline access tokens only in Prisma `Session`; never client-exposed.
- Encrypt customer email at rest if stored; index `emailHash` for lookups.
- Logs: shop domain, GIDs, job ids, status codes — **never** raw email, tokens, secrets.
- GDPR webhooks: redact `CustomerMirror` PII; retain anonymous aggregates if needed.
- App uninstall: cancel jobs, mark shop uninstalled, retain only what policy requires.

---

## 12. Testing strategy (Vitest)

| Layer | Coverage |
| --- | --- |
| Unit | Eligibility predicates, random selection without replacement, cycle rollover, cadence due checks |
| Unit | Idempotency key stability, unsubscribe skip path |
| Integration | Job claim SKIP LOCKED (test DB), Prisma transactions for send+cycle rows |
| Contract | GraphQL document fixtures validated against Shopify schema when possible |
| UI | Light loader/action tests; no real Shopify network in CI |

CI must never send real email (`EMAIL_SENDING_ENABLED=false`).

---

## 13. Observability

- Metrics counters: jobs processed, sends succeeded/skipped/failed, sync lag.
- Structured logs with `shop`, `jobType`, `jobId` (no PII).
- Merchant-facing: last successful sync, last schedule run, failure banner.

---

## 14. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Webhook gaps | Reconciliation jobs |
| Rate limits | Backoff, smaller pages, Bulk Ops later |
| Double send | DB uniques + conditional status updates |
| Consent lag | Re-check at send; webhook priority |
| Huge catalogs | Mirror + SQL random/`TABLESAMPLE`/precomputed eligible set — avoid loading all GIDs into memory; use SQL `ORDER BY random()` on remaining set with limits |
| Accidental prod email | Dual flags + NoOp default + approval gate |

---

## 15. Decisions locked in Phase 0

1. Official React Router Shopify template remains the host app.
2. Supabase PostgreSQL + Prisma replace SQLite for sessions and domain data.
3. Durable **Postgres job queue** (not Shopify Flow / n8n).
4. External **pluggable** email provider; Shopify is source of products/customers/consent only.
5. Product cycles and send history live in **our** DB, shop-isolated.
6. Real sending and production deploy require **explicit human approval**.
