import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@moranbuy/observability';
import { spellNumbers } from './numbers.js';
import { encodeOggOpus } from './ogg-opus.js';

// Meta's MMS text-to-speech (facebook/mms-tts-swh and mms-tts-eng), exported to ONNX at image build and run inside this process.
export const MMS_LANGUAGES = Object.freeze({ sw: 'swh', en: 'eng' });
const IDLE_MS = 10 * 60 * 1000;
const PAUSE_SECONDS = 0.25;

export const modelDir = () => process.env.TTS_MODEL_DIR || path.resolve(process.cwd(), 'models/tts');

export function mmsAvailable(language = 'sw', dir = modelDir()) {
  const code = MMS_LANGUAGES[language] || MMS_LANGUAGES.sw;
  return fs.existsSync(path.join(dir, code, 'model.onnx')) && fs.existsSync(path.join(dir, code, 'tokenizer.json'));
}

// The model's own character tokenizer: lower case, characters outside its alphabet dropped, a blank between every character.
export function tokenize(text, meta) {
  const ids = [0];
  for (const ch of String(text).toLowerCase()) {
    const id = meta.vocab[ch];
    if (id === undefined) continue;
    ids.push(id, 0);
  }
  return ids.length > 1 ? ids : null;
}

// Sentences of at most about 200 characters: shorter inputs keep the voice steady and memory low.
export function sentences(text, max = 200) {
  const out = [];
  for (const part of String(text).split(/(?<=[.!?;:])\s+|\n+/)) {
    let s = part.replace(/[.!?;:,]+$/g, '').trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max) > 40 ? s.lastIndexOf(' ', max) : max;
      out.push(s.slice(0, cut));
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

const sessions = new Map();
let queue = Promise.resolve();

async function session(code, dir) {
  const held = sessions.get(code);
  if (held) { clearTimeout(held.timer); held.timer = setTimeout(() => release(code), IDLE_MS).unref(); return held; }
  const ort = await import('onnxruntime-node');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, code, 'tokenizer.json'), 'utf8'));
  const s = await ort.InferenceSession.create(path.join(dir, code, 'model.onnx'));
  const entry = { ort, meta, session: s, timer: setTimeout(() => release(code), IDLE_MS).unref() };
  sessions.set(code, entry);
  logger.info({ model: meta.model }, 'Meta MMS voice loaded');
  return entry;
}

// The model is let go after ten idle minutes, so the memory is only held while people are talking to MoranBuy.
async function release(code) {
  const held = sessions.get(code);
  if (!held) return;
  sessions.delete(code);
  clearTimeout(held.timer);
  await held.session.release().catch(() => {});
}

export async function releaseAll() { for (const code of [...sessions.keys()]) await release(code); }

async function runOnce(text, language, dir) {
  const code = MMS_LANGUAGES[language] || MMS_LANGUAGES.sw;
  const { ort, meta, session: s } = await session(code, dir);
  const rate = meta.sampleRate || 16000;
  const pieces = [];
  for (const sentence of sentences(spellNumbers(text, language))) {
    const ids = tokenize(sentence, meta);
    if (!ids) continue;
    const out = await s.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]) });
    pieces.push(out.waveform.data, new Float32Array(Math.round(rate * PAUSE_SECONDS)));
  }
  if (!pieces.length) return { ok: false, status: 'nothing_to_say' };
  const length = pieces.reduce((n, p) => n + p.length, 0);
  const pcm = new Int16Array(length);
  let at = 0;
  for (const p of pieces) for (let i = 0; i < p.length; i++) pcm[at++] = Math.max(-32768, Math.min(32767, Math.round(p[i] * 32767)));
  return { ok: true, audio: encodeOggOpus(pcm, { sampleRate: rate }), seconds: length / rate, voice: meta.model };
}

// One synthesis at a time per process, so two voice notes never double the memory.
export function synthesizeMms({ text, language = 'sw', dir = modelDir() }) {
  if (!mmsAvailable(language, dir)) return Promise.resolve({ ok: false, status: 'model_missing' });
  const job = queue.then(() => runOnce(text, language, dir));
  queue = job.catch(() => {});
  return job;
}
