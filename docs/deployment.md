# Deployment

Going live on the Moran VPS as `buy.moranai.co.tz`: follow `deploy/UPDATE-VPS-MORANBUY.md`
(Nginx site, production Compose stack, `.env` example, Super Admin registration, credentials in
MoranBuy Admin).

## Local

```bash
npm install && cp .env.example .env && npm run hooks
docker compose up -d postgres redis      # or your own Postgres 16 and Redis 7
npm run migrate && npm run seed          # seed creates the first admin from ADMIN_BOOTSTRAP_*
npm run dev                              # API on :4000, apps at /customer, /business, /admin
npm run worker                           # campaign dispatch and follow-up delivery
```

## Environment

Muse Spark, Snippe and Hermes credentials can be entered in MoranBuy Admin instead of `.env`
(Muse Spark Intelligence and Security and Settings). They are stored encrypted with
`ENCRYPTION_KEY`, shown masked, audited, and used on the next request without a restart. Values
in Admin win over the environment.

See `.env.example`. Required: `DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET` (32+ chars),
`ENCRYPTION_KEY` (32 bytes hex). Production refuses placeholder secrets, requires
`MORAN_SHARED_SECRET`, and refuses `CAMPAIGN_DRY_RUN=false` without a real payment provider.

Moran AI side: `MORANBUY_API_URL`, `MORANBUY_SHARED_SECRET` and `MORANBUY_URL` as described in
`integrations/moran-backend/README.md`.

## Database migrations

`npm run migrate` applies; `npm run migrate:rollback` reverts the last batch. CI applies, rolls
every migration back and re-applies on every push. Take a backup (`pg_dump`) before migrating a
production database; MoranBuy never migrates Moran's database.

## Queue workers

`node services/api/src/workers/main.js` runs the polling workers: campaign schedule (30 s), campaign
dispatch, follow-up delivery (30 s), customer schedule reminders (60 s), Moran listings pull
(10 min) and the retention purge (6 h). Run one instance per environment or several: every row is
claimed with a conditional update, so duplicates cannot happen across instances.

## Work queue

With `QUEUE_MODE=redis` (the default) the worker runs a Redis work list for the timed jobs:
`campaign-start`, `campaign-dispatch`, `followup` and `reminder`. Each queue is a sorted set
scored by run time (`moranbuy:queue:<name>:jobs`), with a lease set, an attempts hash and a dead
list. A feeder loads everything due in the next two minutes from Postgres every 15 seconds, one
consumer per queue runs due jobs within a quarter second, a reaper returns jobs whose lease ran out,
and a failing job is retried after 5 s, 10 s, 20 s and 40 s before it goes to the dead list. The API
also queues a campaign the moment it is confirmed or resumed. Postgres stays the record: every
handler re-reads the row and acts only if it is still due, so a lost, repeated or stale job is
harmless. The old Postgres passes still run every five minutes as a safety net, and at their full
pace when Redis is unreachable or `QUEUE_MODE=poll`. Admin → Integration Health shows each queue
(waiting, due, running, done, dead) and sends dead jobs back with a reason.

## Uploaded files

Product photos, verification documents and web customer photos are written to `UPLOAD_DIR`
(`/app/data/uploads` in the containers), a named volume shared by the API and the worker (the
worker's purge deletes expired files). Back it up with the database. Nginx allows request bodies up
to 25 MB (voice notes Moran forwards arrive base64 encoded); the API accepts images up to `UPLOAD_MAX_IMAGE_MB` (5) and PDFs up to
`UPLOAD_MAX_PDF_MB` (10), and decides the type from the file's bytes. Product photos are public at
`/media/<random name>`; documents and customer photos are never served publicly.

## Webhooks and HTTPS

- Moran forwards customer messages to `https://<moranbuy>/internal/inbound` (HMAC signed).
- Snippe posts payment events to `https://<moranbuy>/webhooks/payments` (HMAC signed).
Both need HTTPS with a valid certificate (Nginx or Caddy in front of the API). Replay window is five minutes, so server clocks must be in sync.

## Health, monitoring, logs

`/health` (process), `/ready` (Postgres and Redis). Admin → Integration Health shows the same plus
the last inbound and payment events. Logs are pino JSON with tokens and phone numbers redacted;
ship them to your log store. Muse Spark usage is in Admin → Muse Spark Intelligence from stored rows.

## Backup, rollback, rate limits

- Backup Postgres daily, and the uploads volume with it; the Redis contents are disposable.
- Rollback: redeploy the previous image; `npm run migrate:rollback` only if the release's migration must go.
- API rate limit 300 requests per minute per IP; sign-in failures 10 per 15 minutes per account; campaign daily cap per merchant from the entitlement limits (default 1000).

## Safe production activation

1. Deploy with `CAMPAIGN_DRY_RUN=true`, `FOLLOWUP_DRY_RUN=true`, `PAYMENT_PROVIDER=sandbox` disabled in production (set `snippe`).
2. Apply the Moran patch, register MoranBuy in Super Admin, connect its number, set the shared secret on both sides, send a test message end to end.
3. Set the WhatsApp provider rate in Admin → Billing (`providerUnitTzs`) from Meta's current rate card.
4. Link one merchant, submit a template through Moran, wait for Meta's approval, run a one-recipient campaign in dry run and read the ledger.
5. Only then set `CAMPAIGN_DRY_RUN=false` (and later `FOLLOWUP_DRY_RUN=false`) and restart the API and workers.

Running locally is not production readiness. The items in `README.md` under Known limitations stay open until the owner completes them.
