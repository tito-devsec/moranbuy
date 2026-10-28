# API

All responses are JSON. Errors are `{ error: CODE, message, details? }`. Merchant routes need
`Authorization: Bearer <merchant access token>`; admin routes need an admin token. Access tokens
last 15 minutes; refresh tokens rotate.

## Health
- `GET /health`, `GET /ready` (database and Redis state)

## Shopping (customers)
- `POST /api/shop/messages` `{ customerToken?, text, imageUrl?, location?, language? }` → replies, session state, run id
- `GET /api/shop/runs/:id` ranking evidence
- `GET /api/shop/orders/:ref` order status
- `POST /internal/inbound` signed by Moran (`X-MoranBuy-Timestamp`, `X-MoranBuy-Signature`): `{ messageId, from, text, imageUrl?, location?, name? }`

## Merchant auth
- `POST /api/merchants/auth/register`, `/login`, `/refresh`, `/logout`, `GET /me`
- `POST /api/merchants/auth/link-moran` `{ email, password }` or `{ twoFactorToken, twoFactorCode }` (202 when a code is needed)
- `POST /api/merchants/auth/link-moran/attach` (signed-in standalone merchant links Moran)

## Merchant
- `GET|PATCH /api/merchant/profile`, `POST /services`, `POST /verification`
- `GET|POST /api/merchant/listings`, `GET|PATCH|DELETE /listings/:id`, `PATCH /listings/:id/moran` (Moran-owned fields), `POST /sync/moran`
- `GET|POST /api/merchant/locations`, `PATCH|DELETE /locations/:id`
- `GET /api/merchant/orders`, `POST /orders/:id/status`, `GET /enquiries`
- `GET|POST /api/merchant/contacts`, `GET /contacts/:phone/consent`, `DELETE /contacts/:phone`

## Campaigns (entitlement `campaign_engine`)
- `GET|POST /api/merchant/campaigns/templates`, `PATCH /templates/:id`, `POST /templates/:id/submit`, `POST /templates/:id/refresh`
- `GET /api/merchant/campaigns/sender`
- `GET|POST /api/merchant/campaigns`, `GET|PATCH /:id`, `POST /:id/draft` `{ revision? }`, `/approve`, `/price`, `/pay` `{ phone? }`, `/readiness`, `/confirm` `{ confirm: true }`, `/pause`, `/resume`
- `GET /api/merchant/campaigns/outreach/offers`, `POST /outreach/offers/:id/answer` `{ accept }`

## Follow-up
- `GET /api/merchant/followup/offer`, `POST /offer/answer` `{ accept }`
- entitlement `paid_followup`: `GET|PATCH /settings`, `GET|POST /leads`, `POST /leads/:id/stop`, `POST /leads/summary`

## Payments
- `POST /webhooks/payments` (Snippe, signed over the raw body)
- `POST /api/sandbox/payments/:reference/settle` (not in production)

## Admin

Reached from Moran AI's Super Admin through `ALL /api/admin/moranbuy/api/*` on the Moran backend,
which signs each request (`X-MoranBuy-Timestamp`, `X-MoranBuy-Signature` over timestamp, method,
path and body) and carries `X-MoranBuy-Admin-Email`, `-Name`, `-Role`. The same routes accept a
MoranBuy admin token for the fallback app.

- `GET|PUT /credentials/:group` (`muse`, `snippe`, `hermes`; super_admin), `GET|PUT /agent-profile`
- `POST /api/admin/auth/login`, `/auth/refresh`, `GET /me`, `GET /overview`
- `GET /merchants?type=&status=&verification=&search=`, `GET /merchants/:id`, `POST /merchants/:id/verification`, `POST /merchants/:id/status`, `POST /merchants/:id/entitlements/:service`
- `GET /ranking/runs`, `GET /ranking/runs/:id`, `GET|PUT /ranking/policy` (reason required, audited)
- `GET /consent/:phone`
- `GET /campaigns`, `GET /campaigns/:id`, `POST /campaigns/:id/pause`, `GET /templates`, `GET /followup`, `GET /orders`
- `GET /payments`, `POST /payments/:id/refund`, `GET|PUT /pricing`
- `GET /muse`, `POST /muse/test`, `GET /integrations`, `GET /audit`, `GET /settings`, `POST /admins`
