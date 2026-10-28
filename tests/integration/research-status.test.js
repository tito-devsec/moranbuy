import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing, acceptedCustomer } from '../helpers/fixtures.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder } from '@moranbuy/integrations';
import { loadConfig } from '@moranbuy/core';

before(async () => { await resetDatabase(); });
after(async () => { await closeDatabase(); });

// Reproduces the live failure: with a web researcher set up (as on every real server), the run's status text is longer than before.
test('a search with web research configured is stored and answered, whatever status the researcher reports', async () => {
  const m = (await makeMerchant({ name: 'Duka', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: 10000, radiusKm: 30 })).merchant;
  await makeListing(m.id, { name: 'Sofa ya watu watatu', price: 300000, attributes: { seats: 3 } });
  const customer = await acceptedCustomer('255700000777');
  for (const status of ['disabled', 'not_configured_research_provider', 'error']) {
    const researcher = { name: 'stub', research: async () => ({ ok: false, status, results: [] }) };
    const engine = new ShoppingEngine({ db, muse: new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' }), db }), geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza' } }), researcher });
    const out = await engine.handleMessage({ customer, text: 'Nina laki tatu na nusu ya sofa ya watu watatu, nipo Sinza, delivery' });
    assert.equal(out.session.state, 'presented', status);
    assert.match(out.replies.at(-1).text, /Sofa ya watu watatu/);
    const run = await db('matching_runs').orderBy('created_at', 'desc').first();
    assert.ok(run.muse_status.includes(`research:${status}`.slice(0, 40)));
    await db('shopping_sessions').where({ customer_id: customer.id }).update({ state: 'closed' });
  }
  // The budget the plain reader took from "laki tatu na nusu".
  const run = await db('matching_runs').orderBy('created_at', 'desc').first();
  assert.equal(run.request_json.maxBudget, 350000);
});
