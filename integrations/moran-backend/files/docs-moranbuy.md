# MoranBuy inside Moran

MoranBuy (github.com/tito-devsec/moranbuy) is a reverse marketplace: a customer says what they
need and can afford, MoranBuy finds offers from businesses and ranks them budget first, location
second. Inside Moran it is **one admin-managed business** plus a signed channel.

## What this adds to Moran

| Piece | File |
|---|---|
| `tenants.admin_managed`, `tenants.moranbuy_listed`, `services.moranbuy_listed`, one `moranbuy` workspace | `src/db/migrations/20260101000103_moranbuy.js` |
| Register the MoranBuy business, sign and verify the channel, forward inbound, send from the MoranBuy number or a listed merchant's number, listings of listed businesses, MoranBuy knowledge | `src/services/moranbuy.service.js` |
| `/internal/moranbuy/*` (signed): `POST send` (text, image, buttons, template, and `audio` for spoken replies, the Ogg Opus bytes in the body), `POST send-template`, `GET listings`, `GET knowledge/search`, `POST orders` (a MoranBuy order into a listed business's own orders, `MB-` prefixed, idempotent), `PATCH orders/:orderRef` (status in step with MoranBuy) | `src/api/routes/moranbuy-internal.routes.js` |
| `/api/admin/moranbuy` (`GET`, `POST register`) | `src/api/routes/admin/moranbuy.routes.js` |
| `/api/moranbuy` (owner): `GET` status, `POST listing` the "List my products on MoranBuy" switch | `src/api/routes/moranbuy-owner.routes.js` |
| Webhook: a message to the MoranBuy tenant is forwarded instead of answered by an agent; voice notes and photos are downloaded and forwarded as raw bytes (MoranBuy hears and sees them with Meta's models; Moran's own transcription and vision are not used), before the media gate; delivery receipts for messages MoranBuy sent (kinds `moranbuy`, `moranbuy_merchant`, `moranbuy_campaign` in `message_usage_log`) are forwarded to MoranBuy's `/internal/inbound/status` | `src/api/routes/whatsapp-webhook.routes.js` |
| Owner login refused for admin-managed accounts | `src/api/routes/auth.routes.js` |
| Super Admin: "Register MoranBuy" on Businesses | `admin-frontend/assets/js/pages/businesses.js` |
| Super Admin → **MoranBuy** page (Operations): register, **Connect MoranBuy to WhatsApp** (Meta Embedded Signup, as an owner does), choose the name MoranBuy appears under, open the MoranBuy dashboard (merchants, ranking evidence, campaigns, follow-up, billing, Muse Spark key, Snippe keys, audit) | `admin-frontend/moranbuy.html`, `admin-frontend/assets/js/pages/moranbuy.js`, `assets/js/core/layout.js` |
| `/api/admin/moranbuy/signup-config`, `POST /whatsapp/connect`, `POST /profile`, and the signed proxy `ALL /api/admin/moranbuy/api/*` → MoranBuy's admin API carrying this admin's identity | `src/api/routes/admin/moranbuy.routes.js` |
| weare CSP allows Facebook's SDK and window for the connect step | `deploy/nginx.full.conf` |
| Owner dashboard: MoranBuy entry at the right of the header | `frontend/moran-app.js`, `frontend/config.js` (`MORANBUY_URL`) |

## Environment

```
MORANBUY_API_URL=https://buy.moranai.co.tz
MORANBUY_SHARED_SECRET=<long random, the same value in MoranBuy's MORAN_SHARED_SECRET>
```

## Running it

1. `npm run migrate`.
2. Super Admin → **MoranBuy** (Operations): step 1 Register MoranBuy (contact email; the owner login is refused by design), step 2 **Connect MoranBuy to WhatsApp** (Facebook window, same Embedded Signup as every business), step 3 the name MoranBuy appears under, step 4 **Open MoranBuy dashboard**. Its knowledge is written on the business page's Knowledge tab like any business.
4. In `frontend/config.js` set `MORANBUY_URL`; the MoranBuy entry appears in every owner's header.
5. A business owner switches on **List my products on MoranBuy** (`POST /api/moranbuy/listing`); only then do its products reach MoranBuy.

## What MoranBuy may and may not do here

- Reads: listed businesses' active products with their default location; the MoranBuy tenant's knowledge.
- Sends: from the MoranBuy number (replies to its own customers) and, for a listed business with a connected number, approved templates and texts to that business's customers. Every send passes `authorizeOutbound`.
- Never: the n8n key, Moran's database, another business's data, an unapproved template.
