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
| Reverse-marketplace engine with budget-first, location-second ranking | planned (Phase 4) | |
| Muse Spark integration (Meta Model API) | planned (Phase 4) | |
| Merchant management, Moran product link and import | planned (Phase 5) | |
| Entitlements and business app | planned (Phase 6) | |
| New campaign engine and new-product outreach | planned (Phase 7) | |
| Optional paid follow-up engine | planned (Phase 8) | |
| Consent management | planned (Phase 9) | |
| MoranBuy Admin with real Muse telemetry | planned (Phase 10) | |
| Moran-side integration drop-ins and Hermes research skill | planned (Phase 10) | |

Nothing above is claimed as working until its row says "done" and names a test or a run.
