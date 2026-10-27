import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
function walk(dir, out = []) { for (const n of readdirSync(dir)) { if (['node_modules', '.git'].includes(n)) continue; const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; }

test('no .env file, private key or key-shaped literal is committed', () => {
  const files = walk(root);
  assert.ok(!files.some((f) => /(^|\/)\.env$|\.pem$|\.key$/.test(f)), 'secret file present');
  for (const f of files) {
    if (/\.(png|jpg|ico|ttf|lock)$|package-lock\.json$/.test(f)) continue;
    assert.doesNotMatch(readFileSync(f, 'utf8'), /sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC )?PRIVATE KEY/, f);
  }
});

test('browser apps never receive server secrets', () => {
  for (const app of ['customer', 'business', 'admin']) {
    for (const f of walk(path.join(root, 'apps', app))) assert.doesNotMatch(readFileSync(f, 'utf8'), /MUSE_API_KEY|SNIPPE_API_KEY|AUTH_SECRET|ENCRYPTION_KEY|MORAN_SHARED_SECRET/, f);
  }
});
