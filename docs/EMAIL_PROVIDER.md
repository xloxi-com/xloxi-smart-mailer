# Marketing email provider setup

XLOXI Smart Product Mailer delivers marketing mail through a **pluggable `EmailProvider`**. Shopify Admin GraphQL is used for products, customers, and consent only — **this app does not call Shopify Messaging / Email APIs** (none are invented or assumed).

## Safety flags (required)

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMAIL_SENDING_ENABLED` | `false` | Master switch. When false, factory forces **DryRun** (or **Mock** if `EMAIL_PROVIDER=mock`). |
| `EMAIL_PROVIDER` | `dry_run` | `dry_run` \| `mock` \| (future ESP id) |
| `EMAIL_PROVIDER_APPROVED` | unset/`false` | Must be `true` before any live ESP adapter may send. |
| `EMAIL_TEST_ALLOWLIST` | empty | Comma-separated addresses allowed when live sending is on. |
| `EMAIL_ALLOWLIST_DISABLED` | unset | Only with approval + production discipline; fail-closed otherwise. |
| `UNSUBSCRIBE_SIGNING_SECRET` | falls back to `SHOPIFY_API_SECRET` | HMAC for signed unsubscribe URLs. |

**Development rule:** never send real email. Keep `EMAIL_SENDING_ENABLED=false`.

Merchant automation `dryRun=true` (default) also keeps jobs in simulation mode.

## Selecting a real provider

Before enabling live delivery:

1. Confirm the ESP documents **transactional/marketing email** APIs (send HTML+text, webhooks for delivery/bounce/complaint, suppression or equivalent).
2. Confirm the ESP permits the **merchant’s product category** (adult/regulated categories may be restricted).
3. Document SPF/DKIM/DMARC for the sending domain (below).
4. Implement an adapter under `app/providers/` that satisfies `EmailProvider`.
5. Set `EMAIL_PROVIDER=<id>`, `EMAIL_PROVIDER_APPROVED=true`, allowlist test recipients, then enable `EMAIL_SENDING_ENABLED=true` only after operator approval.

Until an approved adapter exists, `UnapprovedEmailProvider` rejects live sends.

## Interface

```ts
sendMarketingEmail()
getMessageStatus()
verifyWebhook()
processDeliveryEvent()
synchronizeSuppression()
```

See `app/services/email-provider.server.ts`.

## Idempotency & retries

- Each `EmailJob` has a shop-unique `idempotencyKey` passed to the provider.
- Retry only when `SendResult.retryable` is true (e.g. rate limits).
- Exponential backoff via `computeEmailBackoffMs`.
- **Ambiguous / timeout:** mark job `UNKNOWN`, call `getMessageStatus` before any retry — never blind-resend.

## Events & suppression

Provider webhooks → `POST /api/email.events` → verified → `EmailEvent` rows (unique `providerEventId`) for accepted/delivered/bounced/complained/failed.

Bounces/complaints/unsubscribes update the independent `Suppression` list. Suppressed addresses never receive mail.

## Unsubscribe

- Signed links: `GET /api/unsubscribe?token=…`
- One-click: `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` → `POST /api/unsubscribe`
- Local suppression + `customerEmailMarketingConsentUpdate` → `UNSUBSCRIBED` (never auto-resubscribe).

## DNS authentication (SPF, DKIM, DMARC)

Configure these on the **sending domain** (e.g. `mail.seductiv.net` or ESP-instructed hostname) before production:

### SPF

Publish a TXT record authorizing the ESP’s sending infrastructure, for example:

```text
v=spf1 include:<esp-spf-include> -all
```

Use the exact `include:` value from the ESP docs. Avoid multiple competing SPF records on the same name.

### DKIM

Enable DKIM in the ESP and publish the CNAME/TXT keys they provide (often `s1._domainkey`, `s2._domainkey`). Align the DKIM domain with the From domain (or a designated mail subdomain).

### DMARC

Start with monitoring, then enforce:

```text
v=DMARC1; p=none; rua=mailto:dmarc@seductiv.net; fo=1
```

Later tighten to `p=quarantine` / `p=reject` once SPF+DKIM alignment is clean. Ensure **From** domain alignment with SPF or DKIM (BIMI optional later).

### Checklist

- [ ] From / Reply-To domains verified in ESP
- [ ] SPF passes for ESP IPs
- [ ] DKIM signatures validate
- [ ] DMARC policy published; reports reviewed
- [ ] Custom tracking/link domains (if used) also authenticated
- [ ] Test allowlist sends before opening to all subscribers

## Local providers

| Provider | File | Use |
| --- | --- | --- |
| DryRun | `app/providers/dry-run.server.ts` | Default; logs hashes only |
| Mock | `app/providers/mock.server.ts` | Integration tests / deterministic IDs |
| Unapproved | `app/providers/unapproved.server.ts` | Blocks live send without approval |
