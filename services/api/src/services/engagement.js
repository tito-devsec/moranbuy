import { config } from '@moranbuy/core';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { MoranInternalClient } from '@moranbuy/integrations';
import { createPaymentProvider, DEFAULT_PRICING } from '@moranbuy/billing';
import { DryRunSender, MoranMerchantSender } from '@moranbuy/campaign-engine';
import { db } from '../db/connection.js';

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
    const moran = new MoranInternalClient({ cfg: c });
    shared = { muse: new MuseClient({ cfg: c, db }), payments: createPaymentProvider(c), moran, sender: c.CAMPAIGN_DRY_RUN ? new DryRunSender() : new MoranMerchantSender(moran), dryRun: c.CAMPAIGN_DRY_RUN, followupDryRun: c.FOLLOWUP_DRY_RUN };
  }
  return shared;
}

export function setEngagementDepsForTests(deps) { shared = deps; }
