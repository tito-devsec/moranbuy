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
