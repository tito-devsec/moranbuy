# Campaign engine and new-product outreach

Newly implemented in this repository (`packages/campaign-engine`, `packages/campaign-outreach`,
`packages/billing`, `packages/consent-management`). Moran AI's own campaign tooling is not used;
Moran supplies only the template lifecycle with Meta and the merchant's own sender.

## Workflow

| Step | Endpoint | What happens |
|---|---|---|
| 1 | `POST /api/merchant/campaigns` | Needs an active `campaign_engine` entitlement. A draft row; the listing and template must belong to the merchant |
| 2 | `POST /:id/draft` | Muse Spark drafts from product and merchant facts; a draft whose numbers are not in the facts is replaced by the deterministic draft and the source is recorded (`muse`, `fallback_ungrounded`, `fallback_disabled`) |
| 3 | `PATCH /:id` with `draftBody`, `POST /:id/draft` with `revision` | The merchant edits or asks for a revision; every version is kept in `draft_history_json` |
| 4 | `PATCH /:id` with `mediaUrl` | An image or video header, used only when the template declares that header |
| 5 | `POST /:id/approve` | The merchant approves the words. Not a send |
| 6 | `POST /:id/price` | Audience resolved to consented contacts with every exclusion reason; cost split into provider charge, MoranBuy fee, tax, estimated total. The provider rate comes from `platform_settings.campaign_pricing`; unset, the total is reported unknown and payment is refused |
| 7 | `POST /:id/pay` | A payment is started (Snippe, or the sandbox outside production). Recorded `pending` |
| 8 | webhook / sandbox settle | The provider's signed event settles it server-side; an amount below the due amount never completes it |
| 9 | `POST /:id/readiness` | All gates: entitlement, payment, sender, template approved, draft approved, consent, rate limit, pricing. Results stored |
| 10 | `POST /:id/confirm` with `{confirm: true}` | Gates re-run; recipient ledger written with idempotency keys; status `dispatching`. Second confirmation refused |
| 11 | worker `processCampaignQueue` | Each recipient claimed with a conditional update, consent and template rechecked at send time, sent through the merchant's own number, status recorded; transient failures retried up to 3 times |
| 12 | `recordDeliveryStatus` | Delivery and read receipts move the ledger forward only |

No campaign dispatches because a draft exists or because a payment arrived.

## Sender identity

`senderEligibility`: only a merchant linked to Moran AI with a connected number may dispatch, from
that number (`sender_json = { kind: 'moran_tenant', tenantId }`). A single MoranBuy identity never
sends marketing on behalf of merchants. Standalone merchants can draft, price and pay but
`confirm` fails on the `sender` gate until they connect a number.

## Templates

`POST /api/merchant/campaigns/templates` validates against Meta's limits and requires an opt-out
line in marketing text. `POST /templates/:id/submit` saves and submits the template in Moran with
the merchant's own token; the status stored is the one Moran reports from Meta (`pending`,
`approved`, `rejected`, `paused`). For a standalone merchant the status becomes `unavailable` with
the next step spelled out. MoranBuy never sets `approved` itself.

## New-product outreach

`offerOutreachForListing` runs when a listing is published: if the merchant selected the
outreach service and the listing is active and visible, one `campaigns` row of kind
`new_product_outreach` with status `offered` is created. The merchant answers with
`POST /outreach/offers/:id/answer`. Accepting needs an active paid service and turns the offer
into a draft that follows the same workflow above. Declining closes it. Publishing never sends.

## Dry run

`CAMPAIGN_DRY_RUN=true` (default) records recipients and outcomes without calling any sender.
Production may switch it off only with a real payment provider (`assertProductionConfig`).

## Tests

`tests/unit/engagement-rules.test.js`, `tests/integration/engagement.test.js`.
