import { logger } from '@moranbuy/observability';
import { db } from '../db/connection.js';
import { ttsRuntimeConfig } from './runtime-settings.js';
import { saveUpload } from './uploads.js';
import { synthesizeMms } from './speech/mms.js';

// Whether this reply should also be spoken: "mirror" answers a voice note with a voice note, "always" speaks every offer list, "off" never speaks.
export function shouldSpeak(mode, { inboundKind, state }) {
  if (mode === 'off') return false;
  const meaningful = ['presented', 'selected', 'confirmed', 'clarifying'].includes(state);
  if (mode === 'always') return meaningful;
  return inboundKind === 'voice' && meaningful;
}

// The words to say: the reply with its list numbering kept, links and symbols removed, short enough for a voice note.
export function spokenText(text, language = 'sw') {
  let t = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/[*_~`#>]/g, '').replace(/\s*\n\s*/g, '. ').replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/\bTSh\b/g, language === 'en' ? 'shillings' : 'shilingi');
  if (t.length > 700) t = `${t.slice(0, t.lastIndexOf('.', 690) > 300 ? t.lastIndexOf('.', 690) + 1 : 690)}`;
  return t;
}

// The synthesizer in use; tests put a stand-in here instead of loading Meta's models.
let synthesizer = synthesizeMms;
export function setSynthesizerForTests(fn) { synthesizer = fn || synthesizeMms; }

// Makes the spoken version of a reply when the settings call for it; the voice note is kept privately for review and handed back as bytes.
export async function voiceReplyFor({ dbImpl = db, replies, language = 'sw', inboundKind, state, customerId = null, synthesize = synthesizer }) {
  const cfg = await ttsRuntimeConfig();
  if (!cfg.enabled || !cfg.models[language === 'en' ? 'en' : 'sw'] || !shouldSpeak(cfg.mode, { inboundKind, state })) return null;
  const textReply = [...replies].reverse().find((r) => r.text && !r.buttons);
  if (!textReply) return null;
  const text = spokenText(textReply.text, language);
  if (!text) return null;
  const out = await synthesize({ text, language }).catch((err) => ({ ok: false, status: `error:${String(err.message || err).slice(0, 60)}` }));
  if (!out.ok) { logger.warn({ status: out.status }, 'Spoken reply not made; the text reply stands'); return { ok: false, status: out.status }; }
  const upload = await saveUpload({ dbImpl, buffer: out.audio, purpose: 'voice_reply', customerId }).catch(() => null);
  if (upload) await dbImpl('uploads').where({ id: upload.id }).update({ transcript: text });
  return { ok: true, audio: out.audio, mime: 'audio/ogg; codecs=opus', voice: out.voice, uploadId: upload?.id || null, text };
}
