import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jpeg from 'jpeg-js';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { toSpeechWav, encodeWav } from '../../services/api/src/services/audio.js';
import os from 'node:os';
import path from 'node:path';
import { spokenText, shouldSpeak, setSynthesizerForTests } from '../../services/api/src/services/voice-reply.js';
import { settleVoiceJobs } from '../../services/api/src/routes/internal-inbound.js';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { MuseClient, parseSamBoxes, museTranscribeVoice } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, signBody } from '@moranbuy/integrations';
import { hashPassword, signAccessToken } from '@moranbuy/authorization';
import { loadConfig } from '@moranbuy/core';

const TONE = fs.readFileSync(new URL('../fixtures/tone.ogg', import.meta.url));
const SPOKEN = 'Nina laki tatu na nusu ya sofa ya watu watatu nipo Sinza delivery';
let server; let base; let moran; let muse; let rootTok; let shop; let calls = []; let sparkDown = false;
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Stand-ins for Meta's endpoints that answer like the documented API and record what was sent.
async function metaFetch(url, init) {
  const u = String(url);
  if (u.endsWith('/asr/transcribe')) {
    const form = init.body;
    calls.push({ kind: 'asr', request: JSON.parse(await form.get('request').text()), audio: Buffer.from(await form.get('audio').arrayBuffer()) });
    return json({ sessionId: 's1', transcript: SPOKEN, audioDurationMs: 1200, turns: [] });
  }
  const body = JSON.parse(init.body);
  if (u.endsWith('/responses')) {
    const concept = body.input[0].content[0].text;
    calls.push({ kind: 'sam', body });
    const lines = { sofa: '<0f>0<|box;x1=0;y1=0;x2=99;y2=99;w=200;h=100;c=0.93|><|mask;x=0;y=0;data=1,!|>', chair: '<0f>0<|box;x1=100;y1=0;x2=199;y2=99;w=200;h=100;c=0.88|><|mask;x=0;y=0;data=1,!|>' };
    return json({ output_text: lines[concept] || '', usage: { input_tokens: 900, output_tokens: 40 } });
  }
  const parts = body.messages.at(-1).content;
  const audio = Array.isArray(parts) && parts.find((p) => p.type === 'input_audio');
  const image = Array.isArray(parts) && parts.find((p) => p.type === 'image_url');
  calls.push({ kind: audio ? 'spark_audio' : image ? 'spark_image' : 'spark', body });
  let content;
  if (audio) { if (sparkDown) return json({ error: { message: 'audio unavailable' } }, 503); content = { transcript: SPOKEN, language: 'sw' }; }
  else if (body.messages[0].content.includes('sent to list its products')) content = { kind: 'several', products: [
    { name: 'Sofa ya kijivu', productType: 'sofa', concept: 'sofa', category: 'furniture', price: 450000, stock: 2, attributes: { seats: 3 } },
    { name: 'Kiti cha ofisi', productType: 'chair', concept: 'chair', category: 'furniture', price: 90000 },
    { name: 'Meza ya kahawa', productType: 'table', concept: null, category: 'furniture', price: null },
  ] };
  else if (body.messages[0].content.includes('shopping requests')) content = { productType: 'sofa', essentialAttributes: { seats: 3 }, maxBudget: 350000, locationText: 'Sinza', fulfilment: 'delivery', intent: 'shop', language: 'sw' };
  else if (body.messages[0].content.includes('short WhatsApp replies')) content = { reply: 'Nimepata chaguo: 1. Sofa ya watu watatu - Duka la Picha. Jibu namba ya chaguo.' };
  else content = { reply: 'ok' };
  return json({ model: body.model, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
}

const send = (event) => { const raw = JSON.stringify(event); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return realFetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json() })); };
const api = (path, { method = 'GET', body, token, raw, type } = {}) => realFetch(`${base}${path}`, { method, headers: { 'Content-Type': type || 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  await resetDatabase();
  moran = new FakeMoranInternalClient();
  muse = new MuseClient({ cfg: loadConfig({ ...process.env, MUSE_PROVIDER: 'meta', MUSE_API_KEY: 'test-key' }), db, fetchImpl: metaFetch });
  setShoppingDepsForTests({ engine: new ShoppingEngine({ db, muse, geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23, label: 'Sinza, Dar es Salaam' } }) }), moran, muse });
  server = createApp({ routers }).listen(0); base = `http://127.0.0.1:${server.address().port}`;
  shop = (await makeMerchant({ name: 'Duka la Picha', lat: -6.78, lng: 39.235, deliveryAvailable: true, deliveryFee: 10000, radiusKm: 30 })).merchant;
  await db('merchants').where({ id: shop.id }).update({ contact_phone: '255712000333' });
  await makeListing(shop.id, { name: 'Sofa ya watu watatu', price: 320000, attributes: { seats: 3 } });
  await db('merchant_users').insert({ merchant_id: shop.id, email: 'picha@example.com', name: 'O', password_hash: await hashPassword('password123') });
  for (const p of ['255700000501', '255712000333']) await acceptedCustomer(p);
  const [root] = await db('admin_users').insert({ email: 'root@moranbuy.test', name: 'Root', password_hash: await hashPassword('x'.repeat(12)), role: 'super_admin' }).returning('*');
  rootTok = signAccessToken({ type: 'admin', sub: root.id, role: 'super_admin', email: root.email });
  // Spoken replies come from Meta's MMS voices; the model files are only marked present and this stand-in answers with a real Ogg Opus note.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-'));
  for (const code of ['swh', 'eng']) { fs.mkdirSync(path.join(dir, code)); fs.writeFileSync(path.join(dir, code, 'model.onnx'), ''); fs.writeFileSync(path.join(dir, code, 'tokenizer.json'), '{}'); }
  process.env.TTS_MODEL_DIR = dir;
  setSynthesizerForTests(async ({ text, language }) => { calls.push({ kind: 'tts', text, language }); return { ok: true, audio: TONE, voice: 'facebook/mms-tts-swh' }; });
});
after(async () => { setSynthesizerForTests(null); delete process.env.TTS_MODEL_DIR; server.close(); await closeDatabase(); });

