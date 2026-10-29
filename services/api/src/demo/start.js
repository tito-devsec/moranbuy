// Starts the public demo sandbox: its own database (created when missing), its own secrets (made once and kept on its volume), then the API in DEMO_MODE with an hourly clean-up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.DEMO_STATE_DIR || '/app/data/demo';

// The sandbox never holds production keys: anything that could reach a real provider or Moran is removed before the app reads its config.
const NEVER = ['SNIPPE_API_KEY', 'SNIPPE_WEBHOOK_SECRET', 'MORAN_INTERNAL_BASE_URL', 'MORAN_BACKEND_BASE_URL', 'WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'HERMES_API_KEY', 'HERMES_BASE_URL', 'DEMO_API_URL'];
for (const k of NEVER) delete process.env[k];
Object.assign(process.env, { DEMO_MODE: 'true', PAYMENT_PROVIDER: 'sandbox', CAMPAIGN_DRY_RUN: 'true', FOLLOWUP_DRY_RUN: 'true' });
if (!process.env.UPLOAD_DIR) process.env.UPLOAD_DIR = path.join(stateDir, 'uploads');

// Secrets for the sandbox only, kept so receipts made before a restart still check out.
fs.mkdirSync(stateDir, { recursive: true });
const secretsFile = path.join(stateDir, 'secrets.json');
let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8')); } catch { secrets = {}; }
const made = { AUTH_SECRET: crypto.randomBytes(32).toString('hex'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), MORAN_SHARED_SECRET: crypto.randomBytes(24).toString('hex') };
secrets = { ...made, ...secrets };
fs.writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
for (const [k, v] of Object.entries(secrets)) process.env[k] = v;

// The demo database lives on the same Postgres server as production under its own name.
async function ensureDatabase() {
  const url = new URL(process.env.DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(name) || !/demo/.test(name)) throw new Error(`The demo database name must contain "demo" (got "${name}")`);
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally { await client.end(); }
}

for (let attempt = 1; ; attempt += 1) {
  try { await ensureDatabase(); break; } catch (err) {
    if (attempt >= 10 || /must contain/.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
}
execFileSync(process.execPath, [path.join(here, '../../../../node_modules/knex/bin/cli.js'), 'migrate:latest', '--knexfile', path.join(here, '../db/knexfile.js')], { stdio: 'inherit', env: process.env });

await import('../server.js');
const { cleanDemoData } = await import('../routes/demo.js');
const { logger } = await import('@moranbuy/observability');
const sweep = () => cleanDemoData().then((n) => n && logger.info({ removed: n }, 'Old demo sessions removed')).catch((err) => logger.warn({ err: err.message }, 'Demo clean-up failed'));
setTimeout(sweep, 60_000).unref();
setInterval(sweep, 3_600_000).unref();
