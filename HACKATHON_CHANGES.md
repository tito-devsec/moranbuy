# Hackathon changes

MoranBuy is built for the Meta Global AI Developer Hackathon (26 October to 4 November 2026).
This file lists what is new in this repository and the evidence for it. It is updated with every phase.

## What existed before (Moran AI, not part of this submission)

- Moran AI backend: multi-tenant WhatsApp sales and support agents, product catalogue with Meta
  catalog sync, business locations, WhatsApp templates and its own campaign and follow-up tooling,
  Snippe mobile-money payments, Super Admin dashboard. See `docs/existing-system-assessment.md`.

## What is new in this repository

| Area | Status | Evidence |
|---|---|---|
| Repository, policies, CI, configuration validation, foundation schema | done | `.github/workflows/ci.yml`, `services/api/src/db/migrations/` |
| Customer web chat and WhatsApp intake through Moran's forwarded webhook | done | `apps/customer/index.html`, `services/api/src/routes/shop.js`, `services/api/src/routes/internal-inbound.js` |
| Reverse-marketplace engine with budget-first, location-second ranking | done | `packages/budget-matching`, `packages/location-ranking`, `packages/reverse-marketplace`; `tests/unit/ranking.test.js` (cases A to G and more), `tests/integration/shopping-flow.test.js` |
| Muse Spark integration (Meta Model API, `muse-spark-1.3`) with real telemetry | done (client, extraction, drafting, telemetry); live key still to be supplied by the owner | `packages/muse-intelligence`, `tests/integration/muse-client.test.js`, `docs/muse-integration.md` |
| Merchant management, Moran product link and import without duplicates, locations, source-of-truth rules | done | `packages/merchant-management`, `packages/product-catalog`, `tests/integration/merchants.test.js`, `docs/merchant-registration.md` |
| Entitlements enforced server-side and the business app | done (app pages for campaigns, outreach and follow-up arrive with Phase 7 to 8) | `packages/authorization`, `apps/business/`, `tests/integration/merchants.test.js` |
| New campaign engine (drafting, review, templates through Moran, pricing, server-verified payment, eight dispatch gates, explicit confirmation, idempotent worker) and new-product outreach offers | done; live sending stays dry-run until the owner configures the provider rate and a payment provider | `packages/campaign-engine`, `packages/campaign-outreach`, `packages/billing`, `tests/integration/engagement.test.js`, `docs/campaign-workflow.md` |
| Optional paid follow-up engine (ask first, decline activates nothing, leads, schedules, stop rules, idempotent worker) | done | `packages/followup-engine`, `tests/integration/engagement.test.js`, `docs/followup-workflow.md` |
| Consent management (append-only events, per-merchant purposes, STOP handling, audience exclusion reasons, send-time recheck, erasure) | done | `packages/consent-management`, `docs/privacy-and-consent.md` |
| MoranBuy Admin (merchants, verification, entitlements, ranking evidence and audited policy, consent lookup, campaigns, templates, follow-up, orders, billing and refunds, Muse telemetry with real test-connection, integration health, audit, settings) | done | `services/api/src/routes/admin.js`, `apps/admin/`, `tests/security/admin-and-tenancy.test.js` |
| Moran-side integration: migration, register-MoranBuy admin route and button, forwarding webhook, signed internal router, owner listing switch, dashboard header entry, as a reviewed patch plus new files | done as a patch, not applied to production | `integrations/moran-backend/`, Moran's unit suite run on the patched tree (`docs/testing.md`) |
| Hermes research agent config and skill, research client with allow-list and robots.txt, unverified web offers in ranking | done; off by default | `integrations/hermes/`, `packages/integrations/src/research.js`, `tests/unit/research.test.js` |

Nothing above is claimed as working until its row says "done" and names a test or a run.

| Runtime credentials entered in Admin (Muse Spark, Snippe, Hermes) and the buy.moranai.co.tz deployment stack | done; the VPS steps are the owner's | `services/api/src/services/runtime-settings.js`, `tests/integration/credentials.test.js`, `deploy/` |

| MoranBuy managed from Moran's Super Admin: setup wizard (register, connect WhatsApp, name, open), signed identity-carrying proxy, proxied-admin acceptance with replay and tamper tests | done as part of the Moran patch; UI verified by syntax and import only (no browser run here) | `integrations/moran-backend/files/admin-pages-moranbuy.js`, `services/api/src/middleware/proxied-admin.js`, `tests/security/proxied-admin.test.js` |

| Opted-in Moran businesses appear automatically; order alerts answered by WhatsApp for businesses without a dashboard; customer status messages | done | `packages/product-catalog/src/moran-listings-sync.js`, `services/api/src/services/order-actions.js`, `tests/integration/moran-listings-pull.test.js`, `tests/integration/order-replies.test.js` |

| Terms and privacy gate with reply buttons on WhatsApp and web, versioned, bilingual policy pages | done | `services/api/src/services/terms.js`, `apps/customer/terms.html`, `apps/customer/privacy.html`, `tests/integration/terms-gate.test.js` |

## Still open for the owner

- An Azure Speech key and region in Super Admin → MoranBuy → Credentials for spoken replies (Meta's API has no text to speech). Voice notes need only the Meta Model API key.
- Service prices: set them in Super Admin → MoranBuy → Billing before a business can pay for a service.

- A Meta Model API key (`MUSE_API_KEY`) so Muse Spark runs live; every Muse path is tested with fakes and the admin page shows the real status.
- Apply the Moran patch, register MoranBuy in Super Admin and connect its WhatsApp number.
- Snippe credentials and the WhatsApp provider rate for campaign pricing.
- Set the repository description on GitHub (settings writes are not possible from the build session).
