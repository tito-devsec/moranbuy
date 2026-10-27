import Redis from 'ioredis';

const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Shared Redis client; a second client is made for blocking list reads.
export const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true, enableOfflineQueue: false });

// A dedicated connection for BLPOP so it never blocks the shared client.
export const createBlockingClient = (name) => new Redis(url, { connectionName: `moranbuy-${name}`, maxRetriesPerRequest: null, lazyConnect: true });

// Pings Redis, connecting first when lazy.
export async function checkRedisConnection() {
  if (redis.status === 'wait') await redis.connect();
  return (await redis.ping()) === 'PONG';
}
