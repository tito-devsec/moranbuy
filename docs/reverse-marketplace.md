# The reverse marketplace

`packages/reverse-marketplace` turns a customer message into ranked offers and, on an explicit
yes, an order. One call per inbound message: `ShoppingEngine.handleMessage`.

## Flow

1. **Intake.** The message (text, photo, shared location) is stored on the customer's open session.
2. **Reading.** Muse Spark extracts the structured fields (`museExtractRequest`). When Muse is
   disabled or fails, the deterministic parser (`parse.js`) reads the budget (TSh 350,000, 350k,
   laki tatu, 1.2m), quantity, fulfilment wish, place and language, and the run records
   `muse_status = fallback` or `disabled`. A budget the parser can read always wins over a missing one.
3. **Merging.** New facts are merged into the running request; nothing already captured is asked again.
4. **Location.** A place name is geocoded (Nominatim) into coordinates with source
   `customer_text_geocoded`; a shared pin is `customer_shared`. A phone number is never used as a location.
5. **Clarifying.** If product, budget or location is missing, one short question in the customer's
   language is asked (`clarify.js`).
6. **Discovery.** Candidate listings are read from MoranBuy's database by full-text and name match
   (`discover.js`), including products imported from Moran AI businesses that opted in.
7. **Ranking.** `rankOffers` (see `docs/budget-and-location-ranking.md`).
8. **Presentation.** Facts for the top offers are built (`present.js`); the deterministic reply is
   rendered; when Muse is on it may rephrase, but the text is used only if every number in it
   exists in the facts (`numbersAreGrounded`). Otherwise the deterministic text is sent.
9. **Selection.** A reply such as "1" picks an option. The listing is re-read now; if it is gone,
   inactive or out of stock the customer is told. The known total (or the unconfirmed delivery) is
   read back and a YES/NO is requested.
10. **Confirmation.** Only an explicit yes creates an `orders` row, status `pending_merchant`, with
    the reference sent to the customer. A no closes the session without an order.
11. **Owner alert.** The business owner is texted on WhatsApp from the MoranBuy number with the
    wording set in Super Admin → MoranBuy → Notifications (order ref, product, quantity, known
    total or "delivery not confirmed", fulfilment, customer phone and place). Outside a 24-hour
    window WhatsApp requires an approved template, so the setting also names one on the MoranBuy
    number; every alert's outcome (sent, failed, skipped, dry run) is in `merchant_notifications`.

## Channels

- **WhatsApp** through the MoranBuy business inside Moran AI: Moran's webhook forwards the message
  to `POST /internal/inbound` signed with `MORAN_SHARED_SECRET`; MoranBuy answers through
  `MoranInternalClient.sendText/sendImage`, which reach Moran's outbound gate. Deliveries are
  de-duplicated by message id in `webhook_events`.
- **Web** at `/customer/` through `POST /api/shop/messages` with a browser-held customer token.

## What is never done

- No price, stock, distance, delivery fee or rating is invented; unknown stays unknown and is said so.
- No order before an explicit confirmation.
- No merchant data is written; an order is a request to the merchant.

## Tests

`tests/unit/parse.test.js`, `tests/unit/ranking.test.js`, `tests/integration/shopping-flow.test.js`
(seeded merchants, a Swahili conversation, forwarded WhatsApp messages with signature, duplicate
delivery, selection, refusal, confirmation and order status).
