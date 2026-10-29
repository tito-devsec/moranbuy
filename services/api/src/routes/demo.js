import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import jpeg from 'jpeg-js';
import { ApiError, config } from '@moranbuy/core';
import { signBody } from '@moranbuy/integrations';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { demoMoran } from '../demo/stand-ins.js';
import { seedDemoShops, DEMO_SHOPS } from '../demo/seed.js';
import { traceSince, mask } from '../demo/trace.js';
import { loadTerms } from '../services/terms.js';
import { museRuntimeConfig } from '../services/runtime-settings.js';
import { latestReceipt } from '../services/protection/receipts-store.js';
import { synthesizeMms, mmsAvailable } from '../services/speech/mms.js';
import { receiptCheckPage } from './health.js';

// The public demo sandbox: a judge drives a customer, a shop owner and a rider through MoranBuy's real code against the demo database.
export const demoRouter = express.Router();
demoRouter.use(rateLimit({ windowMs: 60000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false }));

const SESSION_TTL_MS = 45 * 60000;
const MAX_ACTIONS = 160;
const sessions = new Map();
let seeded = null;
let queue = Promise.resolve();

const onlyInDemo = (_req, _res, next) => (config().DEMO_MODE ? next() : next(new ApiError(404, 'NOT_FOUND', 'The demo runs on its own sandbox server.')));
demoRouter.use(onlyInDemo);

// Reserved demo numbers in the unused 0700 range (2557008xxxxx customers, 2557007xxxxx riders, 25570099xxxx shops), never real people.
const randomPhone = (prefix) => `${prefix}${String(crypto.randomInt(0, 1e5)).padStart(5, '0')}`;

async function ensureSeeded() {
  seeded ||= (async () => {
    await seedDemoShops();
    const t = await loadTerms();
    for (const s of DEMO_SHOPS) await db('customers').insert({ channel: 'whatsapp', channel_ref: s.phone, language: 'sw', terms_status: 'accepted', terms_version: t.version, terms_accepted_at: db.fn.now() }).onConflict(['channel', 'channel_ref']).merge({ terms_status: 'accepted', terms_version: t.version });
  })().catch((err) => { seeded = null; throw err; });
  return seeded;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s || Date.now() - s.lastAt > SESSION_TTL_MS) { sessions.delete(id); throw new ApiError(404, 'SESSION_EXPIRED', 'This demo session has ended. Start a new one.'); }
  if (s.actions >= MAX_ACTIONS) throw new ApiError(429, 'SESSION_FULL', 'This demo session reached its limit. Start a new one.');
  return s;
}

// Every action runs alone, so the terminal lines that follow it belong to it.
const serial = (fn) => { const job = queue.then(fn, fn); queue = job.catch(() => {}); return job; };

async function sessionOrder(s) {
  if (!s.customerId) return null;
  return db('orders').where({ customer_id: s.customerId }).orderBy('created_at', 'desc').first();
}

// The shop owner in the demo is whichever sample shop the customer ordered from.
async function ownerPhone(s) {
  const o = await sessionOrder(s);
  if (!o) return null;
  return (await db('merchants').where({ id: o.merchant_id }).first('contact_phone'))?.contact_phone || null;
}

const publicMessage = (m) => ({ seq: m.seq, at: m.at, type: m.type, body: m.body || m.caption || null, buttons: m.buttons || null, footer: m.footer || null, button: m.button || null, sections: m.sections || null, filename: m.filename || null, audio: !!m.audioBase64, templateName: m.templateName || null, components: m.type === 'template' ? m.components : undefined });

async function view(s) {
  const owner = await ownerPhone(s);
  const refs = s.customerId ? (await db('orders').where({ customer_id: s.customerId }).pluck('order_ref')) : [];
  const log = demoMoran().since([s.customerPhone, s.riderPhone, ...(owner ? [owner] : [])], 0);
  const forOwner = (m) => m.to === owner && refs.some((r) => JSON.stringify(m).includes(r));
  return {
    customer: log.filter((m) => m.to === s.customerPhone).map(publicMessage),
    owner: log.filter(forOwner).map(publicMessage),
    rider: log.filter((m) => m.to === s.riderPhone && refs.some((r) => JSON.stringify(m).includes(r)) || (m.to === s.riderPhone && m.type === 'text')).map(publicMessage),
    ownerShop: owner ? DEMO_SHOPS.find((x) => x.phone === owner)?.name || null : null,
    order: refs.length ? await orderSummary(s) : null,
  };
}

