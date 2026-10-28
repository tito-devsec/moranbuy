# Go live: buy.moranai.co.tz on the Moran VPS

MoranBuy runs as its own Docker Compose stack in `/opt/moranbuy`, next to Moran's stack, with its own Postgres and Redis.
Moran's Docker nginx routes `buy.moranai.co.tz` to it over Moran's Docker network. Nothing in Moran's stack is replaced.
The commands use `MORAN_DIR`; on the production VPS Moran lives in `/root/moran-backend`.

```bash
export MORAN_DIR=/root/moran-backend
```

## 0. Before anything

- Back up Moran's database and `.env`, and note the commit, so every step can be undone:

```bash
cd $MORAN_DIR && mkdir -p /root/backups && T=$(date +%Y%m%d-%H%M)
docker compose exec -T postgres pg_dump -U moran -Fc moran > /root/backups/moran-$T.dump
cp .env /root/backups/moran-env-$T.bak && chmod 600 /root/backups/moran-env-$T.bak
git rev-parse HEAD > /root/backups/moran-pre-moranbuy-$T.commit
```

- On a VPS with 4 GB of RAM and no swap, add a 2 GB swap file first so the image build cannot push Moran's containers into the out-of-memory killer:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 1. DNS

Add an A record `buy.moranai.co.tz` → the VPS IP. Wait until `dig +short buy.moranai.co.tz` answers with that IP.

## 2. Moran AI side (once)

The patch is a zero-context diff made against Moran `main` at `680d6f5`; zero-context hunks are placed by line number, so apply it only on that exact commit.

Run Moran's tests first in a separate worktree, so they never load the production `.env`:

```bash
git clone https://github.com/tito-devsec/moranbuy /opt/moranbuy
cd $MORAN_DIR && git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse 680d6f5)" || git checkout 680d6f5   # stop and regenerate the patch if main has moved past it
git worktree add /tmp/moran-check 680d6f5 && cd /tmp/moran-check
# copy the eight files and apply the patch exactly as /opt/moranbuy/integrations/moran-backend/README.md says, then:
sha256sum -c /opt/moranbuy/integrations/moran-backend/patches/0001-moranbuy-integration.sha256
npm ci && npm test
cd $MORAN_DIR && git worktree remove --force /tmp/moran-check
```

Expected from `npm test` without Redis and Postgres: the known `sales-camera-ngapi-not-price` (marked TODO) and three tests that need a live
database or Redis (`mcp-security`, `whatsapp-flows`, `schema-columns`), the same as on a clean `main`. Anything else: stop.

Then apply to the live checkout and rebuild in one go. `admin-frontend/` and `frontend/` are bind-mounted into nginx, so the Super Admin
MoranBuy entry is visible from the moment the patch is applied and answers 404 until the new backend is up (the minutes of the build).

```bash
openssl rand -hex 32          # the shared secret; the same value goes in both .env files
cd $MORAN_DIR && echo 'MORANBUY_API_URL=https://buy.moranai.co.tz' >> .env && echo 'MORANBUY_SHARED_SECRET=<that value>' >> .env
git checkout -b moranbuy-integration
# copy the eight files and apply the patch as above, then sha256sum -c again: 19 lines OK
docker tag moran-backend-backend moran-backend-backend:rollback-$(date +%Y%m%d)       # image names as `docker compose images` shows them
docker tag moran-backend-websocket moran-backend-websocket:rollback-$(date +%Y%m%d)
docker compose build backend websocket && docker compose up -d backend websocket
docker compose logs --tail 50 backend          # migrations ran (20260101000103_moranbuy), server listening
docker compose exec nginx nginx -t && docker compose restart nginx   # restart, not reload: the single-file mount keeps the old file after git apply; the weare CSP now allows Embedded Signup
```

