# Existing system assessment (Phase 1)

What the Moran AI platform is today, taken from the source of `tito-devsec/moran-backend`
(commit `965c247`) and `tito-devsec/moranapp` (commit `cb6fe25`) on 27 October 2026.
Nothing below is assumed: every interface named here was read in the code.

## 1. Repositories

| Repository | What it is | State |
|---|---|---|
| `tito-devsec/moran-backend` (private) | The Moran AI backend, owner dashboard, Super Admin dashboard, media and restaurant front-ends, n8n workflows, deploy files | Production. ~1,240 files, 103 Knex migrations |
| `tito-devsec/moranapp` (private) | Expo / React Native app for the team that answers customers | Production. Talks to `https://api.moranai.co.tz` |
| `tito-devsec/moran_agent` (private) | README and MIT licence only; describes an n8n + OpenClaw + Hermes architecture | No code |
| `tito-devsec/moranbuy` (public) | This repository | Empty at the start of this work |

## 2. Stack of the existing backend

| Area | Actual choice | Where |
|---|---|---|
| Runtime | Node >= 20, ES modules, Express 4 | `package.json`, `src/server.js` |
| Database | PostgreSQL 16 with `pgvector` and `uuid-ossp`, Knex 3 migrations | `src/db/knexfile.js`, `src/db/migrations/` |
| Cache and queues | Redis 7 (ioredis): rate limits, sessions, campaign work lists | `src/db/redis.js`, `src/jobs/*` |
| Validation | zod on request bodies | `src/api/middleware/validate.middleware.js` |
| Logging | pino / pino-http | `src/utils/logger.js` |
| Jobs | node-cron plus long-running Redis `BLPOP` workers started by the server | `src/jobs/cron.js`, `src/jobs/campaign-worker.js` |
| Tests | `node --test` under `tests/unit` (mocked) and `tests/admin`, `tests/entitlement` (real Postgres + Redis) | `package.json` scripts |
| Process | PM2 cluster, Docker Compose (postgres, redis, n8n, backend, websocket, nginx) | `ecosystem.config.cjs`, `docker-compose.yml` |
| Owner dashboard | Static HTML pages with Alpine.js and Tailwind (TailAdmin layout); `window.Moran.apiFetch` is the single API client | `frontend/dashboard/*.html`, `frontend/moran-app.js` |
| Super Admin | Separate static app at `weare.moranai.co.tz` | `admin-frontend/` |
| AI engines | DeepSeek, OpenAI, Gemini, Nemotron through a role router; Anthropic SDK legacy path | `src/core/ai/providers/` |
| Email | Resend | `src/services/email.service.js` |
| Payments | Snippe mobile money (M-Pesa, Airtel, Mixx, Halotel); HMAC-SHA256 webhook over `{timestamp}.{rawBody}` | `src/services/billing.service.js`, `src/api/routes/payments.routes.js` |
| Geocoding | Nominatim (OpenStreetMap), one request a second, cached in Redis | `src/services/location/geocoding.js` |

There is no Muse Spark, Llama or Meta Model API integration anywhere in the existing code.

## 3. Identity and tenancy

- A business is a `tenants` row (migration 001). Every business table carries `tenant_id`.
- Since migration 052 a business has one or more `services` (business units) and every
  service-scoped row carries `service_id`; a trigger fills a missing one from the default service.
- Products, locations, campaigns, templates and follow-ups are all scoped by `(tenant_id, service_id)`.
- Owner API auth: `requireTenantAuth` verifies a 15-minute JWT (`type: 'tenant'`, `sub` = tenant id,
  `uid` = co-worker id or null, `role`), re-reads the tenant and co-worker on every request, then
  `attachServiceContext` resolves the service from the `X-Service-Id` header.
- Refresh tokens are opaque 48-byte values hashed into `refresh_tokens`, rotated by `POST /api/auth/refresh`.
- Co-worker permissions are dashboard areas (`inbox`, `contacts`, `products`, `campaigns`, `knowledge`,
  `calendar`, `agents`, `billing`, `settings`) checked by `requirePermission(area)`.
- Platform admins are `admin_users` with a separate JWT secret and optional 2FA and IP allow-list.
- Internal routes (`/internal/*`) are protected by the shared `N8N_INTERNAL_KEY` header, compared in constant time.
- MCP (`/mcp`): Super Admin issues per-business `mcp_…` tokens with `read`, `manage`, `message`
  scopes. Read tools include `list_products`, `search_products`, `get_product`, `delivery_options`.

