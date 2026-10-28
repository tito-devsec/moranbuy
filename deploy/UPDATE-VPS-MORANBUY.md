# Go live: buy.moranai.co.tz on the Moran VPS

MoranBuy runs as its own Docker Compose stack next to Moran's (`/opt/moran-backend`), with its own
Postgres and Redis, and Nginx routes `buy.moranai.co.tz` to it. It talks to the real backend at
`https://api.moranai.co.tz`. Nothing in Moran's stack is replaced.

## 1. DNS

Add an A record `buy.moranai.co.tz` → the VPS IP. Wait until `dig +short buy.moranai.co.tz` answers.

## 2. Moran AI side (once)

```bash
cd /opt/moran-backend
git fetch && git checkout -b moranbuy-integration
# copy the files and apply the patch exactly as integrations/moran-backend/README.md says
openssl rand -hex 32          # the shared secret; put the same value in both .env files
echo 'MORANBUY_API_URL=https://buy.moranai.co.tz' >> .env
echo 'MORANBUY_SHARED_SECRET=<that value>' >> .env
# frontend/config.js: MORANBUY_URL: 'https://buy.moranai.co.tz'
npm test && npm run migrate
docker compose up -d --build backend websocket     # or pm2 reload, as Moran is run today
```

Redeploy the admin front-end (`admin-frontend/deploy.sh`) and reload Nginx (the weare CSP now
allows Facebook's Embedded Signup window). Then in Super Admin (weare.moranai.co.tz) open
**MoranBuy** under Operations and follow the four steps: **Register MoranBuy** (a contact email;
admins run this account, its owner login is refused by design), **Connect MoranBuy to WhatsApp**
(the Facebook window, signed in to the account that owns the MoranBuy number), **the name MoranBuy
appears under**, then **Open MoranBuy dashboard**. Its knowledge is written on the business page's
Knowledge tab like any business. Owners who want their products on MoranBuy switch on **List my
products on MoranBuy** in their dashboard (the MoranBuy entry sits at the right of the header).

## 3. MoranBuy stack

```bash
sudo mkdir -p /opt/moranbuy && cd /opt/moranbuy
git clone https://github.com/tito-devsec/moranbuy .
cp deploy/env.production.example .env && nano .env     # fill every CHANGE_ME, the shared secret, APP_URL
docker compose -f deploy/docker-compose.vps.yml --env-file .env up -d --build
docker compose -f deploy/docker-compose.vps.yml logs -f moranbuy-api   # until "MoranBuy API listening"
curl -s http://127.0.0.1:4000/ready
```

## 4. Nginx and HTTPS

```bash
sudo cp deploy/nginx.buy.moranai.co.tz.conf /etc/nginx/sites-available/buy.moranai.co.tz
sudo ln -s /etc/nginx/sites-available/buy.moranai.co.tz /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d buy.moranai.co.tz
curl -s https://buy.moranai.co.tz/ready
```

## 5. Credentials, from Super Admin → MoranBuy → Open MoranBuy dashboard

- **Muse Spark** tab: paste the Meta Model API key (dev.meta.ai), model `muse-spark-1.3`, Save and
  test. A real test request runs and the result is shown; the key is stored encrypted in MoranBuy
  and used within seconds. No restart.
- **Credentials** tab: paste the Snippe API key and webhook secret from `/opt/moran-backend/.env`
  (the same Snippe account). Register `https://buy.moranai.co.tz/webhooks/payments` as a webhook
  URL in Snippe. Optional: Hermes base URL, key and the allowed shop domains.
- **Billing** tab: set the WhatsApp provider rate per message to Meta's current marketing rate.
- **Notifications** tab: the terms question every new sender must accept (buttons, links to
  `https://buy.moranai.co.tz/terms` and `/privacy`; edit the policy pages in `apps/customer/` before
  going live and bump the version to ask everyone again), and the message business owners get when an order is confirmed. On the
  MoranBuy business page in Super Admin → Templates, create `moranbuy_order_alert` (category
  UTILITY, Swahili, body with `{{1}}` order ref, `{{2}}` product, `{{3}}` quantity, `{{4}}` total,
  `{{5}}` fulfilment, `{{6}}` customer phone), submit it, and once Meta approves it enter its name
  here; until then alerts go as plain text, which WhatsApp only delivers to owners who wrote to the
  MoranBuy number in the last 24 hours.

Only a Super Admin (`super_admin`) may change credentials; other roles read. Every change is
audited in MoranBuy under the admin's email. `https://buy.moranai.co.tz/admin/` remains as a
fallback with its own `ADMIN_BOOTSTRAP_EMAIL` login for when weare is unavailable.

Opted-in businesses need no sign-up: the worker pulls them every 10 minutes (Integration Health
has a "Pull now" button). Owners without a MoranBuy login get order alerts on their WhatsApp number
and answer with `KUBALI MB-XXXX [ada ya delivery]` or `KATAA MB-XXXX`.

## 6. Smoke test

1. Send "Nina laki tatu na nusu ya sofa ya watu watatu, nipo Sinza, delivery" to the MoranBuy
   WhatsApp number. The reply comes from the MoranBuy number through Moran's outbound gate.
2. Open `https://buy.moranai.co.tz/customer/` and send the same.
3. Register a standalone merchant at `/business/`, add a location and a product, search again.
4. Link a Moran owner account at `/business/` and sync.
5. Admin → Product Matching and Ranking: open the run evidence. Admin → Integration Health: Moran
   `lastInbound` and the payment webhook state.

## 7. Updating

```bash
cd /opt/moranbuy && git pull && docker compose -f deploy/docker-compose.vps.yml --env-file .env up -d --build
```
Migrations run on start. Back up first: `docker exec $(docker compose -f deploy/docker-compose.vps.yml ps -q moranbuy-postgres) pg_dump -U moranbuy moranbuy > backup-$(date +%F).sql`.

## 8. Turning live sending on

Only after step 6 and a one-recipient campaign read in the ledger: set `CAMPAIGN_DRY_RUN=false`
(and later `FOLLOWUP_DRY_RUN=false`) in `.env` and `up -d` again.
