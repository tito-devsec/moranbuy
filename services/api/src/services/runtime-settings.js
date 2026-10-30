import { encrypt, decrypt } from '@moranbuy/authorization';
import { config } from '@moranbuy/core';
import { db } from '../db/connection.js';

// Credentials an administrator enters in MoranBuy Admin; stored encrypted in platform_settings and read at runtime, so no restart is needed.
export const CREDENTIAL_FIELDS = Object.freeze({
  muse: ['provider', 'baseUrl', 'apiKey', 'model', 'reasoningEffort'],
  snippe: ['apiKey', 'webhookSecret', 'baseUrl'],
  hermes: ['baseUrl', 'apiKey', 'model', 'enabled', 'allowedDomains'],
  // Spoken replies with Meta's MMS voices, run inside MoranBuy; no key is needed, only on or off and when to speak.
  tts: ['provider', 'mode'],
  // Looking beyond MoranBuy's own shops: Meta web search with its daily limit and site lists, and Google Places for nearby shops.
  discovery: ['mode', 'dailySearchLimit', 'blockedDomains', 'preferredDomains', 'warmup', 'placesApiKey', 'placesEnabled', 'placesDailyLimit'],
});
const SECRET = new Set(['apiKey', 'webhookSecret', 'placesApiKey']);
const CACHE_MS = 15000;
let cache = { at: 0, value: null };