## 4. Products and locations

`products` (migrations 011 and 066): `id`, `tenant_id`, `service_id`, `name`, `description`,
`price` (integer), `currency` (`TZS` default), `sku` (generated, unique per tenant), `retailer_id`
(`MOR-P-<id>`, immutable), `image_url`, `stock`, `is_active`, `status` (`ACTIVE`, `OUT_OF_STOCK`,
`INACTIVE`, `ARCHIVED`), `category`, `condition`, `item_type` (`product` or `service`), variants,
Meta catalog sync columns, `deleted_at`. Postgres is the source of truth; Meta's catalog is a copy.

Owner product API (`/api/products`, needs `products` permission and a service):
`GET /` list, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `POST /upload-image`,
`GET /categories`, collections endpoints. Images must be hosted on Moran's own upload host.

`business_locations` (migration 066): named places with `country`, `region`, `district`, `ward`,
`street`, `address`, `latitude`/`longitude` (numeric 9,6, range-checked), `location_source`
(`USER_PIN`, `USER_ADDRESS`, `GEOCODED`, `IMPORTED`, `ADMIN`), `radius_meters` (how far it delivers),
`is_default`. `product_availability_locations` links a product to the places that stock it.
`distanceKm` in `geocoding.js` is a plain haversine. Positions are never invented: an address the
geocoder cannot place asks the owner to drop a pin.

Orders: `orders` (migration 007) with `order_ref`, `items` jsonb, `total_amount`, `status`, and
`customer_payments` settled by the Snippe webhook only when the payment covers the order total.

## 5. WhatsApp Cloud API

- Inbound webhook `POST /webhook/whatsapp`: raw body, `X-Hub-Signature-256` checked against
  `META_APP_SECRET`, tenant resolved by `phone_number_id`, Meta delivery de-duplicated by message id.
- Outbound `whatsapp-sender.service.js`: Graph API `v25.0` (`META_API_VERSION`), text, image, audio,
  positional templates and component templates; every send passes `authorizeOutbound` (the
  entitlement gate: trial or bundle unit, idempotency key) before it reaches Meta.
- Each business connects its own number through Meta Embedded Signup (v5) and stores an encrypted
  access token on the tenant. A platform-owned number exists only for owner notifications
  (`SAAS_OWNER_WA_PHONE_ID`).
- Templates (`whatsapp-template.service.js`): Moran never sets `APPROVED` itself; every status comes
  from the Graph API submit response or a later sync. Image, video and document headers are supported
  with a sample media handle.
- Marketing consent: `customer_marketing_preferences` per `(tenant_id, phone)` with
  `whatsapp_marketing_enabled`, `opted_out_at`, `opt_out_source`, a 30-day frequency counter. A bare
  `STOP` / `SITAKI` opts out; opt-out is absolute. Absent rows count as opted in by default, which
  MoranBuy must not inherit for its own audiences.

## 6. Existing campaign, outreach and follow-up code in Moran

Moran already has its own campaign features: `campaigns`, `campaign_recipients`, a Redis send
worker with conditional-UPDATE idempotency, `outreach_automations`, bulk SMS, and a sales
follow-up engine (`follow_ups`, intent regexes, attempt limits, consent flag). The owner dashboard
shows them under a "Campaign Engine" sidebar group (Campaigns, Templates, Outreach & Follow-up,
Bulk Messages).

MoranBuy must not present these as its own, and must not reuse them as its campaign or follow-up
engine. MoranBuy's engines are new code in this repository. The only things borrowed from Moran are
verified transports (a merchant's own connected WhatsApp number, template submission to Meta) and
the design lesson that the recipient ledger, not Redis, is the record.

## 7. Billing and entitlement

- Platform billing is cash-based: Super Admin records payments and grants signed `message_bundles`;
  a 5-day trial starts once. Entitlement states: `TRIAL_ACTIVE`, `BUNDLE_ACTIVE`, `BUNDLE_EXHAUSTED`,
  `PAYMENT_REQUIRED`, `ACCOUNT_SUSPENDED`, `UNKNOWN` (fail closed).
- SMS top-ups and a business's own customer payments go through Snippe (`SNIPPE_API_KEY`,
  `SNIPPE_WEBHOOK_SECRET`, `SNIPPE_BASE_URL`), with `webhook_events` for replay protection.
