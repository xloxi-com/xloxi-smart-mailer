# Production checklist — XLOXI Smart Product Mailer

Use this before and after go-live. **Dry-run stays on until the merchant approves production sending.**

Related: [DEPLOYMENT.md](./DEPLOYMENT.md) · [EMAIL_PROVIDER.md](./EMAIL_PROVIDER.md) · [TEST_REPORT.md](./TEST_REPORT.md)

---

## A. Pre-flight (engineering)

- [ ] GitHub repository created; `.env` not committed
- [ ] `npm run typecheck` / `lint` / `build` pass locally
- [ ] CI green on main (`.github/workflows/ci.yml`)
- [ ] Multi-stage `Dockerfile` builds; image pushed to Artifact Registry
- [ ] Supabase project provisioned; **pooled** `DATABASE_URL` + **direct** `DIRECT_URL`
- [ ] Secret Manager secrets created (DB, Shopify, jobs, unsubscribe)
- [ ] Cloud Run runtime SA can access secrets
- [ ] `xloxi-migrate` Job executed successfully (`prisma migrate deploy`)
- [ ] Web service listens on `PORT` (8080); `/health` and `/health/ready` return 200
- [ ] Cloud Run Jobs exist: scheduler, email-worker, webhook-worker
- [ ] Worker bounds set: `WORKER_MAX_RUNTIME_MS≤300000`, batch/concurrency documented
- [ ] Cloud Scheduler every 5 minutes invokes Jobs with **authenticated** SA (OIDC/OAuth)
- [ ] Scheduler SA has `run.developer` (or least privilege to execute those jobs)
- [ ] `EMAIL_SENDING_ENABLED=false`, `EMAIL_PROVIDER=dry_run`, `EMAIL_PROVIDER_APPROVED=false`
- [ ] `JOBS_SHARED_SECRET` set; `JOBS_ALLOW_INSECURE` **unset**
- [ ] Structured logging visible in Cloud Logging; alert policies drafted

## B. Shopify (custom distribution)

- [ ] App distribution = **Custom** (SingleMerchant / not public App Store)
- [ ] App URL = Cloud Run HTTPS URL
- [ ] Allowed redirection URL(s) = `https://<APP_URL>/api/auth`
- [ ] Scopes match: `read_products,read_inventory,read_customers,write_customers`
- [ ] Webhooks API version **2026-10**; compliance topics registered
- [ ] `shopify app deploy` (config) completed after URL change
- [ ] Merchant install link generated and opened on the target shop
- [ ] Embedded Admin loads; session token auth works
- [ ] Product sync completed
- [ ] Subscriber / consent sync completed

## C. Dry-run validation (before live email)

- [ ] Automation **enabled** with **dry-run ON** in Admin
- [ ] Scheduler Job reserves jobs without live ESP calls
- [ ] Email worker accepts dry-run/mock deliveries; history rows appear
- [ ] Unsubscribe signed links verify; no raw emails in UI/logs
- [ ] Pause automation works; emergency Scheduler pause tested in staging
- [ ] Merchant reviews sample template preview (desktop/mobile)

## D. Merchant approval gate (live sending)

**Do not proceed without written merchant approval.**

- [ ] ESP chosen and documented for merchant category (see EMAIL_PROVIDER.md)
- [ ] SPF / DKIM / DMARC verified for sending domain
- [ ] ESP adapter implemented + `EMAIL_PROVIDER_APPROVED` process agreed
- [ ] Secret Manager holds ESP credentials (never in git / browser)
- [ ] `EMAIL_TEST_ALLOWLIST` set to operator inboxes
- [ ] Test send with explicit confirmation succeeds to allowlisted address only
- [ ] Bounce / complaint / unsubscribe webhooks verified end-to-end
- [ ] Merchant confirms: disable dry-run + enable live sending
- [ ] Flip flags in this order:
  1. Deploy ESP secrets + provider id
  2. `EMAIL_PROVIDER_APPROVED=true`
  3. Keep allowlist; `EMAIL_SENDING_ENABLED=true`
  4. Admin: turn **dry-run OFF** for the shop
  5. Watch dead-letter + delivery metrics for 24–48h
  6. Only then widen / disable allowlist if policy allows

## E. Backup & recovery

- [ ] Supabase backup tier confirmed (daily / PITR)
- [ ] Manual backup taken before first production migrate
- [ ] Restore drill documented (who / how / RTO)
- [ ] Secret rotation runbook documented

## F. Emergency stop (verify once in staging)

- [ ] Admin: disable automation
- [ ] `gcloud scheduler jobs pause …` for all XLOXI ticks
- [ ] Force `EMAIL_SENDING_ENABLED=false` on Cloud Run
- [ ] Optional: cancel active `EmailJob` rows
- [ ] Resume procedure documented

## G. Go-live sign-off

| Role | Name | Date | Signature / ack |
| --- | --- | --- | --- |
| Engineering | | | |
| Merchant (SEDUCTIV / XLOXI) | | | |
| Email/ESP owner | | | |

**Production sending enabled?** ☐ No (dry-run) ☐ Yes (after section D)
