# Protected Customer Data (PCD)

**App:** XLOXI Smart Product Mailer  
**Official guide:** https://shopify.dev/docs/apps/launch/protected-customer-data

## Why this app needs customer data

The mailer sends marketing emails only to customers who are **`emailMarketingConsent.marketingState = SUBSCRIBED`**. That requires Admin GraphQL access to Customer resources, including **email** (Level 2 protected field) and marketing consent state.

Scopes used:

- `read_customers` — read customers + `emailMarketingConsent`
- `write_customers` — synchronize unsubscribe / consent updates via `customerEmailMarketingConsentUpdate` when a recipient opts out through the ESP or in-app flows

## Distribution prerequisite

Shopify requires a **distribution method** before PCD access can be requested (including on development stores). This app uses **Custom distribution** (Partner Dashboard) → SDK `AppDistribution.SingleMerchant`, which keeps embedded App Bridge OAuth.

## Request access (Dev Dashboard)

1. Open the app in the Dev Dashboard → **Settings** → **Access requests**.
2. Manage **Protected customer data**.
3. Select **Customer data** and state the purpose: *send consented marketing product emails every 3 days; stop immediately on unsubscribe*.
4. Request protected fields needed for mailing:
   - **Email** (required to deliver mail)
   - Name only if templates personalize greetings (optional; prefer minimal)
5. Complete **Data protection details** and save.
6. Custom / single-merchant installs: follow Shopify’s custom-distribution + PCD flow. Public App Store listing additionally requires review approval.

## Requirement levels

| Level | Applies when | This app |
| --- | --- | --- |
| Level 1 | Any protected customer data | Yes |
| Level 2 | Name, address, phone, or **email** | Yes (email) |

Implement Level 1 + Level 2 controls from the official requirements, including:

- Process only the minimum data required (email + consent + Shopify customer GID).
- Inform merchants (privacy policy / DPA) what is processed and why.
- Limit processing to stated purposes (product marketing emails).
- Respect consent / unsubscribe decisions immediately.
- Encrypt data at rest and in transit; encrypt backups.
- Separate test and production data.
- Limit staff access; strong passwords; access logs; incident response policy.
- Do not log raw customer emails, tokens, or secrets (`app/lib/logging.server.ts`).

## Engineering controls in this repo

- Shop-isolated Prisma rows; no cross-shop queries.
- Offline sessions for jobs; tokens never exposed to the client.
- PII-safe structured logging.
- Email sending disabled by default (`EMAIL_SENDING_ENABLED=false`).
- Prefer hashing or encryption for stored emails in later sync phases.

## Compliance webhooks

Mandatory topics are subscribed in `shopify.app.toml` via `compliance_topics` and handled by durable webhook jobs:

| Topic | Behavior |
| --- | --- |
| `customers/data_request` | Ack + `AuditLog` (customer GID only; no PII export in logs) |
| `customers/redact` | Redact subscriber email fields, suppress, cancel pending sends |
| `shop/redact` | Wipe subscriber PII for the shop, disable automation, drop sessions |

Operational topics that touch customers (`customers/*`, `customers_email_marketing_consent/update`) store **GIDs and consent state only** in `WebhookEvent.safePayload` — never raw emails.

## References

- https://shopify.dev/docs/apps/launch/protected-customer-data
- https://shopify.dev/docs/api/admin-graphql/2026-10/objects/CustomerEmailMarketingConsentState
- https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes
