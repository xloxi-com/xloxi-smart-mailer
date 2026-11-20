# Production deployment — XLOXI Smart Product Mailer

Target stack:

| Component | Service |
| --- | --- |
| Source | GitHub |
| Web | Google Cloud Run **service** |
| Background | Google Cloud Run **Jobs** |
| Tick | Cloud Scheduler every **5 minutes** |
| Database | Supabase PostgreSQL |
| Secrets | Google Secret Manager |
| Email | Approved marketing ESP (dry-run until merchant approval) |

**This document does not deploy for you.** Run the commands below manually (or via the controlled GitHub Actions `workflow_dispatch` deploy). Keep `EMAIL_SENDING_ENABLED=false` until the merchant approves live sending.

---

## Architecture (runtime)

```
Cloud Scheduler (*/5 * * * *)
        │  OIDC (scheduler SA)
        ▼
Cloud Run Jobs API ──► xloxi-scheduler (npm run worker:scheduler)
                   ──► xloxi-email-worker (npm run worker:email)
                   ──► xloxi-webhook-worker (npm run worker:webhooks)  [optional parallel cron]

Merchants / Shopify ──► Cloud Run service xloxi-smart-mailer (npm run start:web)
                              │
                              ▼
                     Supabase Postgres (pooled DATABASE_URL)

Migrations (separate Job) ──► xloxi-migrate (npm run db:migrate) using DIRECT_URL
```

Web container **never** runs `prisma migrate` on startup.

---

## 0. Prerequisites

```bash
# Tools
gcloud --version
docker --version
gh --version
node -v   # >= 22.12

# Project
export PROJECT_ID=YOUR_GCP_PROJECT
export REGION=asia-south1          # or your region
export REPO=xloxi                  # Artifact Registry repo name
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/smart-mailer"

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  cloudbuild.googleapis.com
```

Create Artifact Registry:

```bash
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="XLOXI Smart Product Mailer"
```

---

## 1. Supabase PostgreSQL (pooling + credentials)

### Connection strings

| Variable | Use | Host / port |
| --- | --- | --- |
| `DATABASE_URL` | App + workers (Prisma Client) | Pooler **Transaction** mode, port **6543** |
| `DIRECT_URL` | `prisma migrate deploy` only | Direct Postgres port **5432** |

Recommended `DATABASE_URL` query params for Prisma + Supabase pooler:

```text
postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require
```

`DIRECT_URL` example:

```text
postgresql://postgres.[REF]:[PASSWORD]@db.[REF].supabase.co:5432/postgres?sslmode=require
```

### Pooling guidance

- Cloud Run scales to N instances × Prisma connections. Prefer **transaction pooler** + `connection_limit=1` per instance.
- Set Cloud Run `--max-instances` low enough that total connections stay under Supabase plan limits (often ~60–200).
- **Never** run migrations through the transaction pooler — always `DIRECT_URL`.
- Rotate DB passwords in Supabase → update Secret Manager versions → redeploy services/jobs.

### Backups & recovery (Supabase)

1. Dashboard → **Project Settings → Database → Backups** (Pro+: PITR; Free: daily).
2. Before risky deploys: create a **manual backup** / snapshot if available on your plan.
3. Recovery: restore from Supabase backup UI to a new project or follow Supabase PITR docs; then point `DATABASE_URL` / `DIRECT_URL` secrets to the restored instance and re-run migrate if needed.
4. Keep a documented RPO/RTO with the merchant (e.g. RPO ≤ 24h on Free).

---

## 2. Google Secret Manager

Create secrets (paste values interactively — do not echo them into shell history files you commit):

```bash
# Helper: create or add version from stdin
put_secret() {
  local name="$1"
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets versions add "$name" --data-file=-
  else
    gcloud secrets create "$name" --data-file=-
  fi
}

printf '%s' 'YOUR_POOLED_DATABASE_URL' | put_secret DATABASE_URL
printf '%s' 'YOUR_DIRECT_DATABASE_URL' | put_secret DIRECT_URL
printf '%s' 'YOUR_SHOPIFY_API_KEY' | put_secret SHOPIFY_API_KEY
printf '%s' 'YOUR_SHOPIFY_API_SECRET' | put_secret SHOPIFY_API_SECRET
printf '%s' 'https://YOUR_CLOUD_RUN_URL' | put_secret SHOPIFY_APP_URL
printf '%s' 'read_products,read_inventory,read_customers,write_customers' | put_secret SCOPES
printf '%s' 'YOUR_LONG_RANDOM_JOBS_SECRET' | put_secret JOBS_SHARED_SECRET
printf '%s' 'YOUR_LONG_RANDOM_UNSUB_SECRET' | put_secret UNSUBSCRIBE_SIGNING_SECRET
```

