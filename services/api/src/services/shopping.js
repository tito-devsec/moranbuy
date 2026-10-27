import { config } from '@moranbuy/core';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { Geocoder, MoranInternalClient } from '@moranbuy/integrations';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { DEFAULT_POLICY } from '@moranbuy/budget-matching';
import { db } from '../db/connection.js';

let shared = null;

// Loads the ranking policy from platform_settings so admin changes apply without a restart, falling back to the defaults.
export async function loadRankingPolicy(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'ranking_policy' }).first();
  return { ...DEFAULT_POLICY, ...(row?.value || {}) };
}

// The engine and clients the routes use; tests build their own with fakes.
export function shoppingDeps() {
  if (!shared) {
    const c = config();
    shared = {
      muse: new MuseClient({ cfg: c, db }),
      geocoder: new Geocoder({ cfg: c }),
      moran: new MoranInternalClient({ cfg: c }),
    };
    shared.engine = new ShoppingEngine({ db, muse: shared.muse, geocoder: shared.geocoder, policyLoader: () => loadRankingPolicy(db) });
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
