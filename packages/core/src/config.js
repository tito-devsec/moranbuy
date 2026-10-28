import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// Reads a boolean flag from the environment, accepting 1/true/yes/on.
const flag = (fallback) => z.preprocess((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())), z.boolean());
// Reads an integer from the environment with a fallback.
const int = (fallback) => z.preprocess((v) => (v === undefined || v === '' ? fallback : Number(v)), z.number().int());
// Reads an optional string, treating an empty value as absent.
const opt = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

// Every environment variable MoranBuy reads, validated once at startup.
const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:4000'),
  PORT: int(4000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  AUTH_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be 32 bytes as hex'),
  ADMIN_BOOTSTRAP_EMAIL: opt(),
  ADMIN_BOOTSTRAP_PASSWORD: opt(),

  MORAN_BACKEND_BASE_URL: opt(),
  // Moran's /internal routes are closed at its public nginx, so the signed channel can use a private address (http://backend:3000 on the VPS).
  MORAN_INTERNAL_BASE_URL: opt(),
  MORAN_SHARED_SECRET: opt(),

  WHATSAPP_APP_SECRET: opt(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: opt(),

  MUSE_PROVIDER: z.enum(['meta', 'openai-compatible', 'disabled']).default('disabled'),
  MUSE_API_BASE_URL: z.string().url().default('https://api.meta.ai/v1'),
  MUSE_API_KEY: opt(),
  MUSE_MODEL_ID: z.string().default('muse-spark-1.3'),
  MUSE_TIMEOUT_MS: int(30000),
  // Audio goes to the Muse Spark version Meta recommends for audio input (1.3 does not fully support it yet).
  MUSE_AUDIO_MODEL_ID: z.string().default('muse-spark-1.2'),
  MUSE_ASR_MODEL_ID: z.string().default('muse-voice-transcribe-1.0'),
  // Segment Anything 3.1 on the Meta Model API, for finding products in photos.
  MUSE_SAM_MODEL_ID: z.string().default('sam-3.1'),
  MUSE_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('low'),

  HERMES_BASE_URL: opt(),
  HERMES_API_KEY: opt(),
  HERMES_MODEL: z.string().default('hermes-agent'),
  MORANBUY_WEB_RESEARCH_ENABLED: flag(false),
  MORANBUY_ALLOWED_DOMAINS: z.string().default(''),

  PAYMENT_PROVIDER: z.enum(['snippe', 'sandbox']).default('sandbox'),
  SNIPPE_API_KEY: opt(),
  SNIPPE_WEBHOOK_SECRET: opt(),
  SNIPPE_BASE_URL: z.string().url().default('https://api.snippe.sh'),

  CAMPAIGN_DRY_RUN: flag(true),
  FOLLOWUP_DRY_RUN: flag(true),
  REMINDER_DRY_RUN: flag(true),
  RETENTION_DRY_RUN: flag(true),
  UPLOAD_DIR: opt(),
  UPLOAD_MAX_IMAGE_MB: int(5),
  UPLOAD_MAX_PDF_MB: int(10),
  CAMPAIGN_SEND_INTERVAL_MS: int(150),

  GEOCODER_BASE_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  GEOCODER_CONTACT_EMAIL: opt(),
  DEFAULT_CURRENCY: z.string().length(3).default('TZS'),
  DEFAULT_COUNTRY: z.string().length(2).default('TZ'),
});

let cached = null;

// Loads and validates configuration; throws a readable list of problems when something is wrong.
export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${lines.join('\n  ')}`);
  }
  const c = parsed.data;
  if (c.APP_ENV === 'production') assertProductionConfig(c);
  return c;
}

// Refuses to run production with placeholder secrets or live sending without its prerequisites.
export function assertProductionConfig(c) {
  const problems = [];
  if (/change_me|example|dev-secret/i.test(c.AUTH_SECRET)) problems.push('AUTH_SECRET is a placeholder');
  if (!c.MORAN_SHARED_SECRET) problems.push('MORAN_SHARED_SECRET is required in production');
  if (!c.CAMPAIGN_DRY_RUN && c.PAYMENT_PROVIDER === 'sandbox') problems.push('CAMPAIGN_DRY_RUN=false needs PAYMENT_PROVIDER=snippe (keys may be entered in MoranBuy Admin)');
  if (problems.length) throw new Error(`Unsafe production configuration:\n  ${problems.join('\n  ')}`);
}

// Returns the process-wide configuration, loading it on first use.
export function config() {
  if (!cached) cached = loadConfig();
  return cached;
}

// Test hook that replaces the cached configuration.
export function setConfigForTests(c) { cached = c; }
