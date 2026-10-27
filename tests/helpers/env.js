// Sets safe test configuration before any package reads the environment.
Object.assign(process.env, {
  APP_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://moranbuy:moranbuy@127.0.0.1:5432/moranbuy_test',
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  AUTH_SECRET: process.env.AUTH_SECRET || 'test-secret-test-secret-test-secret-test',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  MORAN_SHARED_SECRET: process.env.MORAN_SHARED_SECRET || 'test-shared-secret',
  MUSE_PROVIDER: process.env.MUSE_PROVIDER || 'disabled',
  PAYMENT_PROVIDER: 'sandbox',
  CAMPAIGN_DRY_RUN: 'true',
  FOLLOWUP_DRY_RUN: 'true',
});
if (/prod|moranai\.co\.tz/i.test(process.env.DATABASE_URL)) throw new Error('Refusing to run tests against what looks like production');
