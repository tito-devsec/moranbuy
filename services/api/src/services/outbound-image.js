import crypto from 'node:crypto';
import { config } from '@moranbuy/core';
import { logger } from '@moranbuy/observability';
import { db } from '../db/connection.js';
import { saveUpload, publicUrl, sniff } from './uploads.js';

// WhatsApp fetches a photo from the link it is given and accepts only JPEG or PNG. Product photos from shops can be relative links, behind hotlink protection, WebP, or redirects,
// so MoranBuy fetches the photo itself and serves a copy from its own address; a photo that cannot be made into one is skipped and its caption goes out as text.
const MAX_BYTES = 5 * 1024 * 1024;

let fetchOverride = null;
export const setOutboundImageFetchForTests = (fn) => { fetchOverride = fn; };

export async function prepareOutboundImage(url, { fetchImpl = fetchOverride || globalThis.fetch, dbImpl = db, base = process.env.MORAN_MEDIA_BASE_URL || null } = {}) {
  try {
    const own = String(config().APP_URL || '').replace(/\/+$/, '');
    let src = String(url || '').trim();
    if (!src) return null;
    if (own && src.startsWith(`${own}/media/`)) return src;
    if (src.startsWith('/')) { if (!base) return null; src = new URL(src, base).toString(); }
    if (!/^https:\/\//i.test(src)) return null;
    const res = await fetchImpl(src, { headers: { 'User-Agent': 'MoranBuyBot/1.0 (+https://buy.moranai.co.tz)', Accept: 'image/jpeg,image/png' }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_BYTES) return null;
    const type = sniff(buffer);
    if (!type || (type.mime !== 'image/jpeg' && type.mime !== 'image/png')) return null;
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = await dbImpl('uploads').where({ purpose: 'offer_image', sha256: sha }).first();
    return publicUrl(existing || await saveUpload({ dbImpl, buffer, purpose: 'offer_image' }));
  } catch (err) {
    logger.warn({ err: err.message }, 'Photo could not be prepared for WhatsApp');
    return null;
  }
}

// Sends a photo with its caption; if the photo cannot be prepared or WhatsApp refuses it, the same words go as a text so the customer loses nothing.
export async function sendPhoto(moran, { to, imageUrl, caption, idempotencyKey }, deps = {}) {
  const url = config().DEMO_MODE ? imageUrl : await prepareOutboundImage(imageUrl, deps);
  if (url) {
    const sent = await moran.sendImage({ to, imageUrl: url, caption, idempotencyKey });
    if (sent.ok) return sent;
    logger.warn({ status: sent.status }, 'Photo not delivered; sending the caption as text');
  }
  return moran.sendText({ to, body: caption || '.', idempotencyKey: `${idempotencyKey}:text` });
}
