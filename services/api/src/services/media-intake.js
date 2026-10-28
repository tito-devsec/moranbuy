import { logger } from '@moranbuy/observability';
import { museTranscribeVoice } from '@moranbuy/muse-intelligence';
import { db } from '../db/connection.js';
import { saveUpload, uploadDataUrl } from './uploads.js';
import { toSpeechWav } from './audio.js';

// A voice note in, words out: kept privately, decoded here, heard by Muse; the transcript is stored beside the recording.
export async function intakeVoice({ dbImpl = db, muse, buffer, customerId = null, merchantId = null, requestRef = null }) {
  let upload = null;
  try { upload = await saveUpload({ dbImpl, buffer, purpose: 'voice_note', customerId, merchantId }); } catch (err) { return { ok: false, reason: err.code || 'not_saved' }; }
  const decoded = await toSpeechWav(buffer).catch((err) => ({ ok: false, reason: `decode_failed:${err.message}`.slice(0, 60) }));
  if (!decoded.ok) return { ok: false, reason: decoded.reason, uploadId: upload.id };
  const heard = muse?.enabled ? await museTranscribeVoice(muse, { wav: decoded.wav, merchantId, requestRef }).catch((err) => ({ ok: false, status: err.message })) : { ok: false, status: 'muse_disabled' };
  await dbImpl('uploads').where({ id: upload.id }).update({ duration_ms: Math.round(decoded.seconds * 1000), transcript: heard.ok ? heard.transcript : null });
  if (!heard.ok) { logger.info({ uploadId: upload.id, status: heard.status }, 'Voice note not transcribed'); return { ok: false, reason: heard.status || 'not_heard', uploadId: upload.id, seconds: decoded.seconds }; }
  return { ok: true, text: heard.transcript, language: heard.language, source: heard.source, uploadId: upload.id, seconds: decoded.seconds };
}

// A photo in: kept privately, and handed to Muse as data so it never has to be public.
export async function intakeImage({ dbImpl = db, buffer, customerId = null, merchantId = null }) {
  const upload = await saveUpload({ dbImpl, buffer, purpose: 'customer_photo', customerId, merchantId: customerId ? null : merchantId }).catch(() => null);
  if (!upload) return { ok: false };
  return { ok: true, uploadId: upload.id, dataUrl: await uploadDataUrl(upload), ref: `upload:${upload.id}` };
}
