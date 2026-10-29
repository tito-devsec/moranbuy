# Three-minute demo

Setup before recording: `docker compose up -d postgres redis`, `npm run migrate && npm run seed`,
`npm run dev`, `node scripts/demo-seed.mjs` (three furniture merchants around Sinza, one linked
Moran business, one admin). `MUSE_PROVIDER=meta` with a Meta Model API key if available; the
demo also runs with Muse disabled, and the run evidence shows which.

| Time | Scene | What to show |
|---|---|---|
| 0:00 | Customer need | WhatsApp, chat with `@moranbuy`: "Nina TSh 350,000 ya sofa ya watu watatu. Nipo Sinza, Dar es Salaam. Nataka delivery ikiwezekana." |
| 0:25 | Budget first, location second | Three offers: the cheaper farther shop first, the nearer one second, the over-budget one set apart with the shortfall. Open the run in Admin (Ranking): cost breakdown, unknown delivery fee disclosed, reasons |
| 0:55 | Choose and confirm | Reply "1", read-back of the known total, "ndio" creates an order `MB-…` pending with the merchant; `/business/` Orders tab shows it |
| 1:15 | Standalone merchant | `/business/`: register, add a location (geocoded or pinned), add a product; it appears in the next search |
| 1:35 | Registered Moran business | "Link Moran AI account", sync: existing products and locations appear with source Moran; price edit goes through Moran |
| 1:55 | Campaign engine | Publish a product → outreach offer asked → accept → Muse draft from facts → approve → audience with exclusion reasons → price → sandbox payment → gates → confirm (dry run) → ledger |
| 2:25 | Follow-up offer | Follow-up tab: the question; decline (nothing activates) then accept (registration link, service pending payment) |
| 2:40 | Admin | `/admin/`: merchants with entitlements, ranking evidence of the demo run, consent lookup, Muse telemetry with a real test-connection result, audit log |
| 2:55 | Repository | `HACKATHON_CHANGES.md`, CI green, test counts |

Say what is sandboxed: the payment is the sandbox provider, the campaign is a dry run, Meta template approval is simulated in tests only.
