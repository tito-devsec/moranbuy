import { logger } from '@moranbuy/observability';

import { processCampaignQueue, startDueCampaigns } from '@moranbuy/campaign-engine';
import { processDueFollowups } from '@moranbuy/followup-engine';
import { pullMoranListings } from '@moranbuy/product-catalog';
import { shoppingDeps } from '../services/shopping.js';
import { db } from '../db/connection.js';
import { engagementDeps, loadCampaignPricing } from '../services/engagement.js';
import { processDueReminders } from '../services/schedule-reminders.js';
import { purgeExpired } from '../services/retention.js';
import { config } from '@moranbuy/core';
import { QUEUE_NAMES, feedQueues, runOne, queue, redisReady } from '../queue/jobs.js';

// redis (default): timed jobs run from the Redis work list within a second of being due; poll: the Postgres passes alone, as before.
const queueMode = () => (process.env.QUEUE_MODE === 'poll' ? 'poll' : 'redis');
const SAFETY_MS = 5 * 60000;

// A polling worker: one pass every interval, never two passes at once in this process.
function pollingWorker(name, intervalMs, pass, { whenQueueUp = null } = {}) {
  // With the Redis work list running, the timed workers become a slow safety pass that catches anything the queue missed.
  let last = 0;
  const inner = pass;
  pass = async () => { if (whenQueueUp && queueMode() === 'redis' && (await redisReady()) && Date.now() - last < whenQueueUp) return {}; last = Date.now(); return inner(); };
  let timer = null; let busy = false;
  return {
    name,
    async start() { timer = setInterval(async () => { if (busy) return; busy = true; try { const s = await pass(); if (Object.values(s).some(Boolean)) logger.info({ worker: name, ...s }, 'worker pass'); } catch (err) { logger.error({ worker: name, err: err.message }, 'worker pass failed'); } finally { busy = false; } }, intervalMs); },
    async stop() { clearInterval(timer); },
  };
}

// Campaign dispatch and follow-up delivery; both honour the dry-run flags from the configuration.
export const workers = [
  pollingWorker('campaign-schedule', 30000, async () => startDueCampaigns(db, { pricingConfigured: (await loadCampaignPricing()).providerUnitTzs !== null }), { whenQueueUp: SAFETY_MS }),
  pollingWorker('campaign-dispatch', Number(process.env.CAMPAIGN_SEND_INTERVAL_MS || 150) * 10, () => processCampaignQueue(db, engagementDeps().sender), { whenQueueUp: SAFETY_MS }),
  pollingWorker('retention-purge', Number(process.env.RETENTION_INTERVAL_MS || 6 * 3600000), () => purgeExpired({ dryRun: config().RETENTION_DRY_RUN })),
  pollingWorker('schedule-reminders', Number(process.env.REMINDER_INTERVAL_MS || 60000), () => processDueReminders({ moran: shoppingDeps().moran, dryRun: config().REMINDER_DRY_RUN }), { whenQueueUp: SAFETY_MS }),
  pollingWorker('followup-delivery', 30000, () => processDueFollowups(db, engagementDeps().sender, { dryRun: engagementDeps().followupDryRun, muse: engagementDeps().muse }), { whenQueueUp: SAFETY_MS }),
  // Opted-in Moran businesses and their products: changes every 10 minutes, a full pass (which archives what is no longer listed) every 6 hours.
  pollingWorker('moran-listings-pull', Number(process.env.MORAN_LISTINGS_SYNC_INTERVAL_MS || 600000), () => pullMoranListings(db, shoppingDeps().moran, { full: Date.now() % (6 * 3600000) < Number(process.env.MORAN_LISTINGS_SYNC_INTERVAL_MS || 600000) })),
];

// The Redis work list: a feeder loads what falls due in the next two minutes, a reaper returns jobs whose worker died, and one consumer per queue runs due jobs as they come.
function queueRunner() {
  const timers = [];
  let stopping = false;
  const every = (ms, fn) => { let busy = false; timers.push(setInterval(async () => { if (busy || stopping) return; busy = true; try { if (await redisReady()) await fn(); } catch (err) { logger.error({ err: err.message }, 'queue loop failed'); } finally { busy = false; } }, ms)); };
  return {
    name: 'redis-work-queue',
    async start() {
      if (queueMode() !== 'redis') return;
      every(15000, () => feedQueues());
      every(30000, async () => { for (const n of QUEUE_NAMES) await queue(n).reap(); });
      // Each queue drains every due job, then waits a quarter second before looking again.
      for (const n of QUEUE_NAMES) every(250, async () => { for (let i = 0; i < 100 && !stopping; i += 1) { if (!(await runOne(n))) break; } });
    },
    async stop() { stopping = true; for (const t of timers) clearInterval(t); },
  };
}
workers.push(queueRunner());

async function main() {
  for (const w of workers) await w.start();
  logger.info({ workers: workers.map((w) => w.name) }, 'MoranBuy workers running');
  const stop = async () => { for (const w of workers) await w.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => { logger.error({ err: err.message }, 'Worker failed'); process.exit(1); });
