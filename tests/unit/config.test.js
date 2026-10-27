import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';
import { loadConfig, assertProductionConfig } from '@moranbuy/core';

test('loadConfig accepts the test environment and applies defaults', () => {
  const c = loadConfig(process.env);
  assert.equal(c.APP_ENV, 'test');
  assert.equal(c.MUSE_MODEL_ID, 'muse-spark-1.3');
  assert.equal(c.CAMPAIGN_DRY_RUN, true);
  assert.equal(c.PAYMENT_PROVIDER, 'sandbox');
});

test('loadConfig names every missing or malformed variable', () => {
  assert.throws(() => loadConfig({ ...process.env, DATABASE_URL: '', ENCRYPTION_KEY: 'short' }), /DATABASE_URL[\s\S]*ENCRYPTION_KEY/);
});

test('production refuses placeholder secrets and live sending without a real payment provider', () => {
  const base = loadConfig({ ...process.env, APP_ENV: 'development' });
  assert.throws(() => assertProductionConfig({ ...base, AUTH_SECRET: 'change_me_change_me_change_me_change_me' }), /AUTH_SECRET/);
  assert.throws(() => assertProductionConfig({ ...base, CAMPAIGN_DRY_RUN: false, PAYMENT_PROVIDER: 'sandbox' }), /CAMPAIGN_DRY_RUN/);
});