async function orderSummary(s) {
  const o = await sessionOrder(s);
  if (!o) return null;
  const p = await db('order_protection').where({ order_id: o.id }).first('state', 'code_attempts', 'release_due_at');
  const pay = await db('payments').where({ purpose: 'order', target_id: o.id }).orderBy('created_at', 'desc').first('reference', 'status', 'amount');
  return { ref: o.order_ref, status: o.status, total: o.known_total, protection: p?.state || null, payment: pay ? { status: pay.status, amount: pay.amount } : null, receipt: !!(await db('receipts').where({ order_id: o.id }).first('number')) };
}

// Sends one message into MoranBuy exactly as Moran would: a signed POST to /internal/inbound on this same server.
async function inbound(req, s, from, event) {
  const raw = JSON.stringify({ messageId: `demo-${crypto.randomUUID()}`, from, ...event });
  const sig = signBody(config().MORAN_SHARED_SECRET, raw);
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${req.socket.localPort}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': sig.timestamp, 'X-MoranBuy-Signature': sig.signature }, body: raw });
  const body = await res.json().catch(() => ({}));
  const { settleVoiceJobs } = await import('./internal-inbound.js');
  await settleVoiceJobs();
  if (!s.customerId && from === s.customerPhone) s.customerId = (await db('customers').where({ channel: 'whatsapp', channel_ref: s.customerPhone }).first('id'))?.id || null;
  return { at: new Date(started).toISOString(), level: res.ok ? 'INFO' : 'WARN', svc: 'inbound', msg: `POST /internal/inbound ${res.status} ${Date.now() - started}ms from=${mask(from)} kind=${event.kind || 'text'}${event.buttonId ? ` button=${event.buttonId}` : ''} sig=hmac-sha256 ok state=${body.state || '-'}` };
}

async function act(req, s, fn) {
  return serial(async () => {
    s.actions += 1; s.lastAt = Date.now();
    const since = new Date(Date.now() - 5);
    const before = demoMoran().log.at(-1)?.seq || 0;
    const request = await fn();
    const owner = await ownerPhone(s);
    const sent = demoMoran().since([s.customerPhone, s.riderPhone, ...(owner ? [owner] : [])], before);
    const lines = await traceSince({ session: s, since, moranLog: sent, request: [].concat(request || []) });
    s.lines.push(...lines); if (s.lines.length > 800) s.lines.splice(0, s.lines.length - 800);
    return { lines, ...(await view(s)) };
  });
}

const phoneFor = (s, role, owner) => (role === 'customer' ? s.customerPhone : role === 'rider' ? s.riderPhone : owner);

demoRouter.post('/session', asyncHandler(async (_req, res) => {
  await ensureSeeded();
  if (sessions.size > 300) { const oldest = [...sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0]; sessions.delete(oldest.id); }
  const s = { id: crypto.randomUUID(), customerPhone: randomPhone('2557008'), riderPhone: randomPhone('2557007'), customerId: null, lastEventId: 0, actions: 0, lastAt: Date.now(), lines: [] };
  sessions.set(s.id, s);
  const muse = await museRuntimeConfig();
  const t = new Date().toISOString();
  s.lines.push({ at: t, level: 'INFO', svc: 'sandbox', msg: `session ${s.id.slice(0, 8)} customer=${mask(s.customerPhone)} rider=${mask(s.riderPhone)} db=moranbuy_demo whatsapp=recording payments=sandbox` },
    { at: t, level: 'INFO', svc: 'sandbox', msg: `meta model api: ${muse.apiKey ? `live model=${muse.model}` : 'no key -> rules fallback (parse, rank and protection rules are the same code)'}` },
    { at: t, level: 'INFO', svc: 'sandbox', msg: `catalogue: ${DEMO_SHOPS.length} sample shops, ${DEMO_SHOPS.reduce((n, x) => n + x.items.length, 0)} products around Dar es Salaam` });
  res.status(201).json({ sessionId: s.id, customer: mask(s.customerPhone), rider: mask(s.riderPhone), riderNumber: `0${s.riderPhone.slice(3)}`, museLive: !!muse.apiKey, voice: mmsAvailable('sw'), lines: s.lines, shops: DEMO_SHOPS.map((x) => ({ name: x.name, area: x.area })) });
}));