Grant the Cloud Run runtime service account access:

```bash
export RUN_SA="$(gcloud iam service-accounts list --format='value(email)' --filter='displayName:Default compute')"
# Or create a dedicated SA:
# gcloud iam service-accounts create xloxi-run --display-name="XLOXI Cloud Run"

for S in DATABASE_URL DIRECT_URL SHOPIFY_API_KEY SHOPIFY_API_SECRET \
         SHOPIFY_APP_URL SCOPES JOBS_SHARED_SECRET UNSUBSCRIBE_SIGNING_SECRET; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${RUN_SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## 3. Build the container image

```bash
cd "xloxi-smart-mailer"

# Local production build check (no Docker)
npm ci
npm run typecheck
npm run lint
npm run build

# Image (multi-stage; does not embed .env)
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
docker build -t "${IMAGE}:$(git rev-parse --short HEAD)" -t "${IMAGE}:latest" .
docker push "${IMAGE}:$(git rev-parse --short HEAD)"
docker push "${IMAGE}:latest"
```

Image CMD defaults to **`npm run start:web`** (no migrations).

---

## 4. Database migrations (separate step)

```bash
# Create / update migrate job
gcloud run jobs deploy xloxi-migrate \
  --image="${IMAGE}:latest" \
  --region="$REGION" \
  --service-account="$RUN_SA" \
  --command=npm \
  --args=run,db:migrate \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,DIRECT_URL=DIRECT_URL:latest" \
  --set-env-vars="NODE_ENV=production" \
  --max-retries=0 \
  --task-timeout=15m \
  --memory=1Gi \
  --cpu=1 \
  --tasks=1

# Execute once per release (before or immediately after web deploy)
gcloud run jobs execute xloxi-migrate --region="$REGION" --wait
```

Destructive schema changes must be reviewed in Prisma migration SQL **before** `migrate deploy`. Never enable `prisma migrate reset` in production.

---

## 5. Cloud Run web service

```bash
gcloud run deploy xloxi-smart-mailer \
  --image="${IMAGE}:latest" \
  --region="$REGION" \
  --platform=managed \
  --service-account="$RUN_SA" \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=80 \
  --min-instances=0 \
  --max-instances=10 \
  --timeout=300 \
  --cpu-boost \
  --command=npm \
  --args=run,start:web \
  --set-env-vars="NODE_ENV=production,PORT=8080,EMAIL_SENDING_ENABLED=false,EMAIL_PROVIDER=dry_run,EMAIL_PROVIDER_APPROVED=false" \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,SHOPIFY_API_KEY=SHOPIFY_API_KEY:latest,SHOPIFY_API_SECRET=SHOPIFY_API_SECRET:latest,SHOPIFY_APP_URL=SHOPIFY_APP_URL:latest,JOBS_SHARED_SECRET=JOBS_SHARED_SECRET:latest,UNSUBSCRIBE_SIGNING_SECRET=UNSUBSCRIBE_SIGNING_SECRET:latest,SCOPES=SCOPES:latest"

# Capture URL
export APP_URL="$(gcloud run services describe xloxi-smart-mailer --region="$REGION" --format='value(status.url)')"
echo "$APP_URL"

# Update SHOPIFY_APP_URL secret to match, then redeploy web with same flags
printf '%s' "$APP_URL" | put_secret SHOPIFY_APP_URL
```

### Health checks

| Probe | Path | Expect |
| --- | --- | --- |
| Liveness | `GET /health` | `200` `{ "status": "ok" }` |
| Readiness | `GET /health/ready` | `200` `{ "status": "ready", "database": "ok" }` |

```bash
curl -fsS "${APP_URL}/health"
curl -fsS "${APP_URL}/health/ready"
```

Configure Cloud Run startup probe to `/health/ready` in the console or via YAML if desired.

---

## 6. Background workers (Cloud Run Jobs)

```bash
COMMON_ENV="NODE_ENV=production,EMAIL_SENDING_ENABLED=false,EMAIL_PROVIDER=dry_run,EMAIL_PROVIDER_APPROVED=false,WORKER_BATCH_SIZE=20,WORKER_CONCURRENCY=5,WORKER_MAX_RUNTIME_MS=240000,WORKER_LEASE_MS=120000"
COMMON_SECRETS="DATABASE_URL=DATABASE_URL:latest,SHOPIFY_API_KEY=SHOPIFY_API_KEY:latest,SHOPIFY_API_SECRET=SHOPIFY_API_SECRET:latest,SHOPIFY_APP_URL=SHOPIFY_APP_URL:latest,JOBS_SHARED_SECRET=JOBS_SHARED_SECRET:latest,UNSUBSCRIBE_SIGNING_SECRET=UNSUBSCRIBE_SIGNING_SECRET:latest,SCOPES=SCOPES:latest"

