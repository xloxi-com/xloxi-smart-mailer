# Shopify Flow setup — XLOXI Smart Mailer

XLOXI Smart Mailer selects random products and writes **customer tags + metafields**.  
**Shopify Messaging** sends the email. This app does **not** create Flow workflows automatically.

Compatible with **Shopify Basic** (no Plus-only custom Flow extensions, no Send HTTP Request dependency).

## Tag namespace

| Tag | Who writes it | Purpose |
| --- | --- | --- |
| `xloxi-request` | Flow (Workflow A) or optional app scheduler | Request a product selection |
| `xloxi-pick:PRODUCT_HANDLE` | XLOXI app | Selected product handles (default 4) |
| `xloxi-ready` | XLOXI app (last write) | Signal Messaging / Workflow B |

## Customer metafields (`xloxi` namespace)

Create via **Shopify Flow Integration → Test integration (metafields)** in the app, or manually:

| Key | Type | Purpose |
| --- | --- | --- |
| `pending_batch_id` | Single line text | Current selection batch ID |
| `processed_batch_id` | Single line text | Flow acknowledgement after Messaging action |
| `last_processed_at` | Date and time | Last acknowledgement time |
| `next_selection_at` | Date and time | Next eligible selection time |

## Workflow A — Request selection

1. **Trigger:** Scheduled time on **Monday** and **Thursday** (align with app Mon/Thu UTC slots).
2. **Get customer data** — filter marketing email consent = **Subscribed**.  
   Shopify limits **100 customers per Get customer data action**. For larger lists:
   - Chain multiple Get customer data steps with filters / offsets, **or**
   - Enable the optional **app scheduler** in Automation (tags due subscribers with `xloxi-request` in chunks of ≤100).
3. **Action:** Add customer tag `xloxi-request`.

XLOXI receives `customers/update`, verifies consent, reserves **4** in-stock products (configurable), writes pick tags + metafields, adds `xloxi-ready`, removes `xloxi-request`. Never-sent subscribers are not blocked by a future staggered `nextEmailAt` when the request tag is present. After a completed send, early request tags are dropped until the next Mon/Thu slot.

## Workflow B — Send via Messaging

1. **Trigger:** Customer tags added.
2. **Condition:** Newly added tags contain `xloxi-ready`.
3. **Condition:** Marketing consent is **Subscribed**.
4. **Action:** Shopify Messaging → **Send marketing email** (use the Custom Liquid from the Messaging page).
5. **Action:** Update customer metafield `xloxi.processed_batch_id` to the value of `xloxi.pending_batch_id`.
6. **Action:** Remove customer tag `xloxi-ready`.

Keep `xloxi-pick:*` tags stable until Messaging has rendered the email. Do not treat acknowledgement as delivery confirmation.

## Recursion / duplicates

- XLOXI ignores updates without `xloxi-request` (except acknowledgement sync).
- At most one pending/ready batch per subscriber.
- Ambiguous acknowledgements are mirrored locally and **not** auto-retried.

## Production checklist

1. Keep **automation disabled** and **test mode on** until TEST_REPORT steps pass.
2. Confirm Workflow B Messaging action is available on your plan.
3. Test with one subscribed customer and two published products before going live.
