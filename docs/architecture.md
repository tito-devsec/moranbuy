# Architecture

```
Customer (WhatsApp) ─► Meta ─► Moran webhook ─► [MoranBuy tenant?] ─signed POST─► MoranBuy /internal/inbound
Customer (web)      ─────────────────────────────────────────────────────────────► MoranBuy /api/shop/messages
                                                                                        │
                               ShoppingEngine: Muse reads ─► merge ─► clarify ─► discover ─► rank ─► present
                                                                                        │
                       replies ─signed POST─► Moran /internal/moranbuy/send ─► outbound gate ─► MoranBuy number ─► customer
                                                                                        │
                                                     explicit YES ─► orders (pending_merchant) ─► merchant app
Merchant (standalone) ─► business app ─► /api/merchant/* ─► listings, locations, orders, campaigns, follow-up
Merchant (Moran)      ─► link with own credentials ─► Moran owner API ─► import products and locations (keyed by source ids)
Moran businesses      ─► "List my products on MoranBuy" ─► Moran /internal/moranbuy/listings ─► MoranBuy listings (source = moran)
Admin                 ─► admin app ─► /api/admin/* ─► merchants, ranking evidence, consent, campaigns, Muse telemetry, audit
Workers               ─► campaign dispatch (ledger + Moran merchant sender), follow-up delivery
```

## Packages

| Package | Responsibility |
|---|---|
| `core` | configuration validation, errors, money, ids |
| `observability` | logger with redaction, `redact`, audit events |
| `authorization` | passwords, AES-GCM, JWT and refresh tokens, merchant and admin middleware, entitlements |
| `reverse-marketplace` | request schema, deterministic parser, clarification, discovery, presentation, `ShoppingEngine` |
| `budget-matching` | cost, suitability, the ranking pipeline and policy |
| `location-ranking` | haversine distance, delivery and pickup feasibility |
| `muse-intelligence` | Meta Model API client, extraction and drafting prompts, grounding check, telemetry |
| `product-catalog` | listings, locations, Moran product and location sync, source-of-truth rules |
| `merchant-management` | standalone registration, sign-in, Moran account link |
| `consent-management` | phone normalisation, consent events, audiences, opt-out keywords |
| `billing` | pricing from configured rates, sandbox and Snippe providers, payment records |
| `campaign-engine` | templates, campaign lifecycle, dispatch gates, recipient ledger worker, senders |
| `campaign-outreach` | new-product offers that must be answered |
| `followup-engine` | offer, leads, schedules, stop rules, delivery worker |
| `integrations` | HMAC signing, geocoder, Moran internal and owner clients, web research |

## Data

PostgreSQL (`services/api/src/db/migrations`): foundation (admins, merchants, users, refresh
tokens, entitlements, audit, webhook events, Muse telemetry, settings), catalogue (locations,
listings, images, listing-locations), shopping (customers, sessions, messages, matching runs and
offers, orders, enquiries), merchant details, engagement (contacts, consent events, templates,
payments, campaigns, recipients, follow-up leads and tasks). Every merchant-scoped table carries
`merchant_id` and every query filters by it.

Redis: rate limits and worker coordination. Nothing authoritative lives in Redis.

## Trust boundaries

- Moran ↔ MoranBuy: HMAC-SHA256 over timestamp and raw body with one shared secret; five-minute window; every inbound delivery de-duplicated by message id.
- Merchant ↔ Moran: the merchant's own Moran credentials and tokens; MoranBuy stores only an encrypted refresh token.
- Muse Spark: facts in, words out; numbers are checked against the facts; telemetry from real calls only.
- Payments: provider webhooks verified by signature; settlement is forward-only and amount-checked.
- Research (Hermes or plain fetch): off by default, allow-listed domains, results marked unverified and never ranked above verified in-budget offers.