deploy_job() {
  local name="$1"
  local args="$2"
  gcloud run jobs deploy "$name" \
    --image="${IMAGE}:latest" \
    --region="$REGION" \
    --service-account="$RUN_SA" \
    --command=npm \
    --args="$args" \
    --set-env-vars="$COMMON_ENV" \
    --set-secrets="$COMMON_SECRETS" \
    --max-retries=1 \
    --task-timeout=10m \
    --memory=1Gi \
    --cpu=1 \
    --tasks=1
}

deploy_job xloxi-scheduler "run,worker:scheduler"
deploy_job xloxi-email-worker "run,worker:email"
deploy_job xloxi-webhook-worker "run,worker:webhooks"
```

### Manual one-shot (debug)

```bash
gcloud run jobs execute xloxi-scheduler --region="$REGION" --wait
gcloud run jobs execute xloxi-email-worker --region="$REGION" --wait
gcloud run jobs execute xloxi-webhook-worker --region="$REGION" --wait
```

Bounded execution: workers exit after one tick; `WORKER_MAX_RUNTIME_MS` (default 240000) caps wall time.

---

## 7. Cloud Scheduler → authenticated Cloud Run Jobs

Create a scheduler service account that can run jobs:

```bash
gcloud iam service-accounts create xloxi-scheduler \
  --display-name="XLOXI Cloud Scheduler"

export SCHEDULER_SA="xloxi-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.developer"

# Allow Scheduler to mint OIDC tokens as this SA
gcloud iam service-accounts add-iam-policy-binding "$SCHEDULER_SA" \
  --member="serviceAccount:service-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

Schedule job executions every 5 minutes via the Jobs HTTP API:

```bash
# Scheduler → run scheduler job
gcloud scheduler jobs create http xloxi-tick-scheduler \
  --location="$REGION" \
  --schedule="*/5 * * * *" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/xloxi-scheduler:run" \
  --http-method=POST \
  --oauth-service-account-email="$SCHEDULER_SA" \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"

# Shortly after: email worker
gcloud scheduler jobs create http xloxi-tick-email \
  --location="$REGION" \
  --schedule="2-59/5 * * * *" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/xloxi-email-worker:run" \
  --http-method=POST \
  --oauth-service-account-email="$SCHEDULER_SA" \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"

# Webhooks processor (optional; ingress also schedules inline work)
gcloud scheduler jobs create http xloxi-tick-webhooks \
  --location="$REGION" \
  --schedule="1-59/5 * * * *" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/xloxi-webhook-worker:run" \
  --http-method=POST \
  --oauth-service-account-email="$SCHEDULER_SA" \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
```

### Alternative: HTTP hit web `/api/jobs/*`

If you prefer Scheduler → Cloud Run **service** instead of Jobs API:

```bash
gcloud scheduler jobs create http xloxi-http-scheduler \
  --location="$REGION" \
  --schedule="*/5 * * * *" \
  --uri="${APP_URL}/api/jobs/scheduler" \
  --http-method=POST \
  --headers="x-jobs-secret=REDACTED" \
  --oidc-service-account-email="$SCHEDULER_SA" \
  --oidc-audience="${APP_URL}/api/jobs/scheduler"
```

Prefer Secret Manager + IAM over putting `x-jobs-secret` in Scheduler config long-term. Production `authorizeJobsRequest` requires `JOBS_SHARED_SECRET` (or `CRON_SECRET`).

---

## 8. Shopify application URLs (custom distribution)

Partner Dashboard → Apps → **XLOXI Smart Product Mailer** → **Settings**:

| Setting | Value |
| --- | --- |
| App URL | `https://YOUR_CLOUD_RUN_URL` |
| Allowed redirection URL(s) | `https://YOUR_CLOUD_RUN_URL/api/auth` |
| Embedded | Yes |
| Distribution | **Custom** (single merchant / SEDUCTIV) |

Update `shopify.app.toml` before `shopify app deploy` (config only):

```toml
application_url = "https://YOUR_CLOUD_RUN_URL"
[auth]
redirect_urls = [ "https://YOUR_CLOUD_RUN_URL/api/auth" ]
```

```bash
# After URLs are correct — deploys app config/webhooks to Shopify, not GCP
npx shopify app deploy
```

### Custom distribution install (merchant)

