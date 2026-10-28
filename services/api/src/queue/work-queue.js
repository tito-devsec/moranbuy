// A Redis work list for timed jobs: Postgres stays the record of what must happen, Redis says when to look at each item.
// Each queue is a sorted set scored by run time (deduplicated by job id), a lease set for jobs being worked on, an attempts hash and a dead list.

const RESERVE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1)
if #due == 0 then return nil end
redis.call('ZREM', KEYS[1], due[1])
redis.call('ZADD', KEYS[2], ARGV[2], due[1])
return due[1]`;

const REAP = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZADD', KEYS[1], 'NX', ARGV[1], id)
end
return #expired`;

export class WorkQueue {
  constructor(redis, name, { leaseMs = 60000, maxAttempts = 5, prefix = 'moranbuy:queue' } = {}) {
    this.redis = redis; this.name = name; this.leaseMs = leaseMs; this.maxAttempts = maxAttempts;
    const k = `${prefix}:${name}`;
    this.keys = { jobs: `${k}:jobs`, leases: `${k}:leases`, attempts: `${k}:attempts`, dead: `${k}:dead`, done: `${k}:done` };
  }

  // Adds a job to run at a time (now by default); adding the same id again only moves it earlier, never later.
  async enqueue(id, runAt = Date.now()) {
    await this.redis.zadd(this.keys.jobs, 'LT', Math.round(Number(runAt)), String(id));
    // A job id that was already finished is allowed to run again; its handler decides from Postgres whether there is anything to do.
    return true;
  }

  // Many jobs in one round trip.
  async enqueueMany(items) {
    if (!items.length) return 0;
    const args = items.flatMap(({ id, runAt }) => [Math.round(Number(runAt ?? Date.now())), String(id)]);
    await this.redis.zadd(this.keys.jobs, 'LT', ...args);
    return items.length;
  }

  // Takes the next due job and leases it; nothing else can take it until it is acknowledged, failed, or the lease runs out.
  async reserve(now = Date.now()) {
    return this.redis.eval(RESERVE, 2, this.keys.jobs, this.keys.leases, now, now + this.leaseMs);
  }

  async ack(id) {
    await this.redis.multi().zrem(this.keys.leases, id).hdel(this.keys.attempts, id).incr(this.keys.done).exec();
  }

  // A failed job is retried with a growing delay; after the last attempt it goes to the dead list for an admin to see.
  async fail(id, err, now = Date.now()) {
    const attempts = await this.redis.hincrby(this.keys.attempts, id, 1);
    const tx = this.redis.multi().zrem(this.keys.leases, id);
    if (attempts >= this.maxAttempts) tx.lpush(this.keys.dead, JSON.stringify({ id, error: String(err?.message || err).slice(0, 300), attempts, at: new Date(now).toISOString() })).ltrim(this.keys.dead, 0, 499).hdel(this.keys.attempts, id);
    else tx.zadd(this.keys.jobs, now + Math.min(600000, 5000 * 2 ** (attempts - 1)), id);
    await tx.exec();
    return attempts >= this.maxAttempts ? 'dead' : 'retry';
  }

  // Jobs whose worker died mid-way go back to the queue.
  async reap(now = Date.now()) {
    return this.redis.eval(REAP, 2, this.keys.jobs, this.keys.leases, now);
  }

  async stats(now = Date.now()) {
    const [queued, due, leased, dead, done] = await this.redis.multi().zcard(this.keys.jobs).zcount(this.keys.jobs, '-inf', now).zcard(this.keys.leases).llen(this.keys.dead).get(this.keys.done).exec().then((r) => r.map(([, v]) => v));
    const next = await this.redis.zrange(this.keys.jobs, 0, 0, 'WITHSCORES');
    return { queue: this.name, queued: Number(queued), due: Number(due), leased: Number(leased), dead: Number(dead), done: Number(done || 0), nextRunAt: next[1] ? new Date(Number(next[1])).toISOString() : null };
  }

  async deadJobs(limit = 50) {
    return (await this.redis.lrange(this.keys.dead, 0, limit - 1)).map((x) => JSON.parse(x));
  }

  // An admin sends every dead job back for another round.
  async retryDead(now = Date.now()) {
    const all = await this.deadJobs(500);
    if (!all.length) return 0;
    await this.enqueueMany(all.map((j) => ({ id: j.id, runAt: now })));
    await this.redis.del(this.keys.dead);
    return all.length;
  }
}
