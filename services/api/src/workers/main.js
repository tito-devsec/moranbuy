import { logger } from '@moranbuy/observability';

import { processCampaignQueue } from '@moranbuy/campaign-engine';
import { processDueFollowups } from '@moranbuy/followup-engine';
import { pullMoranListings } from '@moranbuy/product-catalog';
import { shoppingDeps } from '../services/shopping.js';
import { db } from '../db/connection.js';
import { engagementDeps } from '../services/engagement.js';

// A polling worker: one pass every interval, never two passes at once in this process.
function pollingWorker(name, intervalMs, pass) {
  let timer = null; let busy = false;
  return {
    name,
    async start() { timer = setInterval(async () => { if (busy) return; busy = true; try { const s = await pass(); if (Object.values(s).some(Boolean)) logger.info({ worker: name, ...s }, 'worker pass'); } catch (err) { logger.error({ worker: name, err: err.message }, 'worker pass failed'); } finally { busy = false; } }, intervalMs); },
    async stop() { clearInterval(timer); },
  };
}

// Campaign dispatch and follow-up delivery; both honour the dry-run flags from the configuration.
export const workers = [
  pollingWorker('campaign-dispatch', Number(process.env.CAMPAIGN_SEND_INTERVAL_MS || 150) * 10, () => processCampaignQueue(db, engagementDeps().sender)),
  pollingWorker('followup-delivery', 30000, () => processDueFollowups(db, engagementDeps().sender, { dryRun: engagementDeps().followupDryRun, muse: engagementDeps().muse })),
  // Opted-in Moran businesses and their products: changes every 10 minutes, a full pass (which archives what is no longer listed) every 6 hours.
  pollingWorker('moran-listings-pull', Number(process.env.MORAN_LISTINGS_SYNC_INTERVAL_MS || 600000), () => pullMoranListings(db, shoppingDeps().moran, { full: Date.now() % (6 * 3600000) < Number(process.env.MORAN_LISTINGS_SYNC_INTERVAL_MS || 600000) })),
];

async function main() {
  for (const w of workers) await w.start();
  logger.info({ workers: workers.map((w) => w.name) }, 'MoranBuy workers running');
  const stop = async () => { for (const w of workers) await w.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => { logger.error({ err: err.message }, 'Worker failed'); process.exit(1); });
