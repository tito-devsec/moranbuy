# Hermes research agent for MoranBuy

Optional. Gives the MoranBuy sales agent the ability to look up products on allowed public shop
sites so a customer can see "found online, not confirmed" alternatives next to verified offers.

- Container: `docker compose --profile research up hermes` (image `nousresearch/hermes-agent`,
  config `config.yaml`, skill `skills/moranbuy-product-research/SKILL.md`).
- Toolsets on: `web`, `browser`, `skills`. Everything else off, no memory, no self-editing skills.
- MoranBuy calls its OpenAI-compatible API (`HERMES_BASE_URL`, `HERMES_API_KEY`) through
  `packages/integrations/src/research.js`, which parses the skill's JSON and validates every item
  (URL on an allowed domain, numeric price or null).
- Switches: `MORANBUY_WEB_RESEARCH_ENABLED=true` and `MORANBUY_ALLOWED_DOMAINS=shop-a.co.tz,shop-b.co.tz`.
  Off by default. With research on but no Hermes configured, the plain fetch researcher reads the
  allowed sites' product pages directly under the same rules.
- Every research call is recorded as a `muse_requests` row with feature `web_research` so the
  admin page shows it; results enter ranking as `source = 'web'`, unverified, never above a
  verified in-budget offer, and never orderable through MoranBuy.

Verify the Hermes image name and config keys against the Hermes Agent documentation for the version
you deploy; the keys above mirror the ones Moran's own Hermes deployment uses.
