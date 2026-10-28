import { logger } from '@moranbuy/observability';
import { processCampaignQueue, startDueCampaigns } from '@moranbuy/campaign-engine';
import { processDueFollowups } from '@moranbuy/followup-engine';
import { config } from '@moranbuy/core';
import { db } from '../db/connection.js';
import { redis } from '../db/redis.js';
import { engagementDeps, loadCampaignPricing } from '../services/engagement.js';
import { shoppingDeps } from '../services/shopping.js';
import { processDueReminders } from '../services/schedule-reminders.js';
import { WorkQueue } from './work-queue.js';

// The four timed jobs and what each one does with the single item it names; every handler re-reads Postgres, so a stale or repeated job does nothing.
export const QUEUES = {
  'campaign-start': {
    handle: async (id) => startDueCampaigns(db, { campaignId: id, pricingConfigured: (await loadCampaignPricing()).providerUnitTzs !== null }),
    // A started campaign is handed straight to dispatch.
    after: async (id, out) => { if (out.started) await queue('campaign-dispatch').enqueue(id); },
    feed: async (until) => (await db('campaigns').where({ status: 'scheduled' }).where('scheduled_at', '<=', until).select('id', 'scheduled_at')).map((r) => ({ id: r.id, runAt: new Date(r.scheduled_at).getTime() })),
  },
  'campaign-dispatch': {
    handle: async (id) => processCampaignQueue(db, engagementDeps().sender, { campaignId: id }),
    // A campaign with recipients still queued comes back after the send interval, so large campaigns go out in paced batches.
    after: async (id) => {
      const left = await db('campaign_recipients').where({ campaign_id: id, status: 'queued' }).first('id');
      const running = await db('campaigns').where({ id, status: 'dispatching' }).first('id');
      if (left && running) await queue('campaign-dispatch').enqueue(id, Date.now() + Number(process.env.CAMPAIGN_SEND_INTERVAL_MS || 150) * 10);
    },
    feed: async () => (await db('campaigns').where({ status: 'dispatching' }).pluck('id')).map((id) => ({ id, runAt: Date.now() })),
  },
  followup: {
    handle: async (id) => processDueFollowups(db, engagementDeps().sender, { taskId: id, dryRun: engagementDeps().followupDryRun, muse: engagementDeps().muse }),
    // A task moved by quiet hours is due later; it is fed again when its new time comes near.
    feed: async (until) => (await db('followup_tasks').where({ status: 'pending' }).where('due_at', '<=', until).select('id', 'due_at')).map((r) => ({ id: r.id, runAt: new Date(r.due_at).getTime() })),
  },
  reminder: {
    handle: async (id) => processDueReminders({ scheduleId: id, moran: shoppingDeps().moran, dryRun: config().REMINDER_DRY_RUN }),
    feed: async (until) => (await db('customer_schedules').where({ status: 'scheduled' }).whereNotNull('due_at').where('due_at', '<=', until).select('id', 'due_at')).map((r) => ({ id: r.id, runAt: new Date(r.due_at).getTime() })),
  },
};

const instances = new Map();
export function queue(name, redisImpl = redis) {
  const key = `${name}`;
  if (!instances.has(key)) instances.set(key, new WorkQueue(redisImpl, name, { leaseMs: name === 'campaign-dispatch' ? 120000 : 60000 }));
  return instances.get(key);
}
export const QUEUE_NAMES = Object.freeze(Object.keys(QUEUES));

export async function redisReady() {
  try { if (redis.status === 'wait') await redis.connect(); return (await redis.ping()) === 'PONG'; } catch { return false; }
}

// Puts a job on its queue from the API side; when Redis is down the feeder and the safety pass still find the work in Postgres.
export async function enqueueSoft(name, id, runAt = Date.now()) {
  try { if (await redisReady()) await queue(name).enqueue(id, runAt); } catch (err) { logger.warn({ queue: name, err: err.message }, 'Job not queued; the feeder will pick it up'); }
}

// Loads every item due within the horizon from Postgres onto its queue; cheap, and it is what makes the queue complete even after Redis was emptied.
export async function feedQueues({ horizonMs = 120000, now = Date.now() } = {}) {
  const out = {};
  for (const [name, def] of Object.entries(QUEUES)) out[name] = await queue(name).enqueueMany(await def.feed(new Date(now + horizonMs)));
  return out;
}

// Runs one due job from a queue, if any: reserve, handle, follow-up, acknowledge, or record the failure for a retry.
export async function runOne(name, { now = Date.now() } = {}) {
  const q = queue(name);
  const id = await q.reserve(now);
  if (!id) return null;
  try {
    const out = await QUEUES[name].handle(id);
    if (QUEUES[name].after) await QUEUES[name].after(id, out);
    await q.ack(id);
    return { id, ok: true, out };
  } catch (err) {
    const fate = await q.fail(id, err);
    logger.error({ queue: name, id, err: err.message, fate }, 'Job failed');
    return { id, ok: false, fate };
  }
}

export async function queueStats() {
  if (!(await redisReady())) return { mode: 'poll', reason: 'redis_unavailable', queues: [] };
  return { mode: 'redis', queues: await Promise.all(QUEUE_NAMES.map((n) => queue(n).stats())) };
}