const sendBody = z.object({ role: z.enum(['customer', 'owner', 'rider']), text: z.string().max(500).optional(), buttonId: z.string().max(120).optional(), buttonTitle: z.string().max(40).optional() }).refine((b) => b.text || b.buttonId, 'text or buttonId');

demoRouter.post('/session/:id/send', validate({ body: sendBody }), asyncHandler(async (req, res) => {
  const s = getSession(req.params.id);
  const owner = await ownerPhone(s);
  const from = phoneFor(s, req.body.role, owner);
  if (!from) throw new ApiError(409, 'NO_ORDER_YET', 'The shop owner appears once the customer has placed an order.');
  res.json(await act(req, s, () => inbound(req, s, from, req.body.buttonId ? { buttonId: req.body.buttonId, text: req.body.buttonTitle || '', kind: 'button' } : { text: req.body.text, kind: 'text' })));
}));

// A photo: the judge's own JPEG or PNG (base64), or a generated sample picture.
function samplePhoto() {
  const w = 480; const h = 360; const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4; const inJar = x > 180 && x < 300 && y > 60 && y < 250; const base = y > 250 && y < 310 && x > 160 && x < 320;
    const v = inJar ? [200, 225, 235] : base ? [30, 34, 40] : [236, 232, 226];
    px[i] = v[0]; px[i + 1] = v[1]; px[i + 2] = v[2]; px[i + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ width: w, height: h, data: px }, 88).data);
}

demoRouter.post('/session/:id/photo', express.json({ limit: '6mb' }), validate({ body: z.object({ role: z.enum(['customer', 'rider', 'owner']), base64: z.string().max(7_000_000).optional(), caption: z.string().max(200).optional() }) }), asyncHandler(async (req, res) => {
  const s = getSession(req.params.id);
  const owner = await ownerPhone(s);
  const from = phoneFor(s, req.body.role, owner);
  if (!from) throw new ApiError(409, 'NO_ORDER_YET', 'The shop owner appears once the customer has placed an order.');
  const buf = req.body.base64 ? Buffer.from(req.body.base64, 'base64') : samplePhoto();
  res.json(await act(req, s, () => inbound(req, s, from, { kind: 'image', text: req.body.caption || '', media: { base64: buf.toString('base64'), mime: 'image/jpeg' } })));
}));

// A spoken request in Swahili, made by Meta's MMS voice so it is a real Ogg Opus voice note, then heard by Muse like any other.
let sampleVoice = null;
demoRouter.post('/session/:id/voice', validate({ body: z.object({ text: z.string().max(200).default('Habari MoranBuy. Nina elfu tisini, nataka blenda. Nipo Sinza Mori, niletewe nyumbani.') }) }), asyncHandler(async (req, res) => {
  const s = getSession(req.params.id);
  if (!mmsAvailable('sw')) throw new ApiError(409, 'VOICE_UNAVAILABLE', 'Voice is not installed on this sandbox.');
  res.json(await act(req, s, async () => {
    const started = new Date().toISOString();
    const v = req.body.text === sampleVoice?.text ? sampleVoice : { text: req.body.text, ...(await synthesizeMms({ text: req.body.text, language: 'sw' })) };
    if (!v.ok) throw new ApiError(503, 'VOICE_FAILED', 'The sample voice note could not be made.');
    sampleVoice = v;
    return [{ at: started, level: 'INFO', svc: 'sandbox', msg: `voice note recorded ${v.seconds.toFixed(1)}s ogg/opus ${Math.round(v.audio.length / 1024)}KB (made with facebook/mms-tts-swh)` }, await inbound(req, s, s.customerPhone, { kind: 'audio', media: { base64: v.audio.toString('base64'), mime: 'audio/ogg; codecs=opus' } })];
  }));
}));

