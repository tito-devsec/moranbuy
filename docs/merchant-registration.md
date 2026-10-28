# Merchant registration and products

## Two kinds of merchant

| | Standalone MoranBuy merchant | Registered Moran AI business |
|---|---|---|
| Signs up | `POST /api/merchants/auth/register` or the business app | "Link Moran AI account" with their own Moran credentials (`POST /api/merchants/auth/link-moran`, two-factor relayed) |
| Identity | `merchants.registration_type = standalone` | `registration_type = moran`, `moran_tenant_id` set, Moran refresh token stored encrypted |
| Products | created and edited in MoranBuy | imported from Moran with `POST /api/merchant/sync/moran`; keyed by `(source, source_merchant_ref, source_product_id)` so a re-sync updates in place |
| Locations | created in MoranBuy, geocoded or pinned | imported read-only from Moran's business locations; delivery reach from Moran's radius, fee unknown unless stated |
| Later | can link Moran with `POST /api/merchants/auth/link-moran/attach` and keep its id, listings and orders | |

## Businesses that appear by themselves

A worker (`moran-listings-pull`, every 10 minutes, a full pass every 6 hours) reads Moran's
`/internal/moranbuy/listings`: every business whose owner switched on "List my products on
MoranBuy" becomes a MoranBuy merchant automatically (`registration_type = moran`, no login, owner
WhatsApp number as contact, verified when its number is connected), with its default location and
products. Re-pulls update in place; a full pass archives products no longer listed. The owner can
claim the merchant later with "Link Moran AI account", keeping its id, orders and listings. Admins
can pull on demand from Integration Health.

## Source of truth

For an imported product, Moran owns `name, description, price, currency, stock, status, imageUrl,
category, condition` and variants. MoranBuy refuses those fields locally (`FIELD_OWNED_BY_MORAN`)
and changes them through `PATCH /api/merchant/listings/:id/moran`, which calls Moran's own
`PATCH /api/products/:id` with the merchant's token and then re-syncs. MoranBuy owns
`productType, attributes, moranbuyVisible, locationIds` on every listing. Products that disappear
from Moran are archived, never deleted.

## Entitlements

`merchant_entitlements` holds one row per service: `product_listing` (free, active on
registration), `campaign_engine`, `new_product_outreach`, `paid_followup`, `conversation_agent`
(Moran-linked merchants only). Selecting a paid service records `pending_payment / unpaid`.
`requireEntitlement(service)` refuses any route unless the row is `active` and `paid` or `free` and
unexpired. Activation happens only after a verified payment or an audited admin action.

## Tests

`tests/integration/merchants.test.js` with a fake Moran server: registration, duplicate email,
unactivated paid service refused, locations with and without a found position, listings, stock
to status, tenant boundaries (read, edit, delete, foreign location link), Moran link with wrong
and right credentials, import, duplicate-free re-sync, archiving, Moran-owned field refusal and
edit via Moran, two-factor link.
