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

The patch in `integrations/moran-backend/` was applied to a clean checkout of `moran-backend` `main`
(commit `537583d`, the commit on the production VPS) with its dependencies installed, and the result matches
`patches/0001-moranbuy-integration.sha256` file for file. Every patched and new file passes `node --check`.
Moran's own unit suite (`npm test`, 1,701 tests) was run on the patched tree with a migrated database: 1,700 passed and the
only other result is Moran's own `sales-camera-ngapi-not-price`, marked `TODO known fault` in its source.
Moran's database-backed schema check passed against a database migrated from empty to `20260101000103_moranbuy.js`, and the
MoranBuy migration rolls down and up again. The admin API reference was regenerated with Moran's own `npm run docs:admin-api`.
Not run here: anything against a live Meta number, and the Super Admin MoranBuy page in a browser.
