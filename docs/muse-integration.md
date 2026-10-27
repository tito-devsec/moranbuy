# Muse Spark integration

## The model and API (verified 27 October 2026)

- Provider: Meta Model API, base URL `https://api.meta.ai/v1` (https://dev.meta.ai/docs).
- Model id: `muse-spark-1.3` (`MUSE_MODEL_ID`; `muse-spark-1.2` and `muse-spark-1.1` also exist;
  the `-contributor` variants share prompts with Meta for training and are not used).
- Protocol: OpenAI-compatible Chat Completions, `POST /v1/chat/completions`, Bearer key
  (`MUSE_API_KEY`, the Meta Model API key from dev.meta.ai). Images are `image_url` content parts
  (public URL or base64 data URL). `reasoning_effort` from `minimal` to `xhigh`
  (`MUSE_REASONING_EFFORT`, default `low` for short extraction work).
- Availability: public preview for developers in the US, pay-as-you-go; hackathon participants
  receive credits. `MUSE_PROVIDER=openai-compatible` with another `MUSE_API_BASE_URL` points the same
  client at the open-weight `muse-spark-open` served by Together, Fireworks, Baseten, Groq or Nebius.

## Where Muse works

| Feature | Function | What Muse does | What code does |
|---|---|---|---|
| `intent` | `museExtractRequest` | reads Swahili/English text into product, attributes, budget, place, fulfilment, language, intent | validates with zod, merges, falls back to the regex parser |
| `image` | `museExtractRequest` with a photo | names the product and visible attributes | same validation; never a price |
| `recommendation` | `museDraftRecommendation` | words the reply from supplied facts | builds the facts, renders the deterministic text, rejects any draft whose numbers are not in the facts |
| `campaign_draft`, `campaign_revision` | `museDraftCampaign` | drafts and revises promotional text from product facts | validation, consent, template, payment, dispatch gates (Phase 7) |
| `outreach_draft` | `museDraftOutreach` | new-product announcement draft | same gates |
| `followup_summary` | `museSummarizeLeads` | summarises eligible leads | lead eligibility, stop rules (Phase 8) |
| `admin_summary` | `museAdminSummary` | explains redacted operational data | redaction before the call |
| `test_connection` | `MuseClient.testConnection` | a tiny real request | the admin page shows the real result |

Muse never decides prices, budgets, ranking, consent, authorization, payments or order state.

## Request flow

`MuseClient.complete` sends `{ model, messages: [developer, ...], max_tokens, temperature: 0.2,
reasoning_effort, response_format: { type: 'json_object' } }` with a timeout (`MUSE_TIMEOUT_MS`).
The answer is parsed as JSON; code fences are stripped. Every call, including a disabled provider,
writes one `muse_requests` row: feature, provider, model (as returned), status (`ok`, `error`,
`timeout`, `disabled`), latency, prompt and completion tokens, redacted error. The admin telemetry
(`museTelemetry`) is computed from those rows only.

## Error handling

- Disabled provider: `{ ok: false, status: 'disabled' }`; engines use deterministic fallbacks and the
  run records `muse_status`.
- HTTP error: `HTTP_<status>`, body redacted (keys and secret-looking values) before storage.
- Non-JSON answer: `BAD_JSON`.
- Timeout or network: `TIMEOUT` or the error code.
No fallback pretends to be Muse; the customer-facing text says what is and is not confirmed either way.

## Tests

`tests/integration/muse-client.test.js` drives the client with a fake `fetch`: request shape and
headers, success telemetry with real token counts, 401, bad JSON, timeout, secret redaction,
disabled provider, telemetry summary, `testConnection`. No test calls the real API.
