# What Muse Spark does in MoranBuy

Muse Spark (Meta Model API, `muse-spark-1.3`) is the intelligence behind MoranBuy. Every duty below
runs through `packages/muse-intelligence`, records telemetry from the real call, and has a
deterministic stand-in that takes over when Muse is off or its answer fails the checks. Muse never
sends a message, charges anyone or activates a service on its own.

| Duty | Where | Check on Muse's answer | Stand-in |
|---|---|---|---|
| Read what a customer wants (text, photo, transcribed voice note): product, attributes, budget, place, timing, a schedule, their name | `museExtractRequest` → `ShoppingEngine.handleMessage` | validated against the request schema; intent to select or confirm is decided by rules, never by the model alone | `fallbackExtract`, `fallbackTiming` |
| Research what the customer asked for on the web (Hermes skill) and in Moran AI businesses, then recommend the best five, ordered by budget first and location second, each with a description and why | `discoverOffers`, `RuntimeResearcher`, `rankOffers`, `buildFacts` (five), `museDraftRecommendation` | every number in the wording must be in the facts (`numbersAreGrounded`) | `renderReply` |
| Record the customer's intent, timing and schedule | `recordDemandSignal`, `recordSchedule` (`demand_signals`, `customer_schedules`) | none needed, the record is the data | same |
| Read a product a registered business sends by chat (text or photo) into its catalogue | `museExtractProduct` → `handleMerchantChat` | a name is required; a new product needs a price; the canonical product type comes from the vocabulary | `fallbackExtractProduct` |
| Draft follow-up messages and campaign and outreach announcements | `museDraftFollowup`, `museDraftCampaign`, `museDraftOutreach` | grounded numbers; a follow-up must carry the STOP line | `followupMessage`, `fallbackDraft` |
| Judge which customers fit a business's offer (best-fit audience for campaigns and outreach) | `fitScores` (deterministic score), `museAudienceFit` (reasons, reorder) | Muse can only reorder and explain the candidates it was given; consent and frequency caps are applied before it sees anyone | the deterministic scores and reasons |
| Explain demand statistics: what people ask for most, where, budgets, best sellers, unmet demand | `demandStats`, `museDemandOverview` | grounded numbers | `renderOverview` |

## Who may use follow-up and outreach

Only a registered business: one with a MoranBuy account (a dashboard user), an active status, and
the service selected and paid. A Moran AI business that was pulled automatically but never signed in
is listed and can receive orders, but cannot run campaigns, outreach or follow-up until it registers
("Link Moran AI account" in the business app).

## Locations and names

Every place a customer names or shares is resolved to a Tanzanian region and district
(`packages/location-ranking/src/places.js`, 31 regions, the districts and neighbourhoods customers
actually say) and kept on the demand signal and the customer record. The customer's WhatsApp
profile name, or a name they state, is kept on the customer record. Statistics group by region,
district and canonical product type (`packages/reverse-marketplace/src/vocabulary.js`), so "kochi",
"sofa" and "couch" count as one product.

## Voice notes and photos

Moran AI opens media for the MoranBuy number without a per-business media entitlement, transcribes
voice notes with its configured speech-to-text, and forwards the transcript with `kind: "audio"`.
MoranBuy shops from the transcript and records the signal as `voice`. When transcription is not
configured, the customer is asked to type or send a photo. Photos go to Muse as image parts, for a
shopper (what they want) and for a business (what they sell).

## Products sent by chat

A registered business sends "Bidhaa: jina, bei, idadi" (or a photo with that caption) from its
contact number to the MoranBuy number. The product is read, listed as `source = whatsapp_chat`,
searchable at once, offered for new-product outreach when that service is selected, and every
upload is kept in `catalog_uploads` with what was read. Sending the same name again updates it.
"RIPOTI" (or "REPORT", optionally with a number of days) returns the business's demand overview.