1. Partner Dashboard → App → **Distribution** → **Custom distribution**.
2. Generate install link for the merchant shop (`seductiv.myshopify.com` or final shop).
3. Merchant opens link → installs → grants scopes:  
   `read_products,read_inventory,read_customers,write_customers`.
4. Confirm embedded Admin loads Dashboard at `/app`.
5. Run product + subscriber sync from Admin.
6. Leave **Automation dry-run ON** and `EMAIL_SENDING_ENABLED=false` until approval.

---

## 9. Structured logging & failure monitoring

- App logs are JSON lines via `logger` (`level`, `message`, `time`, redacted fields).
- Cloud Run → **Logs Explorer** filter examples:

```text
resource.type="cloud_run_revision"
jsonPayload.message="scheduler_run_complete"

resource.type="cloud_run_job"
severity="email_job_dead_letter" OR "scheduler_run_failed" OR "health_ready_failed"
```

Recommended alerts:

1. `health_ready_failed` or probe failures on `/health/ready`
2. `email_job_dead_letter`
3. Cloud Run Job task failed (Scheduler → Job execution errors)
4. Elevated 5xx on the web service

Optional: export logs to Cloud Monitoring / Error Reporting.

---

## 10. Pause automation & emergency stop

### Soft pause (merchant / Admin)

1. Open embedded app → **Automation**.
2. Uncheck **Enable automation** → confirm save.  
   Scheduler skips the shop; no new reservations.

### Soft pause (database)

```sql
UPDATE "AutomationSettings"
SET "automationEnabled" = false, "dryRun" = true, "updatedAt" = NOW();
```

### Emergency stop (infrastructure)

```bash
# 1) Pause Cloud Scheduler ticks
gcloud scheduler jobs pause xloxi-tick-scheduler --location="$REGION"
gcloud scheduler jobs pause xloxi-tick-email --location="$REGION"
gcloud scheduler jobs pause xloxi-tick-webhooks --location="$REGION"

# 2) Force dry-run + disable sending on web + jobs
gcloud run services update xloxi-smart-mailer --region="$REGION" \
  --update-env-vars="EMAIL_SENDING_ENABLED=false,EMAIL_PROVIDER=dry_run,EMAIL_PROVIDER_APPROVED=false"

# 3) Cancel in-flight pending email jobs (SQL)
# UPDATE "EmailJob" SET status = 'CANCELLED', "completedAt" = NOW(),
#   "lastErrorCode" = 'emergency_stop'
# WHERE status IN ('PENDING','PROCESSING','RETRY_SCHEDULED','UNKNOWN');
```

Resume: re-enable Scheduler jobs; turn automation back on only after root-cause review.

---

## 11. GitHub repository + Actions

1. Create GitHub repo; push this project (ensure `.env` is gitignored).
2. Add Environments `staging` / `production` with required reviewers.
3. Secrets for Actions (Environment):

| Secret | Purpose |
| --- | --- |
| `GCP_PROJECT_ID` | Project id |
| `GCP_REGION` | e.g. `asia-south1` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | WIF provider |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | Deploy SA email |
| `DATABASE_URL` / `DIRECT_URL` | Optional CI integration tests + migrate |
| Shopify + `JOBS_SHARED_SECRET` + `UNSUBSCRIBE_SIGNING_SECRET` | Deploy wiring |

4. CI on PR/push: lint, typecheck, build, unit tests, Docker build (**no push**).
5. Deploy only via **Actions → CI → Run workflow** with `deploy=true`.

Workflow file: `.github/workflows/ci.yml`.

---

## 12. Approved marketing email provider

Until merchant approval:

```text
EMAIL_SENDING_ENABLED=false
EMAIL_PROVIDER=dry_run
EMAIL_PROVIDER_APPROVED=false
AutomationSettings.dryRun = true
```

When ready (see `docs/EMAIL_PROVIDER.md` + `docs/PRODUCTION_CHECKLIST.md`):

1. Implement / enable approved ESP adapter.
2. Configure SPF/DKIM/DMARC.
3. Set provider secrets in Secret Manager.
4. Allowlist test recipients.
5. Merchant written approval → then flip flags carefully.

**Do not** set `EMAIL_SENDING_ENABLED=true` in the default deploy commands above.

---

## 13. Post-deploy smoke checklist

```bash
curl -fsS "${APP_URL}/health"
curl -fsS "${APP_URL}/health/ready"
gcloud run jobs execute xloxi-scheduler --region="$REGION" --wait
gcloud run jobs execute xloxi-email-worker --region="$REGION" --wait
# Install via custom distribution link; open /app Dashboard
```

Confirm logs show `scheduler_run_complete` / `email_worker_complete` with dry-run behavior.
