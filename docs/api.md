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
- `POST /api/shop/uploads?customerToken=&kind=photo|voice` a photo (JPEG, PNG, WebP) or a voice recording (WAV or Ogg Opus) after accepting the terms; a voice upload returns what Muse heard (`transcript`); send the id as `photoUploadId` or `voiceUploadId` with the next message, whose response carries `voiceReply.dataUrl` when spoken replies are on
- `GET /media/:name` public product photos
- `POST /internal/inbound` signed by Moran (`X-MoranBuy-Timestamp`, `X-MoranBuy-Signature`): `{ messageId, from, text, imageUrl?, location?, name? }`

## Merchant auth
- `POST /api/merchants/auth/register`, `/login`, `/refresh`, `/logout`, `GET /me`
- `POST /api/merchants/auth/link-moran` `{ email, password }` or `{ twoFactorToken, twoFactorCode }` (202 when a code is needed)
- `POST /api/merchants/auth/link-moran/attach` (signed-in standalone merchant links Moran)

## Merchant
- `GET|PATCH /api/merchant/profile`, `POST /services`, `POST /verification`
- `GET|POST /api/merchant/listings`, `GET|PATCH|DELETE /listings/:id`, `PATCH /listings/:id/moran` (Moran-owned fields), `POST /sync/moran`
- `GET|POST /api/merchant/locations`, `PATCH|DELETE /locations/:id`
- `GET /api/merchant/orders`, `POST /orders/:id/status` (also mirrored to the Moran order for linked businesses, `moranSync` in the response), `GET /enquiries`
- `POST /uploads?purpose=product_image|verification_document&name=` (the file is the request body with its content type), `GET /uploads`, `GET /uploads/:id/file`, `DELETE /uploads/:id` (refused while a product or a pending verification uses it); `POST /verification` takes `documentUploadIds`
- `GET /insights?days=&language=` (demand overview for this business), `GET /schedules` (customer schedules tied to this business)
- `GET /services/pricing`, `POST /services/:service/pay` `{ phone? }` (starts a payment; a pending one under 15 minutes old is returned again; `409 SERVICE_NOT_PRICED` until an admin sets a price), `GET /payments`
- `GET|POST /api/merchant/contacts`, `GET /contacts/:phone/consent`, `DELETE /contacts/:phone`

## Campaigns (entitlement `campaign_engine`)
- `POST /:id/confirm` `{ confirm: true, sendAt? }` sends now or schedules (08:00 to 21:00 Tanzania time, 5 minutes to 60 days ahead); `POST /:id/unschedule` takes a scheduled campaign back to ready
- `GET|POST /api/merchant/campaigns/templates`, `PATCH /templates/:id`, `POST /templates/:id/submit`, `POST /templates/:id/refresh`
- `GET /api/merchant/campaigns/sender`
- `GET|POST /api/merchant/campaigns`, `GET|PATCH /:id`, `POST /:id/draft` `{ revision? }`, `/approve`, `/price`, `/pay` `{ phone? }`, `/readiness`, `/confirm` `{ confirm: true }`, `/pause`, `/resume`
- `GET /api/merchant/campaigns/outreach/offers`, `POST /outreach/offers/:id/answer` `{ accept }`

