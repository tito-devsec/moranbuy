# Budget-first, location-second ranking

The ranking lives in `packages/budget-matching` and `packages/location-ranking`. It is plain
application code with fixture tests (`tests/unit/ranking.test.js`). No language model takes part.

## Inputs

A validated shopping request (`packages/reverse-marketplace/src/request.js`): product type,
essential and preferred attributes, maximum budget, currency, quantity, customer location (only
when shared or geocoded from a place the customer named), fulfilment preference.

Offers (`packages/reverse-marketplace/src/discover.js`): active listings with their merchant,
default location, delivery facts and provenance. Unknown values stay `null`.

## Stages

**A. Hard constraints** (`exclusionReason`). Out: deleted, inactive or archived listings, suspended
merchants, currency mismatch, no price, out of stock or not enough stock for the quantity, and
any listing that fails an essential attribute or the product type. Duplicates of the same source
product are collapsed to the freshest row. Every exclusion is kept with its reason.

**Cost** (`computeCost`):
`known_total = unit_price × quantity + known_mandatory_fees + known_delivery_fee`.
A delivery fee applies when the customer wants delivery, or wants either and the merchant offers
delivery. An unknown fee is listed in `unknownParts` and `totalConfirmed` becomes `false`. Unknown is
never added as zero.

**B. Budget priority** (`budgetFit`). `fits` when the confirmed total is within budget,
`unconfirmed` when known parts fit but something is unknown, `over` otherwise with the shortfall.
Over-budget offers go to a separate list, shown up to 25% above budget (policy
`overBudgetShowPct`), or the two cheapest when nothing fits so the customer sees the real gap.

**C. Suitability** (`assessSuitability`). Essentials are binary. Preferred attributes give a ratio
that puts offers into buckets (high, mid, low) so "similarly suitable" offers are compared on
price, not on cosmetic differences.

**D. Location** (`assessLocation`). Haversine distance when both coordinates are known, delivery
reach from the merchant's stated radius, pickup availability, and the customer's preference. A
score from 0 to 100; unknown distance or delivery is flagged, never estimated.

**E. Trust**. Merchant verification, verified price, known stock, freshness (stale after
`staleAfterDays`), and a suspicious-price flag when an unverified price is below
`suspiciousBelowMedianPct` of the eligible median. A flagged offer sinks to the bottom and is
labelled "needs confirmation".

## The sort

Within the in-budget list, in this order:

1. offers that need price confirmation last;
2. suitability bucket (high first);
3. price band: totals are bucketed by `max(priceSimilarityMin, priceSimilarityPct% of budget)` from
   the cheapest offer, so a cheaper band always wins and only offers of similar total fall through to
4. location score, then
5. trust score, then exact total, then suitability score.

This is what makes budget first and location second: location decides only between offers whose
known totals are similar. It also means an offer "slightly under budget" never beats one with a
lower verified total unless they are in the same band.

## Policy values

`DEFAULT_POLICY` in `rank.js`: `priceSimilarityPct` 2, `priceSimilarityMin` 2000,
`staleAfterDays` 45, `suspiciousBelowMedianPct` 25, `overBudgetShowPct` 25. The API reads
overrides from `platform_settings.ranking_policy`; the admin app changes it only through an
audited action (Phase 10). Every matching run stores the policy that was in force.

## Evidence

Each run writes `matching_runs` (request, policy, counts, exclusions, Muse status, duration) and one
`matching_offers` row per ranked or over-budget offer with its cost, budget fit, suitability,
location, trust and reasons. `GET /api/shop/runs/:id` returns it; the admin app renders it.

## Worked example (test Case A)

Budget TSh 350,000, delivery wanted, customer in Sinza.
A: TSh 290,000, 12 km away. B: TSh 340,000, 0.7 km. C: TSh 360,000, 0.7 km.
Result: A first (lowest known total), B second, C in the over-budget list with a shortfall of TSh 10,000.
With delivery fees A TSh 60,000 and B TSh 10,000 (Case B) the totals become 350,000 and 330,000
and B ranks first.
