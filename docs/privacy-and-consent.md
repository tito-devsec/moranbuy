# Privacy and consent

## Consent model

`consent_events` is append-only: merchant (or null for every merchant), phone, purpose
(`marketing`, `followup`, `service`, `all`), channel, status (`granted`, `revoked`), source,
evidence reference, who recorded it, time. The current state (`consentState`) is: a global or
merchant-level `all` revocation wins; otherwise the latest event for the purpose.

- A bare STOP / SITAKI / USITUME to the MoranBuy number revokes `all` for every merchant and stops
  open follow-up leads. START restores only the MoranBuy relationship.
- A confirmed order grants `service` consent for that merchant only. It never grants marketing.
- Marketing consent comes from a web form, an inbound keyword, or a merchant attestation with an
  evidence reference recorded on the event.
- Consent is per merchant. Nothing is shared between merchants; a merchant's audience is its own
  contacts, and a pasted phone list is filtered to numbers the merchant already has a relationship with.

## Terms acceptance

No one is answered before accepting the Terms of Service and Privacy Policy (`/terms`, `/privacy`,
bilingual). The question carries two WhatsApp reply buttons; acceptance is stored on the
customer row with the version and as a `service` consent event with `terms:<version>` as
evidence. Super Admin → MoranBuy → Notifications edits the wording and version.

## Audiences

`resolveAudience` excludes invalid numbers, duplicates, numbers that are not the merchant's
contacts, missing or revoked consent, global opt-outs, and contacts over the 30-day frequency cap,
each with a reason the merchant and the admin can see. The worker rechecks consent for every
recipient at the moment of sending.

## Data minimisation

Phones are stored in E.164 digits and masked in merchant and admin views (`2557…78`). Logs redact
tokens and phone numbers. Matching runs store listing ids and costs, not customer identities.
Moran refresh tokens are encrypted with AES-256-GCM. Follow-up keeps only the fields listed in
`docs/followup-workflow.md`.

## Rights

- Correction: contact name and tags through the merchant API.
- Deletion: `DELETE /api/merchant/contacts/:phone` removes the contact and its consent events for
  that merchant; the audit trail keeps a masked reference.
- Access: `GET /api/merchant/contacts/:phone/consent` returns the history.

## What this is not

This is an implementation of consent tracking, not a legal opinion. Tanzania's Personal Data
Protection Act (2022) and Meta's WhatsApp Business Messaging Policy apply; the owner should review
retention periods and the lawful basis for each purpose before production use.

## Retention

Records are kept for set periods, then removed by the `retention-purge` worker (every six hours,
batches of 2,000 so the live service is not locked). Periods are edited in Super Admin → MoranBuy →
Retention; no period can go below 30 days (7 for the webhook duplicate guard), and every change is
audited with a reason.

| Records | Kept (days) |
|---|---|
| Chat messages | 180 |
| Finished or expired shopping sessions (with their messages) | 365 |
| Ranking evidence | 365 |
| Demand signals behind the statistics | 730 |
| Finished customer schedules | 180 |
| Converted or stopped follow-up leads and their tasks | 365 |
| Per-phone ledger of finished campaigns (the campaign's counts stay) | 365 |
| Owner alerts sent | 365 |
| Products sent by chat, as received | 365 |
| Muse telemetry | 365 |
| Webhook duplicate guard | 90 |
| Customers who never ordered or enquired and have not written since | 730 |
| Delivery location on old orders (the order itself stays) | 730 |
| Photos web customers uploaded (file and record) | 90 |
| Product photos no listing shows (file and record) | 30 |
| Voice notes customers and businesses sent, with their transcripts | 30 |
| Spoken replies MoranBuy made | 7 |
| Delivery and refusal photos (dispute evidence) | 180 |

Never purged here: orders, payments, consent events, contacts, merchants, listings and the audit
trail. Erasure on request (`DELETE /api/merchant/contacts/:phone`) is separate and immediate.
`RETENTION_DRY_RUN=true` (the default) makes the scheduled purge count only; a super admin can
preview at any time and purge by hand with a reason and an explicit confirmation. The last preview
and the last purge are shown with their counts per table. These periods are a starting point; the
operator must confirm them against Tanzania's Personal Data Protection Act before production.

## Voice notes and photos

A voice note or photo is opened only after the sender accepted the terms. Moran downloads it from
WhatsApp and forwards the bytes in its signed request; Moran's own transcription and image tools are
not used for MoranBuy. MoranBuy keeps it privately (never public), decodes voice notes inside its own
process, and sends them to the Meta Model API to be heard; the transcript is stored beside the
recording. Spoken replies are made inside MoranBuy by Meta's MMS voices from the written reply and sent back
as a voice note; no text leaves the server for speech. Both are removed by the retention purge (30 and 7 days).

## Payment protection

For a protected order MoranBuy keeps the payment reference, the receipt versions, payouts and refunds, and an evidence timeline (button presses, the result of each handover-code attempt but never the code, which is stored only as a keyed hash, delivery photos, shared locations and refusal reasons). The delivery person sees the order, the place and the customer's phone, which they need to deliver. Orders, payments, payouts, receipts, the timeline and disputes are financial records and are never purged; delivery photos are removed after 180 days. Muse Spark and SAM 3.1 read delivery photos only to compare them with the ordered product; the result is evidence, never a decision.
