import { config } from '@moranbuy/core';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { Geocoder, MoranInternalClient } from '@moranbuy/integrations';
import { DiscoveryResearcher, NearbyShops } from './discovery.js';
import { askMatchingBusinesses } from './business-leads.js';
import { museRuntimeConfig } from './runtime-settings.js';
import { notifyMerchantOfOrder } from './merchant-notify.js';
import { handOrderToMoran } from './moran-order-sync.js';
import { demoGeocoder, demoMoran } from '../demo/stand-ins.js';
import { logger } from '@moranbuy/observability';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { DEFAULT_POLICY } from '@moranbuy/budget-matching';
import { db } from '../db/connection.js';

let shared = null;

// Loads the ranking policy from platform_settings so admin changes apply without a restart, falling back to the defaults.
export async function loadRankingPolicy(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'ranking_policy' }).first();
  return { ...DEFAULT_POLICY, ...(row?.value || {}) };
}

// The name and greeting MoranBuy uses, chosen in Super Admin; a sensible default until then.
export async function loadAgentProfile(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'agent_profile' }).first();
  return { name: 'MoranBuy', greetingSw: null, greetingEn: null, ...(row?.value || {}) };
}

// The engine and clients the routes use; tests build their own with fakes.
export function shoppingDeps() {
  if (!shared) {
    const c = config();
    shared = {
      muse: new MuseClient({ cfg: c, db, resolve: () => museRuntimeConfig() }),
      // The demo sandbox keeps WhatsApp and the map in memory; everything else is the real code.
      geocoder: c.DEMO_MODE ? demoGeocoder() : new Geocoder({ cfg: c }),
      moran: c.DEMO_MODE ? demoMoran() : new MoranInternalClient({ cfg: c }),
    };
    // Online finds (Meta web search, kept in an index) and shops near the customer (Google Places), both with daily limits set in Super Admin.
    shared.researcher = new DiscoveryResearcher();
    shared.nearby = new NearbyShops();
    shared.engine = new ShoppingEngine({ db, muse: shared.muse, geocoder: shared.geocoder, policyLoader: () => loadRankingPolicy(db), researcher: shared.researcher, nearby: shared.nearby, leads: c.DEMO_MODE ? null : ({ session, customer, request }) => askMatchingBusinesses({ moran: shared.moran, session, customer, request }), profileLoader: () => loadAgentProfile(db), onOrderConfirmed: async (order) => { await handOrderToMoran({ moran: shared.moran, order }).catch((err) => logger.warn({ err: err.message }, 'Moran order handoff failed')); await notifyMerchantOfOrder({ moran: shared.moran, order }); } });
  }
  return shared;
}

export function setShoppingDepsForTests(deps) { shared = deps; }

// Finds or creates the customer record for a channel identity.
export async function upsertCustomer({ channel, channelRef, name = null, language = null }) {
  const existing = await db('customers').where({ channel, channel_ref: channelRef }).first();
  if (existing) {
    await db('customers').where({ id: existing.id }).update({ last_seen_at: db.fn.now(), ...(name ? { name } : {}), ...(language ? { language } : {}) });
    return existing;
  }
  const [row] = await db('customers').insert({ channel, channel_ref: channelRef, name, language: language || 'sw', last_seen_at: db.fn.now() }).returning('*');
  return row;
}
