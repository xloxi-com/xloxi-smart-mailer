# Deployment report — Flow automation audit (2026-11-28)

Production: https://xloxi-smart-mailer-one.vercel.app  
Deployment: `dpl_CBxHAxQcLDopZAkeKtobuYJacQPh`

## Root causes

1. **`next_selection_not_due` stripped `xloxi-request`** for never-sent subscribers whose `nextEmailAt` was staggered into the future — Flow/manual request tags never produced batches.
2. **Customer sync recomputed `nextEmailAt` when null** on every `customers/update`, restamping a future stagger and fighting Flow.
3. **`isStaleResourceUpdate` skipped `customers/update`** when local `subscriber.updatedAt` was newer than Shopify’s `updated_at` — acknowledgement webhooks after our own tag/metafield writes were dropped as `stale_out_of_order`, so **Last email / Last Processed At** stayed empty even when Flow wrote `processed_batch_id`.
4. **Ack path did not repair subscriber mirrors** or write `last_processed_at` / `next_selection_at` metafields back to Shopify.
5. Cadence used raw `intervalDays` addition (drift) instead of fixed **Monday / Thursday** slots; default batch size was **6** instead of **4**.

## Fixes shipped

| Area | Change |
| --- | --- |
| Webhook stale check | Never stale-skip `customers/update` (Flow bridge) |
| Eligibility / request | Honor `xloxi-request` for never-sent; enforce due gate only after a completed send |
| Customer sync | Preserve `nextEmailAt`; assign first Mon/Thu slot only on create / newly eligible |
| Schedule | `calculateNextEmailAt` → next Mon/Thu 14:00 UTC; first-send stagger ≤ 4h |
| Acknowledgement | Repair subscriber fields; sync `last_processed_at` + `next_selection_at` metafields |
| Duplicates / history | Stable idempotency key; leave request tag on selection failure for retry; history unchanged |
| Defaults | `productsPerEmail` / `DEFAULT_BATCH_SIZE` → 4 |
| Logging | `flow_customer_update_processed`, due-bypass, ack, scheduler tag logs |
| Safe test | `runSafeSingleCustomerFlowTest` (Random Selection → Prepare; no bulk sends) |

## Tests

- `consent.server.test.ts` — passed (incl. Mon/Thu schedule)
- `flow-schedule.server.test.ts` — passed
- `tsc --noEmit` — clean

## Merchant follow-up

1. In **Automation**, set **Products per email** to **4** if the shop still has 6 stored.
2. Align Flow Workflow A schedule with **Monday + Thursday**.
3. Verify one customer: add `xloxi-request` (or use Random Selection → Prepare) → pick tags + `xloxi-ready` → Workflow B → Subscribers shows Last email + Last processed.
4. Keep test mode on until that single-customer path is confirmed; do not bulk-tag.
5. Product history was **not** reset.