// The stored credentials, decrypted; a 15-second cache keeps the database out of every Muse call.
export async function getCredentials({ dbImpl = db, fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await dbImpl('platform_settings').where({ key: 'credentials' }).first();
  const stored = row?.value || {};
  const out = {};
  for (const [group, fields] of Object.entries(CREDENTIAL_FIELDS)) {
    out[group] = {};
    for (const f of fields) {
      const v = stored[group]?.[f];
      if (v === undefined || v === null || v === '') continue;
      out[group][f] = SECRET.has(f) ? safeDecrypt(v) : v;
    }
  }
  cache = { at: Date.now(), value: out };
  return out;
}

function safeDecrypt(v) { try { return decrypt(v); } catch { return null; } }

// Saves one group; secrets are encrypted, an empty string clears a field, and an omitted field keeps its value.
export async function saveCredentials(group, patch, { updatedBy, dbImpl = db }) {
  if (!CREDENTIAL_FIELDS[group]) throw new Error(`Unknown credential group ${group}`);
  const row = await dbImpl('platform_settings').where({ key: 'credentials' }).first();
  const stored = row?.value || {};
  const next = { ...(stored[group] || {}) };
  for (const f of CREDENTIAL_FIELDS[group]) {
    if (patch[f] === undefined) continue;
    if (patch[f] === '' || patch[f] === null) { delete next[f]; continue; }
    next[f] = SECRET.has(f) ? encrypt(String(patch[f])) : patch[f];
  }
  stored[group] = next;
  await dbImpl('platform_settings').insert({ key: 'credentials', value: JSON.stringify(stored), updated_by: updatedBy, updated_at: dbImpl.fn.now() }).onConflict('key').merge();
  cache = { at: 0, value: null };
  return getCredentials({ dbImpl, fresh: true });
}

// What the admin page may see: whether each secret is set and its last four characters, never the value.
export async function describeCredentials(opts) {
  const c = await getCredentials(opts);
  const env = config();
  const mask = (v) => (v ? { configured: true, last4: String(v).slice(-4) } : { configured: false });
  return {
    tts: { ...(await ttsRuntimeConfig(opts)) },
    muse: { provider: c.muse.provider || env.MUSE_PROVIDER, baseUrl: c.muse.baseUrl || env.MUSE_API_BASE_URL, model: c.muse.model || env.MUSE_MODEL_ID, reasoningEffort: c.muse.reasoningEffort || env.MUSE_REASONING_EFFORT, apiKey: mask(c.muse.apiKey || env.MUSE_API_KEY), source: c.muse.apiKey ? 'admin' : env.MUSE_API_KEY ? 'environment' : 'none' },
    snippe: { baseUrl: c.snippe.baseUrl || env.SNIPPE_BASE_URL, apiKey: mask(c.snippe.apiKey || env.SNIPPE_API_KEY), webhookSecret: mask(c.snippe.webhookSecret || env.SNIPPE_WEBHOOK_SECRET), provider: env.PAYMENT_PROVIDER, source: c.snippe.apiKey ? 'admin' : env.SNIPPE_API_KEY ? 'environment' : 'none' },
    discovery: { mode: c.discovery.mode || 'meta_web', dailySearchLimit: c.discovery.dailySearchLimit ?? 300, blockedDomains: c.discovery.blockedDomains || '', preferredDomains: c.discovery.preferredDomains || '', warmup: c.discovery.warmup ?? true, placesEnabled: c.discovery.placesEnabled ?? true, placesDailyLimit: c.discovery.placesDailyLimit ?? 300, placesApiKey: mask(c.discovery.placesApiKey || process.env.GOOGLE_PLACES_API_KEY), museKey: !!(c.muse.apiKey || env.MUSE_API_KEY) },
    hermes: { baseUrl: c.hermes.baseUrl || env.HERMES_BASE_URL || null, model: c.hermes.model || env.HERMES_MODEL, enabled: c.hermes.enabled ?? env.MORANBUY_WEB_RESEARCH_ENABLED, allowedDomains: c.hermes.allowedDomains || env.MORANBUY_ALLOWED_DOMAINS || '', apiKey: mask(c.hermes.apiKey || env.HERMES_API_KEY) },
  };
}

// Effective Muse settings: admin values first, then the environment.
export async function museRuntimeConfig(opts) {
  const c = await getCredentials(opts);
  const env = config();
  const apiKey = c.muse.apiKey || env.MUSE_API_KEY || null;
  const provider = c.muse.provider || env.MUSE_PROVIDER;
  return { provider: apiKey && provider === 'disabled' ? 'meta' : provider, baseUrl: c.muse.baseUrl || env.MUSE_API_BASE_URL, apiKey, model: c.muse.model || env.MUSE_MODEL_ID, reasoningEffort: c.muse.reasoningEffort || env.MUSE_REASONING_EFFORT, timeoutMs: env.MUSE_TIMEOUT_MS };
}

// Effective Snippe settings; the provider is Snippe whenever a key exists from either source.
export async function paymentRuntimeConfig(opts) {
  const c = await getCredentials(opts);
  const env = config();
  const apiKey = c.snippe.apiKey || env.SNIPPE_API_KEY || null;
  return { provider: apiKey ? 'snippe' : env.PAYMENT_PROVIDER === 'snippe' ? 'snippe' : 'sandbox', apiKey, webhookSecret: c.snippe.webhookSecret || env.SNIPPE_WEBHOOK_SECRET || null, baseUrl: c.snippe.baseUrl || env.SNIPPE_BASE_URL, appUrl: env.APP_URL };
}

export async function researchRuntimeConfig(opts) {
  const c = await getCredentials(opts);
  const env = config();
  return { enabled: c.hermes.enabled ?? env.MORANBUY_WEB_RESEARCH_ENABLED, baseUrl: c.hermes.baseUrl || env.HERMES_BASE_URL || null, apiKey: c.hermes.apiKey || env.HERMES_API_KEY || null, model: c.hermes.model || env.HERMES_MODEL, allowedDomains: c.hermes.allowedDomains || env.MORANBUY_ALLOWED_DOMAINS || '' };
}

export function resetCredentialsCacheForTests() { cache = { at: 0, value: null }; }

export const MMS_VOICES = Object.freeze({ sw: 'facebook/mms-tts-swh', en: 'facebook/mms-tts-eng' });

// Effective speech settings: Meta MMS is on by default once its models are in the image; any older provider value reads as Meta MMS.
export async function ttsRuntimeConfig(opts) {
  const c = (await getCredentials(opts)).tts || {};
  const provider = c.provider === 'disabled' ? 'disabled' : 'meta_mms';
  const { mmsAvailable } = await import('./speech/mms.js');
  const models = { sw: mmsAvailable('sw'), en: mmsAvailable('en') };
  return { enabled: provider === 'meta_mms' && (models.sw || models.en), provider, mode: c.mode || 'mirror', models, voices: MMS_VOICES };
}
