# Email scheduler & workers

Production scheduling uses **PostgreSQL as the durable queue** — never `setInterval` in-memory timers.

## Cadence

| Piece | Behavior |
| --- | --- |
| Cloud Scheduler | Invoke every **5 minutes** |
| Default send interval | **72 hours** (`AutomationSettings.intervalDays = 3`) |
| Catch-up | **One** email per overdue subscriber; `nextEmailAt` advances only after provider acceptance |

## Entry points

| Target | Purpose |
| --- | --- |
| `GET/POST /api/jobs/scheduler` | Enqueue due subscribers (`reserveEmailBatch`) |
| `GET/POST /api/jobs/email-worker` | Claim + deliver reserved jobs |
| `GET/POST /api/jobs/webhooks` | Process due webhook events |
| `npm run worker:scheduler` | CLI / Cloud Run Job |
| `npm run worker:email` | CLI / Cloud Run Job |
| `npm run worker:webhooks` | CLI / Cloud Run Job |

Production wiring (Secret Manager, Scheduler → Jobs IAM, bounds): see [DEPLOYMENT.md](./DEPLOYMENT.md).

Authenticate with `JOBS_SHARED_SECRET` (`x-jobs-secret` or `Authorization: Bearer`) or Cloud Scheduler **OIDC** service-account tokens (`JOBS_OIDC_AUDIENCE`).

## Queue mechanics

- Claim: `SELECT … FOR UPDATE SKIP LOCKED`
- Leases: `leaseOwner` + `leaseExpiresAt`; stale leases recovered without burning attempts
- One active marketing job per subscriber (partial unique index)
- Retries: exponential backoff; dead-letter → `FAILED` after `maxAttempts`
- Ambiguous provider results → `UNKNOWN` + `getMessageStatus` reconcile (no blind resend)

## Limits

Per shop (`AutomationSettings`):

- `maxEmailsPerRun` (default 50)
- `maxEmailsPerHour` (default 200)

Worker env:

- `WORKER_BATCH_SIZE` (default 20)
- `WORKER_CONCURRENCY` (default 5)
- `WORKER_MAX_RUNTIME_MS` (default 240000 — Cloud Run Jobs bound)
- `WORKER_LEASE_MS` (default 120000)

## Observability

`WorkerHeartbeat` rows store worker id, type, metrics JSON, and errors. Structured logs: `scheduler_run_complete`, `email_worker_complete`, `email_job_dead_letter`.

## Overlap protection

Scheduler uses `DurableLock` id `email-scheduler` (pool-safe). Email workers rely on SKIP LOCKED for concurrency.