## Follow-up
- `GET /api/merchant/followup/offer`, `POST /offer/answer` `{ accept }`
- `GET /register/:token`, `POST /register/:token/accept-policy` (the acceptance link's steps)
- entitlement `paid_followup`: `GET|PATCH /settings`, `GET|POST /leads`, `POST /leads/:id/stop`, `POST /leads/summary`

## Payments
- `POST /webhooks/payments` (Snippe, signed over the raw body)
- `POST /api/sandbox/payments/:reference/settle` (not in production)
- A completed settlement of a payment with purpose `entitlement` activates that service for `periodDays` (default 30); nothing else activates a paid service automatically.

## Payment protection

- Customers on WhatsApp: `LIPA|PAY MB-…` (pay again), `NIMEPOKEA|RECEIVED MB-…` (release now), `TATIZO|PROBLEM MB-… <details>` (hidden defect, opens a dispute), `SIJAPOKEA MB-…` (refused once the code was used), `RISITI|RECEIPT [MB-…]`, `ODA ZANGU|MY ORDERS` (a list; each row `rcpt:<ref>` sends that receipt). Refusal confirmation buttons `cust:rej_yes:<ref>` and `cust:rej_no:<ref>`.
- Business owners on WhatsApp: `MSAFIRISHAJI|DELIVERER MB-… <phone> [name]`.
- Delivery person on WhatsApp: buttons `dlv:arrived|rejected|absent:<ref>`, then a photo, the customer's code, a shared location, or the refusal reason (text or voice).
- `POST /api/merchant/orders/:id/deliverer` `{ phone, name? }` · `GET /api/merchant/orders/:id/receipt.pdf` · `PUT /api/merchant/payout` `{ ownerName, payoutPhone }`
- `GET /r/:receiptNo?c=<check code>` public receipt check (404 unless the code matches).
- Admin: `GET /api/admin/protection`, `GET /api/admin/protection/:orderId` (evidence timeline), `GET /api/admin/protection/:orderId/receipt` (base64 PDF), `POST /api/admin/disputes/:id/summarize` (Muse, advice only), `POST /api/admin/disputes/:id/resolve` `{ decision: release|refund, note }` (super admin), `POST /api/admin/protection/:orderId/payout/retry` `{ kind, reason }` (super admin), `PUT /api/admin/protection/settings` (super admin, audited).
- Snippe payouts report on the same `/webhooks/payments` (`payout.completed|failed|reversed`).

## Moran channel (signed, `MORAN_SHARED_SECRET`)
- `POST /internal/inbound` customer messages, button replies, locations, and photos or voice notes as raw bytes (`kind: "image" | "audio"`, `media: { base64, mime }`) from the MoranBuy number; a registered business's own number may send a product ("Bidhaa: ...") or ask "RIPOTI"
- `POST /internal/inbound/status` `{ statuses: [{ id, status, errors? }] }` delivery receipts for messages MoranBuy sent

## Admin

Reached from Moran AI's Super Admin through `ALL /api/admin/moranbuy/api/*` on the Moran backend,
which signs each request (`X-MoranBuy-Timestamp`, `X-MoranBuy-Signature` over timestamp, method,
path and body) and carries `X-MoranBuy-Admin-Email`, `-Name`, `-Role`. The same routes accept a
MoranBuy admin token for the fallback app.

- `GET /listings?search=&merchantId=&source=&status=&category=&priceMin=&priceMax=&flag=&sort=&page=&pageSize=&format=json|csv|csv_json` (products across all businesses with problem flags and totals; `csv_json` returns the CSV inside JSON for the Super Admin proxy; exports are audited), `POST /listings/:id/visibility` `{ visible, reason }` (hide from customer search or show again)
- `GET /locations?search=&merchantId=&region=&source=&placed=yes|no&delivery=yes|no|unknown&page=&pageSize=` (locations with what each is missing, coverage by region, businesses selling with no placed location), `POST /locations/:id/position` `{ latitude, longitude, region?, district?, reason }` (MoranBuy-owned locations only, inside Tanzania)
- `GET /queues` (Redis work queues and their dead jobs), `POST /queues/:name/retry-dead` `{ reason }`
- `GET /muse/cost?days=` (cost by day, feature and business, month to date, budget), `PUT /muse/pricing` `{ inputPerMillionUsd?, outputPerMillionUsd?, usdToTzs?, monthlyBudgetUsd?, hardCap?, applyToPast?, reason }`
- `POST /summary` `{ section: overview|campaigns|followup|orders|payments|muse|demand|retention }` → counts, rule checks and Muse's reading (20 per minute)
- `GET /merchants/:id/uploads`, `GET /uploads/:id` (a private file as base64 for review; audited)
- `GET /insights?days=&merchantId=&language=`, `GET /schedules`, `GET /catalog-uploads`
- `GET|PUT /service-pricing` `{ campaign_engine?, new_product_outreach?, paid_followup?: { monthlyTzs|null, periodDays }, reason }`
- `PUT /credentials/tts` `{ provider: meta_mms|disabled, mode: mirror|always|off, reason }` (spoken replies with Meta's MMS voices; super admin)
- `GET|PUT /retention` (keep periods in days, floors, last preview and purge), `POST /retention/run` `{ dryRun, confirm?, reason }` (a real purge: super admin and `confirm: true`)
- `GET|PUT /notifications/schedule-reminder` `{ enabled?, templateName?, templateLanguage?, textSw?, textEn?, templateParams?, quietFrom?, quietTo?, reason }`
- `GET|PUT /notifications/order-confirmed` (owner alert wording, approved template name, recent sends)
- `GET|PUT /credentials/:group` (`muse`, `snippe`, `hermes`; super_admin), `GET|PUT /agent-profile`
- `POST /api/admin/auth/login`, `/auth/refresh`, `GET /me`, `GET /overview`
- `GET /merchants?type=&status=&verification=&search=`, `GET /merchants/:id`, `POST /merchants/:id/verification`, `POST /merchants/:id/status`, `POST /merchants/:id/entitlements/:service`
- `GET /ranking/runs`, `GET /ranking/runs/:id`, `GET|PUT /ranking/policy` (reason required, audited)
- `GET /consent/:phone`
- `GET /campaigns`, `GET /campaigns/:id`, `POST /campaigns/:id/pause`, `GET /templates`, `GET /followup`, `GET /orders`
- `GET /payments`, `POST /payments/:id/refund`, `GET|PUT /pricing`
- `GET /muse`, `POST /muse/test`, `GET /integrations`, `GET /audit`, `GET /settings`, `POST /admins`
