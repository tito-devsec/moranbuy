# MoranBuy

MoranBuy is an AI-powered reverse marketplace. Customers describe the product they need and the
budget they can afford. MoranBuy discovers eligible business offers and brings the most suitable
matches to the customer, prioritizing budget fit and total cost before location convenience.

> Build status: Phase 9 of 15 done. The reverse-marketplace engine, budget-first ranking, Muse Spark
> client, customer web chat and the signed WhatsApp intake from Moran AI are implemented and tested.
> Merchant platform, campaign engine, follow-up engine, consent management and the admin app are
> being built phase by phase. `HACKATHON_CHANGES.md` says exactly what works today.

## The problem

A customer in Dar es Salaam who wants a three-seater sofa for TSh 350,000 has to visit shops, message
sellers one by one, and repeat the same requirements each time. Businesses with the right product at
the right price never hear from that customer.

## The reverse-marketplace model

The customer does not browse a catalogue. The customer sends one message:

> Nina TSh 350,000 ya sofa ya watu watatu. Nipo Sinza, Dar es Salaam. Nataka delivery ikiwezekana.

MoranBuy understands the product (three-seater sofa), the maximum budget (TSh 350,000), the
location (Sinza, Dar es Salaam) and the fulfilment preference (delivery if available). It then finds
real products from eligible merchants, ranks them, and presents the best offers.

## Budget first, location second

Ranking is deterministic application code, never left to a language model:

1. **Hard constraints**: essential product requirements, quantity, currency, budget.
   `known_total_cost = product_price + known_mandatory_fees + known_delivery_cost`.
   An unknown delivery cost is recorded as unknown and disclosed, never added as zero.
2. **Budget priority**: within-budget offers before over-budget ones; lower known total cost first
   among similarly suitable offers; over-budget alternatives shown separately.
3. **Product suitability**: deterministic attribute matching against verified product data.
4. **Location priority**: among budget-competitive, suitable offers, the more convenient location
   ranks higher (distance, delivery availability, known delivery charge, pickup feasibility).
5. **Trust and availability**: verification, stock and fulfilment signals refine the order without
   hiding uncertainty.

A nearby merchant's higher price never automatically beats a substantially cheaper, suitable offer
within budget. No price, product, distance, stock level or delivery fee is ever fabricated.

## Who MoranBuy is for

- **Customers**: ask on WhatsApp or the web, get ranked offers with a cost breakdown, confirm an order explicitly.
- **Businesses**: standalone merchants register, list products and locations, and receive enquiries;
  registered Moran AI businesses link their account and their existing products appear in MoranBuy
  without re-uploading.
- **MoranBuy Admin**: merchants, verification, ranking evidence, consent, campaigns, follow-up,
  billing, Muse Spark telemetry, integration health and audit logs.

## Muse Spark

MoranBuy uses Muse Spark on the Meta Model API (`https://api.meta.ai/v1`, model `muse-spark-1.3`)
to understand natural-language shopping requests in Swahili and English, interpret product photos,
extract attributes and constraints, draft recommendations from matched data, draft and revise
campaign messages, and summarise follow-up leads. Muse Spark never decides prices, budgets,
rankings, consent, authorization, payments or order state; deterministic code does. If Muse Spark
is unavailable, MoranBuy says so and uses only configured fallback behaviour.
See `docs/muse-integration.md`.

## Campaigns, outreach and follow-up

This repository introduces a new MoranBuy campaign engine, new-product promotional outreach and an
optional paid follow-up system. These are newly implemented MoranBuy capabilities that integrate
with existing Moran AI infrastructure where necessary; they are not presented as pre-existing
Moran AI campaign-engine features. A campaign dispatches only after consent, sender eligibility,
template approval, payment verification, rate limits and an explicit confirmation are all verified.
Follow-up is optional, activated only after the merchant explicitly accepts it.

## Existing Moran AI integration boundaries

MoranBuy keeps its own database and never reads Moran AI's. It talks to Moran AI through:

- the owner API with a linked merchant's own token (products, locations, template lifecycle);
- a signed internal channel for the admin-managed MoranBuy business (inbound customer messages
  forwarded from Moran, outbound replies through Moran's outbound gate, listings of businesses
  that opted in, admin-provided knowledge).

The Moran-side pieces are shipped from this repository under `integrations/moran-backend/` as
drop-in files for the Moran AI owner to review and apply. `docs/existing-system-assessment.md`
records what exists in Moran AI today.

## Repository layout

```
services/api/          Express API, middleware, workers, Knex migrations
packages/*             core, reverse-marketplace, budget-matching, location-ranking, muse-intelligence,
                       product-catalog, merchant-management, campaign-engine, campaign-outreach,
                       followup-engine, consent-management, billing, authorization, integrations, observability
apps/customer|business|admin   static web apps served by the API
integrations/          Moran-side drop-ins and the Hermes research agent configuration
tests/unit|integration|security|end-to-end
docs/                  architecture, assessment, ranking, Muse, workflows, API, deployment, testing, demo
```

## Install and run

```bash
npm install
cp .env.example .env     # set DATABASE_URL, REDIS_URL, AUTH_SECRET, ENCRYPTION_KEY
npm run hooks
npm run migrate
npm run dev              # http://localhost:4000/health
```

Or `docker compose up` for Postgres, Redis, the API and the workers.

## Tests

```bash
npm run lint && npm run check && npm test
npm run test:integration && npm run test:security && npm run test:e2e
```

CI (`.github/workflows/ci.yml`) runs all of these on every push against Postgres and Redis and also
rolls every migration back and forward. Results are honest: a failing check fails the build.

## Security and privacy

Secrets live only in `.env` (git-ignored, blocked by the pre-commit hook). Logs redact tokens and
phone numbers. Consent is recorded per purpose, channel and merchant, and rechecked at dispatch.
Report vulnerabilities privately as described in `SECURITY.md`.

## License and contributing

Apache License 2.0 (`LICENSE`). Existing Moran AI code remains the property of its owner and is not
relicensed here. See `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md` and the issue templates.

## Hackathon

Built for the Meta Global AI Developer Hackathon. `HACKATHON_CHANGES.md` lists the new work with
evidence; `docs/demo-script.md` (Phase 13) is the three-minute demo.

## Known limitations (today)

- The admin app, Moran-side drop-ins and Hermes research skill are not built yet (Phase 10).
- The WhatsApp provider rate for campaign pricing must be configured by an administrator; until then campaigns cannot be paid.
- Over WhatsApp, MoranBuy answers only once the Moran-side forwarding (shipped in `integrations/moran-backend/`, Phase 10) is applied and the MoranBuy business is registered in Super Admin.
- Muse Spark is in US public preview; access needs a Meta Model API key.
- Live campaign and follow-up sending stays in dry-run until every gate is verified in production.
