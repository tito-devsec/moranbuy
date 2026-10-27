# Contributing to MoranBuy

## Setup

```bash
git clone https://github.com/tito-devsec/moranbuy
cd moranbuy
npm install
cp .env.example .env        # fill DATABASE_URL, REDIS_URL, AUTH_SECRET, ENCRYPTION_KEY
npm run hooks               # pre-commit hook that refuses env files and keys
npm run migrate
npm run dev
```

Postgres 16 and Redis 7 are required. `docker compose up postgres redis` starts both.

## Coding standards

- Node 22, ES modules, no transpilation.
- Comments are single lines in plain English that say what a function or block does. The linter rejects comment blocks longer than one line.
- Prices, stock, distances, delivery fees, approvals and telemetry are never invented. If a value is unknown, store and show that it is unknown.
- Every merchant-scoped query filters by `merchant_id`. Every admin route uses the admin auth middleware. Entitlements are checked in the service layer, never only in the UI.
- Outbound campaigns and follow-ups must respect dry-run flags, consent, sender eligibility, template status and payment verification.

## Tests

```bash
npm run check             # node --check on every file
npm run lint              # secrets, line endings, comment style
npm test                  # unit tests, no infrastructure
npm run test:integration  # needs DATABASE_URL and REDIS_URL
npm run test:security
npm run test:e2e
```

CI runs all of them on every push. A pull request with failing checks is not merged.

## Pull requests

- One topic per pull request, with the phase it belongs to in the title.
- Describe what was tested and how. Say plainly what is incomplete.
- Commits are authored by the repository owner only; do not add co-author trailers.
- Never commit `.env`, keys, customer data or production records.
