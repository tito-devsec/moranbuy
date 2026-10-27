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
| Merchant management, Moran product link and import | planned (Phase 5) | |
| Entitlements and business app | planned (Phase 6) | |
| New campaign engine and new-product outreach | planned (Phase 7) | |
| Optional paid follow-up engine | planned (Phase 8) | |
| Consent management | planned (Phase 9) | |
| MoranBuy Admin with real Muse telemetry | planned (Phase 10) | |
| Moran-side integration drop-ins and Hermes research skill | planned (Phase 10) | |

Nothing above is claimed as working until its row says "done" and names a test or a run.
