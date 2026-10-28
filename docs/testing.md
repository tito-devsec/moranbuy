# Testing

```bash
npm run lint              # secrets, CRLF, tabs, one-line comments
npm run check             # node --check on every file
npm test                  # unit: config, redaction, ranking cases A to G and more, parser, engagement rules, research
npm run test:integration  # health, Muse client telemetry, merchants and Moran sync, campaigns, follow-up, consent
npm run test:security     # admin auth, roles, tenancy, injection, signed channel, audited policy, telemetry without keys, secrets in the tree
npm run test:e2e          # the customer shopping flow over web and the forwarded WhatsApp channel
```

Database-backed suites need `DATABASE_URL` and `REDIS_URL` for an empty test database; files run
serially and truncate every table before they start. No test calls Muse, Meta, Snippe, Nominatim
or Moran; each has a fake with the real request and response shapes.

## Results on 28 October 2026 (local, Node 22, Postgres 16, Redis 7)

| Suite | Result |
|---|---|
| lint, check | pass |
| unit | see CI; all passing at the last push |
| integration | all passing |
| security | all passing |
| end-to-end | all passing |
| Docker image | `Dockerfile` and `deploy/docker-compose.vps.yml` are syntax-checked only; the sandbox has no Docker daemon, so the first `docker compose up --build` happens on the VPS |
| migrations rollback and re-apply | pass |

CI (`.github/workflows/ci.yml`) runs the same on every push: https://github.com/tito-devsec/moranbuy/actions

## Moran AI side

The patch in `integrations/moran-backend/` was applied to a local clone of `moran-backend`
(commit `965c247`) with its dependencies installed. Every patched and new file passes
`node --check` and imports cleanly. Moran's own unit suite (`npm test`, 1,528 tests) was run on
the patched tree: 1,523 passed; the 2 failures are Moran's own cases marked `TODO known fault`
in its source (healthcare and sales evaluation cases), unrelated to the patch. The admin API
reference check, which failed when the new admin route was added, passes after regenerating the
reference, which is part of the patch. Not run: Moran's database-backed suites and anything
against a live Meta number.
