# Moran AI side of the integration

Everything Moran AI needs for MoranBuy, shipped from this repository so the Moran owner can review
and apply it. Nothing here is pushed to `moran-backend` by MoranBuy.

## Contents

- `patches/0001-moranbuy-integration.patch`: a `git diff` against `moran-backend` `main` at commit `680d6f5`
  (28 October 2026) touching 11 existing files. It is a zero-context diff: it carries only the new lines and the three existing lines they replace, so no other Moran code is published here; apply it with `--unidiff-zero`. Config block, raw-body mount and router mounts in
  `server.js`, the webhook forward, the owner-login refusal, the admin router registration, the
  Super Admin register button and the MoranBuy navigation entry, the delivery-receipt forward, the weare CSP for Facebook's
  Embedded Signup window, the dashboard header entry and `MORANBUY_URL`, and the regenerated admin
  API reference.
- `files/`: the new source files, the Super Admin MoranBuy page and one doc to copy in:

| Copy to | File |
|---|---|
| `src/db/migrations/20260101000103_moranbuy.js` | `files/20260101000103_moranbuy.js` |
| `src/services/moranbuy.service.js` | `files/moranbuy.service.js` |
| `src/api/routes/moranbuy-internal.routes.js` | `files/moranbuy-internal.routes.js` |
| `src/api/routes/moranbuy-owner.routes.js` | `files/moranbuy-owner.routes.js` |
| `src/api/routes/admin/moranbuy.routes.js` | `files/moranbuy.routes.js` |
| `admin-frontend/moranbuy.html` | `files/admin-moranbuy.html` |
| `admin-frontend/assets/js/pages/moranbuy.js` | `files/admin-pages-moranbuy.js` |
| `docs/moranbuy.md` | `files/docs-moranbuy.md` |

## Apply

```bash
cd moran-backend && git checkout -b moranbuy-integration
cp ../moranbuy/integrations/moran-backend/files/20260101000103_moranbuy.js src/db/migrations/
cp ../moranbuy/integrations/moran-backend/files/moranbuy.service.js src/services/
cp ../moranbuy/integrations/moran-backend/files/moranbuy-internal.routes.js src/api/routes/
cp ../moranbuy/integrations/moran-backend/files/moranbuy-owner.routes.js src/api/routes/
cp ../moranbuy/integrations/moran-backend/files/moranbuy.routes.js src/api/routes/admin/
cp ../moranbuy/integrations/moran-backend/files/admin-moranbuy.html admin-frontend/moranbuy.html
cp ../moranbuy/integrations/moran-backend/files/admin-pages-moranbuy.js admin-frontend/assets/js/pages/moranbuy.js
cp ../moranbuy/integrations/moran-backend/files/docs-moranbuy.md docs/moranbuy.md
git apply --check --unidiff-zero ../moranbuy/integrations/moran-backend/patches/0001-moranbuy-integration.patch
git apply --unidiff-zero ../moranbuy/integrations/moran-backend/patches/0001-moranbuy-integration.patch
sha256sum -c ../moranbuy/integrations/moran-backend/patches/0001-moranbuy-integration.sha256
npm test
```

A zero-context hunk is placed by its line number, so apply the patch only on `680d6f5`; on any other commit
`--check` can pass while a line lands in the wrong place. `sha256sum -c` proves the result: all 19 files must read `OK`.
The migration is numbered `...103` because Moran's `...102` is `testimonial_words`. Moran's backend container runs it when it starts.

Set `MORANBUY_API_URL` and `MORANBUY_SHARED_SECRET` in Moran's `.env`, and `MORANBUY_URL` in
`frontend/config.js`. Redeploy the admin front-end (`admin-frontend/deploy.sh`) and reload Nginx
for the CSP change. Then Super Admin → MoranBuy: Register, Connect MoranBuy to WhatsApp, choose
the name, Open MoranBuy dashboard. Super Admins manage MoranBuy from there with their existing
login; every action is audited in MoranBuy under the admin's email.

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
