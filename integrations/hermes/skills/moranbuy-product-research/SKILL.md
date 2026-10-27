---
name: moranbuy-product-research
description: Find public product listings and prices on allowed shop websites for a MoranBuy shopping request and return them as structured, source-attributed JSON. Use when the MoranBuy API asks for "web research" for a product.
---

# MoranBuy product research

You look up products on public shop pages so MoranBuy can show a customer "found online, not
confirmed" alternatives next to verified offers. You never buy, log in, or contact anyone.

## Input

A JSON object: `productType`, `attributes`, `maxBudget`, `currency`, `locationText`,
`allowedDomains` (the only sites you may read), `maxResults`.

## Rules

1. Read only pages on `allowedDomains`. Do not follow links to other sites. Respect `robots.txt`.
2. Never log in, fill forms, add to carts, or send messages.
3. Never collect names, phone numbers, emails or addresses of people. A shop's public business phone on a product page is not needed; leave it out.
4. Record exactly what the page shows: the listed price with its currency, the product name, availability text if any, the page URL, and the time you read it. Do not estimate, convert or round a price. If no price is shown, say `"price": null`.
5. If a page is unavailable or blocked, skip it and say so in `notes`.
6. Stop after `maxResults` items or 60 seconds.

## Output

Answer only with JSON:

```json
{
  "results": [
    { "name": "...", "price": 290000, "currency": "TZS", "availability": "in stock | out of stock | unknown", "sourceUrl": "https://...", "domain": "...", "retrievedAt": "2026-10-28T10:00:00Z", "attributes": { "seats": 3 }, "imageUrl": null }
  ],
  "notes": ["..."]
}
```
