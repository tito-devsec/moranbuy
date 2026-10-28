# Optional paid follow-up

`packages/followup-engine`, new in this repository.

## Asking first

`GET /api/merchant/followup/offer` returns the question (Swahili or English) and records that it
was asked. `POST /offer/answer`:

- `{accept: false}` records the decision. Nothing is activated or charged. The worker skips the merchant (`not_accepted`).
- `{accept: true}` selects the `paid_followup` service (status `pending_payment`), returns a
  one-time registration link for verification, policy and payment, and still activates nothing.
  Activation happens after a verified payment or an audited admin action.

The link opens the business app on the Follow-up tab (`#followup=<token>`), which reads
`GET /api/merchant/followup/register/:token`: three steps, each judged from the records, never from
the link. Verification (submitted or not), the policy (`POST /register/:token/accept-policy` records
who accepted and when), and payment (the price administrators set for `paid_followup`; `POST
/api/merchant/services/paid_followup/pay` starts it). The entitlement turns active only when the
provider's settlement is verified; a short settlement never activates it.

A follow-up-only merchant never receives the conversation agent; that is a separate entitlement.

## The message

When Muse is on, each follow-up is drafted from the lead's facts (business, product, price, what
the customer said, attempt number); a draft with a number not in the facts or without the STOP
line is replaced by the fixed message. The source is recorded on the task.

## Leads

`createLead` records only what the service needs: merchant, phone, customer reference, product,
source (enquiry, order, session, manual), the customer's stated intention, a requested contact
time, the consent basis, state, next action, attempts, last contact, outcome, stop reason.
Leads come from confirmed orders (service relationship) or an explicit follow-up consent
(`followup_offer`). A lead with no basis is stored as `stopped (no_consent)` and never scheduled.
Tasks are scheduled from the merchant's `scheduleHours` and `maxAttempts`.

## Execution

`processDueFollowups` claims each due task with a conditional update and checks, at that moment:
merchant active, service accepted, entitlement active and paid, not paused, lead still open,
attempts under the limit, consent still granted, a connected sender, quiet hours. Anything failing
is recorded as `skipped` with the reason. A send records the real result; `FOLLOWUP_DRY_RUN=true`
records without sending.

Stop conditions, enforced by `stopLead` and `stopLeadsForPhone`: opt-out (STOP), a reply from the
customer, a decline, a completed purchase, cancellation by the merchant, or the maximum attempts.
Pending tasks are cancelled with the reason.

## Tests

`tests/integration/engagement.test.js`: offer, decline without activation, accept with link,
entitlement refusal, paused and unpaid skips, idempotent passes, stop on reply, dry run, lead from
a confirmed order.
