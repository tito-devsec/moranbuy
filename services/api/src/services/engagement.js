import { config } from '@moranbuy/core';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { MoranInternalClient } from '@moranbuy/integrations';
import { RuntimePaymentProvider, DEFAULT_PRICING } from '@moranbuy/billing';
import { museRuntimeConfig, paymentRuntimeConfig } from './runtime-settings.js';
import { DryRunSender, MoranMerchantSender } from '@moranbuy/campaign-engine';
import { db } from '../db/connection.js';
import { demoMoran } from '../demo/stand-ins.js';

let shared = null;

// Campaign pricing as the admin configured it, falling back to the defaults (which leave the provider rate unknown).
export async function loadCampaignPricing(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'campaign_pricing' }).first();
  return { ...DEFAULT_PRICING, ...(row?.value || {}) };
}

// Muse, the payment provider, and the sender used by campaigns and follow-ups; dry-run keeps the recording sender.
export function engagementDeps() {
  if (!shared) {
    const c = config();
    const moran = c.DEMO_MODE ? demoMoran() : new MoranInternalClient({ cfg: c });
    shared = { muse: new MuseClient({ cfg: c, db, resolve: () => museRuntimeConfig() }), payments: new RuntimePaymentProvider({ resolve: () => paymentRuntimeConfig(), cfg: c }), moran, sender: c.CAMPAIGN_DRY_RUN ? new DryRunSender() : new MoranMerchantSender(moran), dryRun: c.CAMPAIGN_DRY_RUN, followupDryRun: c.FOLLOWUP_DRY_RUN };
  }
  return shared;
}

export function setEngagementDepsForTests(deps) { shared = deps; }
