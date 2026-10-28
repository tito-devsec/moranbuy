# Changelog

All notable changes to MoranBuy are recorded here. Dates are in UTC.

## Unreleased

### 2026-10-28
- Terms gate: the terms and privacy question with Accept and Reject buttons before anyone is answered, repeated until accepted, versioned and editable in Super Admin; bilingual terms and privacy pages at /terms and /privacy; customers told when the merchant marks an order delivered.
- Scheduled pull of opted-in Moran businesses and products (auto-created merchants, duplicate-free, archiving on a full pass, manual pull from admin); merchants answer order alerts by WhatsApp reply (accept with delivery fee, reject, delivered) or from the dashboard; customers are told the merchant's decision.
- Owner alert on confirmed orders: WhatsApp text or approved template from the MoranBuy number, wording and template set in Super Admin → MoranBuy → Notifications, every outcome recorded in `merchant_notifications`.
- Super Admin integration: a MoranBuy page in weare.moranai.co.tz (register, connect to WhatsApp with Embedded Signup, choose the name, open the dashboard), a signed admin proxy on the Moran backend that carries the admin's identity, MoranBuy accepts it in place of its own login, agent name greeting, weare CSP for Facebook.
- Go-live: admin-entered credentials for Muse Spark, Snippe and Hermes (encrypted, masked, audited, used at runtime without restart), production Compose stack, Nginx site and `.env` example for buy.moranai.co.tz, VPS guide.
- Phase 10 to 15: admin API and app, Moran-side integration patch and drop-in files, Hermes research agent config, skill and client with unverified web offers, security tests, demo seed, architecture, API, deployment, testing and demo docs.
- Phase 7 to 9: campaign engine with templates, Muse drafting with grounding check, audience resolution with exclusion reasons, pricing with configured rates, sandbox and Snippe payment providers with server-side settlement, dispatch gates, explicit confirmation, recipient ledger and worker; new-product outreach offers; optional paid follow-up with offer, leads, schedules, stop rules and worker; consent events, STOP handling and contact erasure; business app tabs for campaigns and follow-up.
- Phase 5 and 6: merchant registration and sign-in, Moran AI account linking with two-factor relay, product and location import keyed by source ids, source-of-truth rules for Moran-owned fields, locations with geocoding or pins, orders and enquiries for merchants, entitlement records enforced in middleware, business app.

### 2026-10-27
- Phase 4: reverse-marketplace engine (structured requests, deterministic fallback parser, clarification, discovery, budget-first ranking with evidence, presentation, selection and explicit order confirmation), Muse Spark client with real telemetry, customer web chat, signed inbound channel from Moran, catalogue and shopping migrations.
- Phase 1: existing-system assessment and implementation plan (`docs/`).
- Phase 2: repository skeleton with npm workspaces, configuration validation, health and readiness routes, foundation migration, lint and syntax checks, CI workflow, Docker Compose, policies and issue templates.
