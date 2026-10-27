## What this changes

## Phase

## How it was tested

- [ ] `npm run lint` and `npm run check`
- [ ] `npm test`
- [ ] `npm run test:integration` (needs Postgres and Redis)
- [ ] Manual check described below

## What is incomplete or stubbed

## Checklist

- [ ] No secrets, customer data or production records in the diff
- [ ] Merchant-scoped queries filter by `merchant_id`; admin routes use admin auth
- [ ] Nothing invented: prices, stock, distances, approvals, telemetry
- [ ] Docs updated (`CHANGELOG.md`, `HACKATHON_CHANGES.md` when applicable)
