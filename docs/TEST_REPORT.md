# Test report — XLOXI Smart Mailer (Flow + Messaging)

**Date:** 2026-11-20  
**App:** XLOXI Smart Mailer  
**Architecture:** Random product engine → customer tags/metafields → Shopify Flow → Shopify Messaging  
**Live automation default:** Disabled / test mode on  
**App email sending:** Disabled (no SMTP / Resend / SendGrid)

## Phase 1 — Sync fixes

| Check | Result | Notes |
| --- | --- | --- |
| `storefrontUrl` in Prisma schema | Pass | Present on `Product` |
| DB column `Product.storefrontUrl` | Pass | Verified via probe script |
| Generated Prisma client | Pass | Field present; regenerate after migrate |
| Failed sync must not show SUCCEEDED | Pass | Product/customer sync jobs → `FAILED` when `errors > 0` |
| Raw Prisma errors hidden in UI | Pass | `toMerchantSafeError` / sanitized partialErrors |

## Automated verification (local)

| Command | Result |
| --- | --- |
| `npx prisma migrate deploy` | Pass — `20261120100000_flow_messaging_selection` applied |
| `npx prisma generate` | Pass |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| Unit/integration tests | Pass (103 earlier + scheduler/audit re-runs). Legacy ESP worker suites rewritten for Messaging-only scheduler. |

## Manual integration checklist (dev store)

Do **not** send real Messaging emails without explicit merchant approval.

| # | Step | Status |
| --- | --- | --- |
| 1 | Product synchronization | Pending merchant run in admin |
| 2 | Customer synchronization | Pending merchant run in admin |
| 3 | Random product selection preview | Implemented — Random Selection page |
| 4 | Customer tag creation (`xloxi-pick`, `xloxi-ready`) | Implemented — Flow selection service |
| 5 | Shopify Flow trigger execution | Manual — see FLOW_SETUP.md |
| 6 | Shopify Messaging action availability | **Must verify on store plan** |
| 7 | Dynamic product rendering in received email | Manual — requires Messaging send approval |
| 8 | Processed batch acknowledgement | Implemented — metafield sync |
| 9 | Safe tag cleanup | Implemented — removes prior pick/ready before rewrite |
| 10 | Second batch with no repeating products | Covered by ProductHistory + random engine |
| 11 | Unsubscribe handling | Via Shopify Messaging + existing consent webhooks |

## Known limitations / blockers

1. **Workflows are not auto-created** — no supported Admin API creates these Flow workflows for Basic merchants in this app.
2. **Messaging Liquid** may differ from Online Store Liquid (`all_products`, filters). If rendering fails in Messaging, that is a platform limitation — do not fall back to an external ESP.
3. **Flow Get customer data = 100** — use chained Flow steps or optional app scheduler.
4. **Acknowledgement ≠ delivery** — `processed_batch_id` only means Flow advanced; open/click delivery is Messaging’s domain.
5. Historical `EmailJob` / `EmailEvent` rows are preserved; the app no longer sends mail.
6. Legacy email worker routes remain as dry-run stubs; production delivery path is Messaging-only.

## Production gate

Before enabling automation on **seductiv.net**:

1. Complete manual checklist with one subscribed test customer + two published products.
2. Confirm Messaging email content renders correctly.
3. Confirm second batch excludes first-batch products.
4. Turn off test mode only after explicit approval.