test('a WhatsApp voice note (Ogg Opus) and a browser WAV are decoded in-process to 16 kHz mono WAV; other bytes are refused', async () => {
  const ogg = await toSpeechWav(TONE);
  assert.equal(ogg.ok, true);
  assert.equal(ogg.from, 'ogg');
  assert.ok(Math.abs(ogg.seconds - 1.2) < 0.15, String(ogg.seconds));
  assert.equal(ogg.wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(ogg.wav.readUInt32LE(24), 16000);
  assert.equal(ogg.wav.readUInt16LE(22), 1);
  // A 44.1 kHz stereo WAV is mixed down and resampled.
  const stereo = encodeWav(new Float32Array(44100).fill(0.2), 44100);
  stereo.writeUInt16LE(2, 22); stereo.writeUInt16LE(4, 32); stereo.writeUInt32LE(44100 * 4, 28);
  const w = await toSpeechWav(stereo);
  assert.equal(w.ok, true);
  assert.equal(w.wav.readUInt32LE(24), 16000);
  assert.deepEqual(await toSpeechWav(Buffer.from('not audio at all, really')), { ok: false, reason: 'unsupported_audio' });
});

test('Muse Spark 1.2 hears the voice note; when it fails, Muse Voice Transcribe is asked with a WAV', async () => {
  const { wav } = await toSpeechWav(TONE);
  calls = [];
  let r = await museTranscribeVoice(muse, { wav });
  assert.deepEqual([r.ok, r.source, r.transcript], [true, 'muse_spark', SPOKEN]);
  const sent = calls.find((c) => c.kind === 'spark_audio').body;
  assert.equal(sent.model, 'muse-spark-1.2');
  assert.ok(sent.max_tokens >= 4000);
  const part = sent.messages.at(-1).content.find((p) => p.type === 'input_audio');
  assert.equal(part.input_audio.format, 'wav');
  assert.equal(Buffer.from(part.input_audio.data, 'base64').subarray(0, 4).toString(), 'RIFF');
  sparkDown = true; calls = [];
  r = await museTranscribeVoice(muse, { wav });
  sparkDown = false;
  assert.deepEqual([r.ok, r.source], [true, 'muse_voice_transcribe']);
  const asr = calls.find((c) => c.kind === 'asr');
  assert.deepEqual(asr.request, { model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' });
  assert.equal(asr.audio.subarray(0, 4).toString(), 'RIFF');
  assert.ok(await db('muse_requests').where({ feature: 'voice_transcribe', status: 'ok' }).first());
});

test('a customer voice note on WhatsApp is heard by Muse, shopped from, kept privately with its transcript, and answered in voice too', async () => {
  const set = await api('/api/admin/credentials/tts', { method: 'PUT', token: rootTok, body: { provider: 'meta_mms', mode: 'mirror', reason: 'Spoken replies for the demo' } });
  assert.equal(set.status, 200);
  assert.deepEqual([set.body.credentials.tts.provider, set.body.credentials.tts.enabled, set.body.credentials.tts.voices.sw], ['meta_mms', true, 'facebook/mms-tts-swh']);
  calls = [];
  const r = await send({ messageId: 'wv1', from: '255700000501', kind: 'audio', media: { base64: TONE.toString('base64'), mime: 'audio/ogg; codecs=opus' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.heard, { ok: true, source: 'muse_spark', reason: null });
  assert.equal(r.body.state, 'presented');
  const textReply = moran.sent.filter((m) => m.to === '255700000501' && m.type === 'text').at(-1);
  assert.match(textReply.body, /Sofa ya watu watatu/);
  const note = await db('uploads').where({ purpose: 'voice_note' }).first();
  assert.equal(note.transcript, SPOKEN);
  assert.equal(note.duration_ms, 1200);
  const sig = await db('demand_signals').where({ source_kind: 'voice' }).first();
  assert.equal(sig.product_type, 'sofa');
  // The spoken reply: Meta's Swahili MMS voice says the written reply, sent back through Moran as audio after Moran had its answer.
  await settleVoiceJobs();
  const tts = calls.find((c) => c.kind === 'tts');
  assert.equal(tts.language, 'sw');
  assert.match(tts.text, /Sofa ya watu watatu - Duka la Picha/);
  const audio = moran.sent.find((m) => m.type === 'audio');
  assert.equal(Buffer.from(audio.audioBase64, 'base64').subarray(0, 4).toString(), 'OggS');
  assert.equal(audio.idempotencyKey, 'moranbuy:wv1:voice');
  assert.ok(await db('uploads').where({ purpose: 'voice_reply' }).first());
});

test('a voice note from someone who has not accepted the terms is neither opened nor stored', async () => {
  const before = Number((await db('uploads').count('id as n').first()).n);
  const r = await send({ messageId: 'wv2', from: '255799000111', kind: 'audio', media: { base64: TONE.toString('base64') } });
  assert.equal(r.body.state, 'terms_prompted');
  assert.equal(Number((await db('uploads').count('id as n').first()).n), before);
});

test('a web customer records a WAV in the browser, sees what was heard, gets offers and a voice reply to play', async () => {
  const t = (await api('/api/shop/messages', { method: 'POST', body: { text: '' } })).body.customerToken;
  await api('/api/shop/messages', { method: 'POST', body: { customerToken: t, acceptTerms: true } });
  const { wav } = await toSpeechWav(TONE);
  const up = await api(`/api/shop/uploads?kind=voice&customerToken=${t}`, { method: 'POST', raw: wav, type: 'audio/wav' });
  assert.equal(up.status, 201);
  assert.equal(up.body.heard, true);
  assert.equal(up.body.transcript, SPOKEN);
  const msg = await api('/api/shop/messages', { method: 'POST', body: { customerToken: t, voiceUploadId: up.body.uploadId } });
  assert.equal(msg.status, 200);
  assert.equal(msg.body.state, 'presented');
  assert.equal(msg.body.heard, SPOKEN);
  assert.match(msg.body.voiceReply.dataUrl, /^data:audio\/ogg;base64,T2dnUw/);
  // Typed messages get no voice in mirror mode.
  const typed = await api('/api/shop/messages', { method: 'POST', body: { customerToken: t, text: 'sofa ya watu watatu laki nne nipo Sinza' } });
  assert.equal(typed.body.voiceReply, null);
});

test('a business photographs several products: Muse lists them, SAM 3.1 finds each, and each cut-out becomes that listing\'s photo', async () => {
  // A 200 x 100 photo: a grey sofa on the left half, a black chair on the right half.
  const px = Buffer.alloc(200 * 100 * 4);
  for (let y = 0; y < 100; y += 1) for (let x = 0; x < 200; x += 1) { const i = (y * 200 + x) * 4; const v = x < 100 ? 150 : 20; px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255; }
  const photo = Buffer.from(jpeg.encode({ width: 200, height: 100, data: px }, 90).data);
  calls = [];
  const r = await send({ messageId: 'mp1', from: '255712000333', kind: 'image', text: 'Bidhaa mpya', media: { base64: photo.toString('base64'), mime: 'image/jpeg' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'merchant_products_created');
  const reply = moran.sent.filter((m) => m.to === '255712000333').at(-1).body;
  assert.match(reply, /Nimeorodhesha kutoka kwenye picha \(2, picha 2 zimekatwa kwa kila bidhaa\)/);
  assert.match(reply, /Hazina bei: Meza ya kahawa/);
  // SAM was asked once per pictured concept, with the private photo as data and the documented request shape.
  const sams = calls.filter((c) => c.kind === 'sam');
  assert.deepEqual(sams.map((c) => c.body.input[0].content[0].text).sort(), ['chair', 'sofa']);
  assert.equal(sams[0].body.model, 'sam-3.1');
  assert.match(sams[0].body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  const sofa = await db('listings').where({ merchant_id: shop.id, name: 'Sofa ya kijivu' }).first();
  const chair = await db('listings').where({ merchant_id: shop.id, name: 'Kiti cha ofisi' }).first();
  assert.equal(sofa.price, 450000);
  assert.equal(chair.price, 90000);
  assert.match(sofa.image_url, /\/media\/[0-9a-f-]{36}\.jpg$/);
  // Each cut-out is the right half of the photo, slightly widened, and served publicly.
  const sofaPic = Buffer.from(await (await realFetch(`${base}/media/${sofa.image_url.split('/media/')[1]}`)).arrayBuffer());
  const chairPic = Buffer.from(await (await realFetch(`${base}/media/${chair.image_url.split('/media/')[1]}`)).arrayBuffer());
  const s = jpeg.decode(sofaPic); const c = jpeg.decode(chairPic);
  assert.ok(s.width >= 100 && s.width <= 112 && s.height === 100, `${s.width}x${s.height}`);
  assert.ok(s.data[(50 * s.width + 20) * 4] > 120, 'the sofa crop is the light half');
  assert.ok(c.data[(50 * c.width + c.width - 20) * 4] < 60, 'the chair crop is the dark half');
  assert.equal(Number((await db('catalog_uploads').where({ merchant_id: shop.id, status: 'created' }).count('id as n').first()).n), 2);
  assert.ok(await db('catalog_uploads').where({ merchant_id: shop.id, status: 'rejected', reason: 'no_price' }).first());
});

test('SAM box records are read with their confidence; spoken text is cleaned for a voice note; voice is used only when it should be', () => {
  assert.deepEqual(parseSamBoxes('<0f>0<|box;x1=181;y1=365;x2=556;y2=486;w=1516;h=1600;c=0.91|><|mask;x=0;y=0;data=1,~|><0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10|>'), [
    { x1: 181, y1: 365, x2: 556, y2: 486, width: 1516, height: 1600, confidence: 0.91 }, { x1: 1, y1: 2, x2: 3, y2: 4, width: 10, height: 10, confidence: null }]);
  assert.deepEqual(parseSamBoxes(''), []);
  assert.equal(spokenText('1. Sofa - TSh 305,000.\n2. Kiti https://x.y/z'), '1. Sofa - shilingi 305,000. 2. Kiti');
  assert.equal(shouldSpeak('mirror', { inboundKind: 'voice', state: 'presented' }), true);
  assert.equal(shouldSpeak('mirror', { inboundKind: 'text', state: 'presented' }), false);
  assert.equal(shouldSpeak('always', { inboundKind: 'text', state: 'presented' }), true);
  assert.equal(shouldSpeak('always', { inboundKind: 'text', state: 'terms_prompted' }), false);
  assert.equal(shouldSpeak('off', { inboundKind: 'voice', state: 'presented' }), false);
});
