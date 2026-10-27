# MoranBuy implementation plan

The order of work, the stack, and the rules every commit follows. Phase numbers match the build brief.

## Rules locked for this repository

1. Every commit is authored by `tito-devsec` alone. No co-author lines, no model names, no session links.
2. Comments are single lines in plain English that say what a function or block does. No comment paragraphs.
3. Nothing is described as working unless a test or a run shows it. Stubs and sandbox adapters are named as such.
4. Prices, stock, distances, delivery fees, approvals and telemetry are never invented.
5. Outbound campaigns and follow-ups stay in dry-run mode until sender, consent, template, payment and rate limits are verified.

## Stack (matches the inspected Moran backend)

- Node 22, ES modules, Express 4, zod, pino.
- PostgreSQL 16 with Knex migrations; Redis for queues and rate limits.
- npm workspaces: `services/api`, `packages/*`, `apps/*` (static Alpine + Tailwind pages served by the API, same design system as the Moran dashboard).
- `node --test` for unit and integration tests; GitHub Actions runs them against Postgres and Redis service containers.
- Docker Compose for local and VPS deployment.

## Repository layout

```
moranbuy/
  services/api/            Express app, routes, middleware, workers, migrations
  packages/core/           ids, money, errors, config loading
  packages/reverse-marketplace/  intent intake, offer discovery, recommendation output
  packages/budget-matching/      deterministic budget-first ranking (stages A to E)
  packages/location-ranking/     haversine distance, delivery feasibility
  packages/muse-intelligence/    Meta Model API client, prompts, telemetry
  packages/product-catalog/      listings, source mappings, locations
  packages/merchant-management/  merchants, entitlements, verification
  packages/campaign-engine/      campaigns, audiences, dispatch gates, worker
  packages/campaign-outreach/    new-product promotional workflow
  packages/followup-engine/      leads, schedules, stop rules
  packages/consent-management/   consent events, opt-outs, dispatch rechecks
  packages/billing/              Snippe adapter, sandbox adapter, cost breakdowns
  packages/authorization/        merchant, customer and admin auth, entitlement checks
  packages/integrations/         Moran adapter, WhatsApp Cloud API, geocoding
  packages/observability/        logger, redaction, audit events
  apps/customer/  apps/business/  apps/admin/
  database/seeds/   tests/{unit,integration,security,end-to-end}   docs/   scripts/
```

## Phases and deliverables

| Phase | Deliverable | Verified by |
|---|---|---|
| 1 | `docs/existing-system-assessment.md` (done) | Read against source |
| 2 | Repository skeleton, licence (Apache 2.0), policies, issue templates, CI, `.env.example`, Docker Compose, repo description | CI green on an empty test suite |
| 4 | Reverse-marketplace engine: structured request, offer discovery, ranking stages A to E, recommendation output, order confirmation flow, MoranBuy WhatsApp webhook | Ranking cases A to G, intake tests |
| 5 | Product, merchant and location management; Moran link and product import without duplicates; standalone merchant registration | Sync and tenant-boundary tests |
| 6 | Business app, entitlement records, server-side service checks, MoranBuy entry in the Moran dashboard header (one change in `frontend/moran-app.js`, proposed as a separate PR to `moran-backend`) | Entitlement tests |
| 7 | Campaign engine and new-product outreach: draft with Muse, review, template lifecycle via Moran, pricing, Snippe payment, dispatch gates, worker, delivery statuses | Campaign tests |
| 8 | Optional paid follow-up: offer, accept or decline, registration link, lead tracking, schedules, stop rules | Follow-up tests |
| 9 | Consent management with purpose, channel, merchant, evidence, revocation; dispatch-time recheck | Consent tests |
| 10 | Admin app: merchants, verification, ranking evidence, Muse telemetry, integration health, audit | Admin and security tests |
| 11 | Migrations, APIs, `.env.example`, startup config validation | Migration run in CI |
| 12 | Full test run, results recorded in `docs/testing.md` | CI |
| 13 | `HACKATHON_CHANGES.md`, `docs/muse-integration.md`, `docs/demo-script.md` | Review |
| 14 | `docs/deployment.md`, health checks, dry-run defaults | Review |
| 15 | Final audit against the checklist | Review |

## How the key integrations work

**Registered merchant link.** The merchant chooses "Link my Moran AI account" in the MoranBuy
business app and signs in with Moran credentials. MoranBuy calls Moran's `POST /api/auth/login`
(and `POST /api/auth/2fa` when asked), then `GET /api/auth/me`. The Moran tenant id becomes
`merchants.moran_tenant_id`; the refresh token is stored encrypted for sync. Products are imported
with `GET /api/products` per service and kept in `listing_sources` keyed by
`(source = 'moran', source_tenant_id, source_product_id)`, so a second sync updates rather than
duplicates. Moran stays authoritative for name, price, stock, images and status of imported
products; MoranBuy edits go back through `PATCH /api/products/:id` with the merchant's own token.
MoranBuy-only fields (delivery fee, pickup options, MoranBuy visibility) live in MoranBuy.

**Customer channel.** MoranBuy owns one WhatsApp Cloud API number (its official identity) and its
own webhook with signature verification. Muse Spark turns the message or photo into a structured
request; deterministic code ranks and replies.

**Campaign sender.** A registered merchant's campaign sends from that merchant's own connected
number through Moran's template lifecycle and sender. A standalone merchant without a connected
number can draft and price but not dispatch; the app says so.

**Payments.** Snippe mobile money with server-side webhook verification and a sandbox adapter in
tests. Provider charges, MoranBuy fees and taxes are separate configured values, never assumed.

**Muse Spark.** `MUSE_API_BASE_URL=https://api.meta.ai/v1`, `MUSE_MODEL_ID=muse-spark-1.3`,
`MUSE_API_KEY` (the Meta Model API key). Chat Completions with JSON output, images as
`image_url` parts. Every call writes a `muse_requests` row (model, latency, tokens, outcome,
redacted error) that the admin page reads. If the API is unreachable the customer gets an honest
message and the configured fallback only.

## Owner actions needed

- A Meta Model API key with access to `muse-spark-1.3` (US public preview or hackathon credits).
- A MoranBuy WhatsApp Business number on the Cloud API (phone number id, WABA id, token, app secret).
- Snippe credentials for MoranBuy (separate from Moran's).
- Confirmation of the git author email to use for `tito-devsec` commits.
- Merging the one-file dashboard change in `moran-backend` when it is proposed.