- There is no Stripe checkout in use (columns exist, unused).

## 8. Dashboard navigation

Every dashboard page embeds the same sidebar and header markup (no shared template). The header's
right-hand side holds the notification bell and the user menu. `frontend/moran-app.js` is loaded
by every page before its Alpine component, so a link injected there appears on every page with
one file change. That is where the MoranBuy entry will be added.

## 9. Muse Spark (verified on 27 October 2026)

- Meta Model API, base URL `https://api.meta.ai/v1`, Bearer `MODEL_API_KEY` from `dev.meta.ai`.
- Model identifiers: `muse-spark-1.3` (current), `muse-spark-1.2`, `muse-spark-1.1`;
  `muse-spark-1.3-contributor` shares prompts with Meta for training and is not used here.
- Protocols: OpenAI-compatible Chat Completions (`/v1/chat/completions`), Responses (`/v1/responses`),
  Anthropic-compatible Messages (`/v1/messages`). Images are `image_url` content parts (URL or
  base64 data URL). `reasoning_effort` from `minimal` to `xhigh`. Reasoning tokens bill as output.
- Public preview for developers in the US; pay-as-you-go from $1.25 in / $4.25 out per million
  tokens; rate limits are per team (3,000 RPM / 4M TPM for standard models, as listed by a
  third-party provider page). Hackathon participants receive Meta Model API credits.
- The open-weight `meta-models/muse-spark-open` is served by Together, Fireworks, Baseten, Groq and
  Nebius with the same Chat Completions shape; it is a configurable alternative base URL and model id.
- Sources: https://dev.meta.ai/docs , https://dev.meta.ai/resources/blog/build-with-muse-spark/ ,
  https://dev.meta.ai/docs/muse-spark-open/deploy , https://www.promptfoo.dev/docs/providers/meta/

## 10. Hackathon (verified on 27 October 2026)

Meta Global AI Developer Hackathon, virtual, 26 October to 4 November 2026, submissions due
4 November 9:00 PM ET, judging 4 to 8 November, winners 9 November. Tracks: Indie Developer
(creativity, technical ambition, whether it works) and Startup (technical execution, production
readiness). Themes: "Build for Your World" and "Push the Frontier". Official rules and the
participant guide are on the Cerebral Valley event page; the submission portal and the exact
deliverables (repository, video length) must be confirmed there before submitting.
Source: https://dev.meta.ai/events/global-hackathon

## 11. Risks and integration boundaries

| Risk | Decision |
|---|---|
| MoranBuy cannot verify Moran JWTs (separate secret) | MoranBuy never shares `JWT_SECRET`. A registered merchant links by signing in with Moran credentials through Moran's own `POST /api/auth/login` (+ `/2fa`) and `GET /api/auth/me`; MoranBuy keeps the Moran refresh token encrypted for product sync |
| Cross-tenant product edits | Every Moran call carries the linked tenant's own token; MoranBuy never calls `/internal/*` with the n8n key for merchant data |
| Marketing from one shared number for many merchants | Not supported. A merchant campaign sends only from that merchant's own connected WhatsApp number (registered merchants). Standalone merchants can draft and price campaigns but cannot dispatch until a sender is connected |
| Opt-in by default in Moran | MoranBuy audiences require a recorded consent event for the purpose and merchant; unknown contacts are excluded |
| Fake telemetry or approvals | Muse telemetry is written from real requests only; template status comes only from Meta via Moran's lifecycle |
| Production data | All development runs on a local Postgres/Redis. No migration touches Moran's database; MoranBuy has its own database |
| Secrets | `.env` is git-ignored; a pre-commit hook mirrors Moran's refusal to commit env files and keys |

## 12. Tests planned against these findings

- Ranking fixtures A to G from the brief (unit, no infrastructure).
- Moran adapter contract tests against a fake Moran server that answers the real routes above.
- Integration tests on a real Postgres and Redis (migrations, tenant boundaries, entitlements, consent, campaign dispatch gates, follow-up stop rules, webhook idempotency).
- Security tests (admin auth, cross-tenant access, webhook signatures, secret redaction).