Do not run `npm run migrate` on the host: Moran's backend container runs its migrations when it starts.
`MORANBUY_URL` in `frontend/config.js` stays `''` (the owner dashboard's MoranBuy entry stays hidden) until section 4, when buy.moranai.co.tz answers.
Then in Super Admin (weare.moranai.co.tz) open **MoranBuy** under Operations and follow the four steps: **Register MoranBuy** (a contact email;
admins run this account, its owner login is refused by design), **Connect MoranBuy to WhatsApp**
(the Facebook window, signed in to the account that owns the MoranBuy number), **the name MoranBuy
appears under**, then **Open MoranBuy dashboard**. Its knowledge is written on the business page's
Knowledge tab like any business. Owners who want their products on MoranBuy switch on **List my
products on MoranBuy** in their dashboard (the MoranBuy entry sits at the right of the header).

## 3. MoranBuy stack

```bash
cd /opt/moranbuy
cp deploy/env.production.example .env && chmod 600 .env && nano .env   # every CHANGE_ME, the shared secret, APP_URL; keep the dry-run flags true
# MORAN_INTERNAL_BASE_URL=http://backend:3000: Moran's nginx closes /internal to the public, so the signed channel uses the Docker network
docker network ls | grep moran-backend          # Moran's network; set MORAN_DOCKER_NETWORK in .env if it is not moran-backend_default
# The first build also exports Meta's MMS voices (Swahili, English) to ONNX: it downloads about 1 GB of Python packages once,
# takes several minutes, and leaves two 38 MB voices in the image; `docker builder prune` afterwards frees the build cache.
docker compose -f deploy/docker-compose.vps.yml --env-file .env up -d --build
docker compose -f deploy/docker-compose.vps.yml logs -f moranbuy-api   # until "MoranBuy API listening"
curl -s http://127.0.0.1:4100/ready
docker compose -f deploy/docker-compose.vps.yml exec moranbuy-api npx knex migrate:list --knexfile services/api/src/db/knexfile.js | tail -3
cd $MORAN_DIR && docker compose exec nginx wget -qO- http://moranbuy-api:4000/health   # Moran's nginx reaches MoranBuy
```

## 4. Certificate and Nginx (Moran's Docker nginx)

Moran's nginx runs in Docker and holds port 80, so the certificate is issued in standalone mode, the way Moran's other
certificates are (`deploy/UPDATE-VPS-SUPERADMIN.md` in Moran); nginx stops for about 30 seconds. Issue it **before** adding the
server blocks: nginx refuses to start while a configured certificate file is missing.

```bash
cd $MORAN_DIR
sudo certbot certonly --standalone -d buy.moranai.co.tz \
  --pre-hook "docker compose -f $PWD/docker-compose.yml stop nginx" \
  --post-hook "docker compose -f $PWD/docker-compose.yml start nginx"
sudo ls /etc/letsencrypt/live/buy.moranai.co.tz/          # fullchain.pem and privkey.pem
cp deploy/nginx.full.conf /root/backups/nginx.full.conf.bak
cat /opt/moranbuy/deploy/nginx.buy.moranai.co.tz.conf >> deploy/nginx.full.conf
docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
curl -s https://buy.moranai.co.tz/ready
sed -i "s|MORANBUY_URL: ''|MORANBUY_URL: 'https://buy.moranai.co.tz'|" frontend/config.js && grep -n MORANBUY_URL frontend/config.js   # owners now see the MoranBuy entry
```

The site keeps `client_max_body_size 25m` for uploads and forwarded voice notes. If `nginx -t` fails, restore the backup and reload.

## 5. Credentials, from Super Admin → MoranBuy → Open MoranBuy dashboard

- **Muse Spark** tab: paste the Meta Model API key (dev.meta.ai), model `muse-spark-1.3`, Save and
  test. A real test request runs and the result is shown; the key is stored encrypted in MoranBuy
  and used within seconds. No restart.
- **Credentials** tab: paste the Snippe API key and webhook secret from Moran's `.env` (`$MORAN_DIR/.env`)
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

## 9. Rolling back

```bash
cd /opt/moranbuy && docker compose -f deploy/docker-compose.vps.yml down        # never -v: MoranBuy's own data stays
cd $MORAN_DIR && cp /root/backups/nginx.full.conf.bak deploy/nginx.full.conf && docker compose restart nginx
git checkout main && cp /root/backups/moran-env-<stamp>.bak .env
docker tag moran-backend-backend:rollback-<date> moran-backend-backend && docker tag moran-backend-websocket:rollback-<date> moran-backend-websocket
docker compose up -d --no-build backend websocket
```

The MoranBuy migration only adds columns and a workspace row, so Moran runs with it in place; to remove it too, restore
`/root/backups/moran-<stamp>.dump` with `pg_restore --clean`.
