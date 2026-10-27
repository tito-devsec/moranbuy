# Moran AI side of the integration

Everything Moran AI needs for MoranBuy, shipped from this repository so the Moran owner can review
and apply it. Nothing here is pushed to `moran-backend` by MoranBuy.

## Contents

- `patches/0001-moranbuy-integration.patch`: a `git diff` against `moran-backend` commit `965c247`
  (27 October 2026) touching 8 existing files, 69 lines added. Config block, raw-body mount and
  router mounts in `server.js`, the webhook forward, the owner-login refusal, the admin router
  registration, the Super Admin register button, the dashboard header entry and `MORANBUY_URL`.
- `files/`: four new source files and one doc to copy in:

| Copy to | File |
|---|---|
| `src/db/migrations/20260101000102_moranbuy.js` | `files/20260101000102_moranbuy.js` |
| `src/services/moranbuy.service.js` | `files/moranbuy.service.js` |
| `src/api/routes/moranbuy-internal.routes.js` | `files/moranbuy-internal.routes.js` |
| `src/api/routes/moranbuy-owner.routes.js` | `files/moranbuy-owner.routes.js` |
| `src/api/routes/admin/moranbuy.routes.js` | `files/moranbuy.routes.js` |
| `docs/moranbuy.md` | `files/docs-moranbuy.md` |

## Apply

```bash
cd moran-backend && git checkout -b moranbuy-integration
cp ../moranbuy/integrations/moran-backend/files/20260101000102_moranbuy.js src/db/migrations/
cp ../moranbuy/integrations/moran-backend/files/moranbuy.service.js src/services/
cp ../moranbuy/integrations/moran-backend/files/moranbuy-internal.routes.js src/api/routes/
cp ../moranbuy/integrations/moran-backend/files/moranbuy-owner.routes.js src/api/routes/
cp ../moranbuy/integrations/moran-backend/files/moranbuy.routes.js src/api/routes/admin/
cp ../moranbuy/integrations/moran-backend/files/docs-moranbuy.md docs/moranbuy.md
git apply ../moranbuy/integrations/moran-backend/patches/0001-moranbuy-integration.patch
npm test && npm run migrate
```

Set `MORANBUY_API_URL` and `MORANBUY_SHARED_SECRET` in Moran's `.env`, and `MORANBUY_URL` in
`frontend/config.js`. Then Super Admin → Businesses → Register MoranBuy, connect its number, write
its knowledge.

## Verification done here

- Every new and patched file passes `node --check`.
- The patched modules import cleanly with Moran's dependencies installed.
- Moran's own unit suite (`npm test`) was run on the patched tree; the result is recorded in
  `docs/testing.md`.
- The MoranBuy side of the channel (signature, duplicate delivery, replies through the gate) is
  covered by `tests/integration/shopping-flow.test.js` and `tests/integration/engagement.test.js`
  with a fake Moran.

Not verified here: the patch against a live Moran database and Meta number. That is the owner's
review step.