// The customer approves the mobile-money prompt: the sandbox provider settles through the same route Snippe's webhook takes.
demoRouter.post('/session/:id/pay', asyncHandler(async (req, res) => {
  const s = getSession(req.params.id);
  const o = await sessionOrder(s);
  const pay = o ? await db('payments').where({ purpose: 'order', target_id: o.id, status: 'pending' }).orderBy('created_at', 'desc').first() : null;
  if (!pay) throw new ApiError(409, 'NOTHING_TO_PAY', 'There is no payment waiting. The shop must accept the order first.');
  res.json(await act(req, s, async () => {
    const started = Date.now();
    const r = await fetch(`http://127.0.0.1:${req.socket.localPort}/api/sandbox/payments/${encodeURIComponent(pay.reference)}/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', amount: pay.amount }) });
    return { at: new Date(started).toISOString(), level: r.ok ? 'INFO' : 'WARN', svc: 'sandbox', msg: `mobile money prompt approved on ${mask(s.customerPhone)} -> POST /api/sandbox/payments/${pay.reference}/settle ${r.status} ${Date.now() - started}ms` };
  }));
}));

demoRouter.get('/session/:id/state', asyncHandler(async (req, res) => {
  const s = getSession(req.params.id);
  res.json({ lines: s.lines, ...(await view(s)) });
}));

demoRouter.get('/session/:id/receipt', asyncHandler(async (req, res) => {
  const s = getSession(req.params.id);
  const o = await sessionOrder(s);
  const r = o ? await latestReceipt(db, o.id) : null;
  if (!r?.pdf) throw new ApiError(404, 'NO_RECEIPT', 'No receipt yet: it is issued once the payment is held.');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="MoranBuy-${r.receiptNo}-v${r.version}.pdf"`, 'Cache-Control': 'no-store' }).send(r.pdf);
}));

demoRouter.get('/session/:id/audio/:seq', asyncHandler(async (req, res) => {
  const s = getSession(req.params.id);
  const m = demoMoran().log.find((x) => x.seq === Number(req.params.seq) && x.audioBase64 && [s.customerPhone, s.riderPhone].includes(x.to));
  if (!m) throw new ApiError(404, 'NOT_FOUND', 'No such voice note.');
  res.set({ 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store' }).send(Buffer.from(m.audioBase64, 'base64'));
}));

// The order's receipt check page, as the QR code would open it.
demoRouter.get('/session/:id/verify', asyncHandler(async (req, res) => {
  const s = getSession(req.params.id);
  const o = await sessionOrder(s);
  const first = o ? await db('receipts').where({ order_id: o.id }).orderBy('version').first() : null;
  const last = o ? await db('receipts').where({ order_id: o.id }).orderBy('version', 'desc').first() : null;
  if (!first) throw new ApiError(404, 'NO_RECEIPT', 'No receipt yet.');
  res.json({ path: `/api/demo/r/MB-R-${String(first.number).padStart(6, '0')}?c=${last.check_code.replace('-', '')}` });
}));

demoRouter.get('/r/:no', receiptCheckPage);

// Old demo orders are removed after a day, so the sandbox never grows.
export async function cleanDemoData({ olderThanHours = 24 } = {}) {
  const before = new Date(Date.now() - olderThanHours * 3600000);
  const customers = await db('customers').where('channel_ref', 'like', '2557008%').where('created_at', '<', before).pluck('id');
  if (!customers.length) return 0;
  const orders = await db('orders').whereIn('customer_id', customers).pluck('id');
  const { deleteUpload } = await import('../services/uploads.js');
  for (const u of await db('uploads').whereIn('id', db('receipts').whereIn('order_id', orders).whereNotNull('upload_id').select('upload_id')).orWhereIn('id', db('delivery_events').whereIn('order_id', orders).whereNotNull('upload_id').select('upload_id')).orWhereIn('customer_id', customers)) await deleteUpload(db, u).catch(() => {});
  await db('payments').where({ purpose: 'order' }).whereIn('target_id', orders).del();
  await db('strikes').whereIn('order_id', orders).del();
  await db('orders').whereIn('id', orders).del();
  await db('enquiries').whereIn('customer_id', customers).del();
  await db('customers').whereIn('id', customers).del();
  return customers.length;
}
