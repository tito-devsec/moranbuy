import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, ApiError } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';
import { db } from '../db/connection.js';

// What each purpose accepts and who may see it; the type is read from the file's own bytes, never trusted from the request.
export const PURPOSES = Object.freeze({
  product_image: { kinds: ['image'], public: true },
  verification_document: { kinds: ['image', 'pdf'], public: false },
  customer_photo: { kinds: ['image'], public: false },
  voice_note: { kinds: ['audio'], public: false },  // a voice note a customer or business sent, kept briefly
  voice_reply: { kinds: ['audio'], public: false }, // the spoken reply MoranBuy made, kept briefly for review
  delivery_photo: { kinds: ['image'], public: false }, // evidence a delivery person sent at the door
  receipt: { kinds: ['pdf'], public: false }, // a receipt MoranBuy issued; a financial record
});
// Files MoranBuy makes or must keep as evidence are not counted against anyone's daily upload cap.
const UNCAPPED = new Set(['voice_reply', 'delivery_photo', 'receipt']);
const DAILY_LIMIT = 200;

// The real type of a file from its first bytes: JPEG, PNG, WebP or PDF; anything else is refused.
export function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png', kind: 'image' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', kind: 'pdf' };
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return { mime: 'audio/ogg', ext: 'ogg', kind: 'audio' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return { mime: 'audio/wav', ext: 'wav', kind: 'audio' };
  return null;
}

export const uploadDir = () => path.resolve(config().UPLOAD_DIR || 'data/uploads');
const filePath = (key) => path.join(uploadDir(), path.basename(key));
export const publicUrl = (row) => `${String(config().APP_URL).replace(/\/+$/, '')}/media/${row.storage_key}`;

// Checks and stores one file, then records it; the stored name is random so nothing about the uploader is in it.
export async function saveUpload({ dbImpl = db, buffer, purpose, merchantId = null, customerId = null, originalName = null, uploadedBy = null }) {
  const rule = PURPOSES[purpose];
  if (!rule) throw new ApiError(400, 'BAD_PURPOSE', 'Unknown upload purpose.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ApiError(400, 'EMPTY_FILE', 'Send the file as the request body with its content type, for example image/jpeg.');
  const type = sniff(buffer);
  if (!type || !rule.kinds.includes(type.kind)) throw new ApiError(415, 'UNSUPPORTED_FILE', rule.kinds.includes('audio') ? 'Only Ogg Opus voice notes or WAV recordings are accepted.' : rule.kinds.includes('pdf') ? 'Only JPEG, PNG, WebP or PDF files are accepted.' : 'Only JPEG, PNG or WebP images are accepted.');
  const c = config();
  const max = (type.kind === 'pdf' ? c.UPLOAD_MAX_PDF_MB : type.kind === 'audio' ? 16 : c.UPLOAD_MAX_IMAGE_MB) * 1024 * 1024;
  if (buffer.length > max) throw new ApiError(413, 'FILE_TOO_LARGE', `The file is larger than ${Math.round(max / 1048576)} MB.`);
  // A daily cap per owner keeps storage from being filled by one account.
  const owner = merchantId ? { merchant_id: merchantId } : { customer_id: customerId };
  // Spoken replies are made by MoranBuy itself, so the per-owner daily cap does not apply to them.
  const today = UNCAPPED.has(purpose) ? { n: 0 } : await dbImpl('uploads').where(owner).where('created_at', '>=', new Date(Date.now() - 86400000)).count('id as n').first();
  if (Number(today.n) >= DAILY_LIMIT) throw new ApiError(429, 'UPLOAD_LIMIT', 'Too many uploads today; try again tomorrow.');
  const key = `${crypto.randomUUID()}.${type.ext}`;
  await fs.mkdir(uploadDir(), { recursive: true });
  await fs.writeFile(filePath(key), buffer, { flag: 'wx', mode: 0o640 });
  const [row] = await dbImpl('uploads').insert({ purpose, merchant_id: merchantId, customer_id: customerId, mime: type.mime, ext: type.ext, size_bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), storage_key: key, original_name: originalName ? String(originalName).replace(/[^\w.\- ]+/g, '').slice(0, 160) : null, uploaded_by: uploadedBy }).returning('*');
  if (merchantId) await audit(dbImpl, { actorType: 'merchant', actorId: uploadedBy, merchantId, action: 'upload.created', targetType: 'upload', targetId: row.id, after: { purpose, mime: type.mime, size: buffer.length } });
  return row;
}

export const readUpload = (row) => fs.readFile(filePath(row.storage_key));

// A private image as a data URL, so Muse can read it without the file ever being public.
export async function uploadDataUrl(row) {
  return `data:${row.mime};base64,${(await readUpload(row)).toString('base64')}`;
}

export function publicUpload(row) {
  return { id: row.id, purpose: row.purpose, mime: row.mime, sizeBytes: row.size_bytes, originalName: row.original_name, createdAt: row.created_at, url: PURPOSES[row.purpose]?.public ? publicUrl(row) : null };
}

// Removes the file and its record; a missing file is not an error, the record still goes.
export async function deleteUpload(dbImpl, row) {
  await fs.unlink(filePath(row.storage_key)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  await dbImpl('uploads').where({ id: row.id }).del();
}
