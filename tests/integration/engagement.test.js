import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, closeDatabase, db } from '../helpers/db.js';
import { makeMerchant, makeListing, acceptedCustomer } from '../helpers/fixtures.js';
import { createApp } from '../../services/api/src/app.js';
import { routers } from '../../services/api/src/routers.js';
import { setEngagementDepsForTests } from '../../services/api/src/services/engagement.js';
import { setMerchantDepsForTests } from '../../services/api/src/services/merchants.js';
import { setShoppingDepsForTests } from '../../services/api/src/services/shopping.js';
import { MuseClient } from '@moranbuy/muse-intelligence';
import { FakeGeocoder, FakeMoranInternalClient, MoranOwnerClient, signBody } from '@moranbuy/integrations';
import { SandboxPaymentProvider } from '@moranbuy/billing';
import { DryRunSender, MoranMerchantSender, processCampaignQueue } from '@moranbuy/campaign-engine';
import { processDueFollowups, createLead } from '@moranbuy/followup-engine';
import { recordConsent, upsertContact } from '@moranbuy/consent-management';
import { hashPassword, signAccessToken, activateEntitlement } from '@moranbuy/authorization';
import { ShoppingEngine } from '@moranbuy/reverse-marketplace';
import { loadConfig } from '@moranbuy/core';

let server; let base; let moranInternal; let sender;
const api = (path, { method = 'GET', body, token } = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function merchantToken(merchant) {
  const [u] = await db('merchant_users').insert({ merchant_id: merchant.id, email: `${merchant.slug}@example.com`, name: 'Owner', password_hash: await hashPassword('password123') }).returning('*');
  return { token: signAccessToken({ type: 'merchant', sub: u.id, merchantId: merchant.id, role: 'owner', email: u.email }), user: u };
}

let moranM; let standM; let moranTok; let standTok; let listing; let template;

before(async () => {
  await resetDatabase();
  moranInternal = new FakeMoranInternalClient();
  sender = new MoranMerchantSender(moranInternal);
  const cfg = loadConfig({ ...process.env, MUSE_PROVIDER: 'disabled' });
  setEngagementDepsForTests({ muse: new MuseClient({ cfg, db }), payments: new SandboxPaymentProvider(), moran: moranInternal, sender, dryRun: false, followupDryRun: false });
  setMerchantDepsForTests({ moran: new MoranOwnerClient({ cfg: loadConfig({ ...process.env, MORAN_BACKEND_BASE_URL: '' }) }), geocoder: new FakeGeocoder() });
  setShoppingDepsForTests({ engine: new ShoppingEngine({ db, muse: new MuseClient({ cfg, db }), geocoder: new FakeGeocoder({ sinza: { lat: -6.776, lng: 39.23 } }) }), moran: moranInternal });
  for (const p of ["255711000004", "255711000005", "255711000008"]) await acceptedCustomer(p);
  server = createApp({ routers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  moranM = (await makeMerchant({ name: 'Samaki Furniture', lat: -6.72, lng: 39.17, deliveryAvailable: true, deliveryFee: 5000, radiusKm: 30, registrationType: 'moran', moranTenantId: 'tenant-1' })).merchant;
  await db('merchants').where({ id: moranM.id }).update({ verification_json: JSON.stringify({ waConnection: 'connected' }) });
  moranM = await db('merchants').where({ id: moranM.id }).first();
  standM = (await makeMerchant({ name: 'Duka la Juma', lat: -6.78, lng: 39.23 })).merchant;
  moranTok = (await merchantToken(moranM)).token;
  standTok = (await merchantToken(standM)).token;
  listing = await makeListing(moranM.id, { name: 'Sofa L-shape', price: 450000, attributes: { seats: 4 } });
  await db('platform_settings').insert({ key: 'campaign_pricing', value: JSON.stringify({ providerUnitTzs: 60 }) });
});
after(async () => { server.close(); await closeDatabase(); });

test('the campaign engine is refused until the entitlement is active and paid', async () => {
  const r = await api('/api/merchant/campaigns', { method: 'POST', token: moranTok, body: { name: 'Ofa ya sofa', listingId: listing.id } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'SERVICE_NOT_ACTIVE');
  await db('merchant_entitlements').insert([{ merchant_id: moranM.id, service: 'campaign_engine', status: 'pending_payment', billing_state: 'unpaid' }, { merchant_id: standM.id, service: 'campaign_engine', status: 'pending_payment', billing_state: 'unpaid' }]);
  assert.equal((await api('/api/merchant/campaigns', { method: 'POST', token: moranTok, body: { name: 'Ofa ya sofa' } })).status, 403);
  await activateEntitlement(db, moranM.id, 'campaign_engine', { actor: 'admin:test' });
  await activateEntitlement(db, standM.id, 'campaign_engine', { actor: 'admin:test' });
});

test('templates are validated locally and a standalone merchant is told submission needs a connected sender', async () => {
  const bad = await api('/api/merchant/campaigns/templates', { method: 'POST', token: standTok, body: { name: 'ofa_mpya', body: 'Ofa mpya kutoka kwetu', headerFormat: 'IMAGE' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.headerMediaUrl);
  const ok = await api('/api/merchant/campaigns/templates', { method: 'POST', token: standTok, body: { name: 'ofa_mpya', body: 'Ofa mpya kutoka kwetu. Jibu STOP kuacha.' } });
  assert.equal(ok.status, 201);
  const sub = await api(`/api/merchant/campaigns/templates/${ok.body.template.id}/submit`, { method: 'POST', token: standTok });
  assert.equal(sub.status, 409);
  assert.equal(sub.body.error, 'TEMPLATE_SUBMISSION_UNAVAILABLE');
  assert.equal((await api('/api/merchant/campaigns/sender', { token: standTok })).body.reason, 'no_connected_sender');
  // The linked merchant's template is approved here only because the test plays Meta's answer; the app never sets this itself.
  const mine = await api('/api/merchant/campaigns/templates', { method: 'POST', token: moranTok, body: { name: 'sofa_offer', headerFormat: 'IMAGE', headerMediaUrl: 'https://example.com/sofa.jpg', body: 'Sofa L-shape kwa TSh 450,000. Jibu STOP kuacha.' } });
  template = mine.body.template;
  await db('message_templates').where({ id: template.id }).update({ status: 'approved', provider: 'moran', provider_template_id: 'meta-1' });
});

test('a campaign goes draft, review, approval, audience with exclusion reasons, price, server-verified payment, gates, explicit confirmation, queue', async () => {
  await upsertContact(db, { merchantId: moranM.id, phone: '255711000001', name: 'A', source: 'order' });
  await recordConsent(db, { merchantId: moranM.id, phone: '255711000001', purpose: 'marketing', status: 'granted', source: 'web_form' });
  await upsertContact(db, { merchantId: moranM.id, phone: '255711000002', name: 'B', source: 'enquiry' });
  await upsertContact(db, { merchantId: moranM.id, phone: '255711000003', name: 'C', source: 'order' });
  await recordConsent(db, { merchantId: moranM.id, phone: '255711000003', purpose: 'marketing', status: 'granted', source: 'web_form' });
  await recordConsent(db, { merchantId: null, phone: '255711000003', purpose: 'all', status: 'revoked', source: 'inbound_keyword' });
  await upsertContact(db, { merchantId: standM.id, phone: '255711000009', name: 'Z', source: 'order' });
  await recordConsent(db, { merchantId: standM.id, phone: '255711000009', purpose: 'marketing', status: 'granted', source: 'web_form' });

  const created = await api('/api/merchant/campaigns', { method: 'POST', token: moranTok, body: { name: 'Ofa ya sofa', objective: 'Sell the L-shape sofa this week', listingId: listing.id, templateId: template.id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  const other = await api('/api/merchant/campaigns', { method: 'POST', token: standTok, body: { name: 'Steal', listingId: listing.id } });
  assert.equal(other.status, 400);

  const draft = await api(`/api/merchant/campaigns/${id}/draft`, { method: 'POST', token: moranTok, body: {} });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal(draft.body.draftSource, 'fallback_disabled');
  assert.match(draft.body.campaign.draftBody, /Sofa L-shape kwa TSh 450,000/);
  const edited = await api(`/api/merchant/campaigns/${id}`, { method: 'PATCH', token: moranTok, body: { draftBody: 'Sofa L-shape kwa TSh 450,000 wiki hii. Jibu STOP kuacha.', mediaUrl: 'https://example.com/sofa.jpg' } });
  assert.equal(edited.body.campaign.draftHistory.length, 2);

  assert.equal((await api(`/api/merchant/campaigns/${id}/confirm`, { method: 'POST', token: moranTok, body: { confirm: true } })).status, 409);
  assert.equal((await api(`/api/merchant/campaigns/${id}/approve`, { method: 'POST', token: moranTok })).body.campaign.status, 'approved');
  const priced = await api(`/api/merchant/campaigns/${id}/price`, { method: 'POST', token: moranTok });
  assert.equal(priced.body.audience.counts.included, 1);
  assert.deepEqual(priced.body.audience.exclusionReasons, { no_consent: 1, opted_out: 1 });
  assert.equal(priced.body.pricing.estimatedTotal, 60 + 2000 + 360);

  const notPaid = await api(`/api/merchant/campaigns/${id}/readiness`, { method: 'POST', token: moranTok });
  assert.equal(notPaid.body.ready, false);
  assert.equal(notPaid.body.gates.payment.ok, false);
  const pay = await api(`/api/merchant/campaigns/${id}/pay`, { method: 'POST', token: moranTok, body: { phone: '0712000000' } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.payment.status, 'pending');
  assert.equal((await api(`/api/merchant/campaigns/${id}/confirm`, { method: 'POST', token: moranTok, body: { confirm: true } })).status, 409);
  const short = await api(`/api/sandbox/payments/${pay.body.payment.reference}/settle`, { method: 'POST', body: { status: 'completed', amount: 100 } });
  assert.equal(short.body.payment.status, 'failed');
  await db('payments').where({ reference: pay.body.payment.reference }).update({ status: 'pending' });
  const settled = await api(`/api/sandbox/payments/${pay.body.payment.reference}/settle`, { method: 'POST', body: { status: 'completed', attempt: 2 } });
  assert.equal(settled.body.payment.status, 'completed');
  assert.equal((await api(`/api/sandbox/payments/${pay.body.payment.reference}/settle`, { method: 'POST', body: { status: 'completed', attempt: 2 } })).body.duplicate, true);

  const ready = await api(`/api/merchant/campaigns/${id}/readiness`, { method: 'POST', token: moranTok });
  assert.equal(ready.body.ready, true, JSON.stringify(ready.body.gates));
  assert.equal((await db('campaign_recipients').count('id as n').first()).n, '0');
  const confirmed = await api(`/api/merchant/campaigns/${id}/confirm`, { method: 'POST', token: moranTok, body: { confirm: true } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.campaign.status, 'dispatching');
  assert.equal(confirmed.body.campaign.counts.queued, 1);
  assert.equal((await api(`/api/merchant/campaigns/${id}/confirm`, { method: 'POST', token: moranTok, body: { confirm: true } })).status, 409);

  // The worker: a transient failure is retried, the message goes out once, and a repeated pass changes nothing.
  moranInternal.failNext = true;
  const first = await processCampaignQueue(db, sender);
  assert.deepEqual([first.retried, first.sent], [1, 0]);
  const second = await processCampaignQueue(db, sender);
  assert.deepEqual([second.sent, second.completed], [1, 1]);
  assert.equal(moranInternal.sent.length, 1);
  assert.equal(moranInternal.sent[0].to, '255711000001');
  assert.equal(moranInternal.sent[0].tenantId, 'tenant-1');
  assert.equal(moranInternal.sent[0].templateName, 'sofa_offer');
  assert.equal(moranInternal.sent[0].components[0].parameters[0].image.link, 'https://example.com/sofa.jpg');
  const third = await processCampaignQueue(db, sender);
  assert.equal(third.sent, 0);
  assert.equal(moranInternal.sent.length, 1);
  const done = await api(`/api/merchant/campaigns/${id}`, { token: moranTok });
  assert.equal(done.body.campaign.status, 'completed');
  assert.equal(done.body.campaign.counts.sent, 1);
});

test('a standalone merchant with an unsupported sender cannot dispatch even when paid and approved', async () => {
  const t = await api('/api/merchant/campaigns/templates', { method: 'POST', token: standTok, body: { name: 'ofa_pili', body: 'Ofa. Jibu STOP kuacha.' } });
  await db('message_templates').where({ id: t.body.template.id }).update({ status: 'approved' });
  const c = await api('/api/merchant/campaigns', { method: 'POST', token: standTok, body: { name: 'Standalone', templateId: t.body.template.id } });
  const id = c.body.campaign.id;
  await api(`/api/merchant/campaigns/${id}`, { method: 'PATCH', token: standTok, body: { draftBody: 'Ofa. Jibu STOP kuacha.' } });
  await api(`/api/merchant/campaigns/${id}/approve`, { method: 'POST', token: standTok });
  await api(`/api/merchant/campaigns/${id}/price`, { method: 'POST', token: standTok });
  const pay = await api(`/api/merchant/campaigns/${id}/pay`, { method: 'POST', token: standTok, body: {} });
  await api(`/api/sandbox/payments/${pay.body.payment.reference}/settle`, { method: 'POST', body: { status: 'completed' } });
  const r = await api(`/api/merchant/campaigns/${id}/confirm`, { method: 'POST', token: standTok, body: { confirm: true } });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.sender.reason, 'no_connected_sender');
  assert.equal((await db('campaign_recipients').where({ campaign_id: id }).count('id as n').first()).n, '0');
});

test('consent is rechecked at send time: an opt-out after confirmation skips the recipient', async () => {
  await upsertContact(db, { merchantId: moranM.id, phone: '255711000004', source: 'order' });
  await recordConsent(db, { merchantId: moranM.id, phone: '255711000004', purpose: 'marketing', status: 'granted', source: 'web_form' });
  const c = await api('/api/merchant/campaigns', { method: 'POST', token: moranTok, body: { name: 'Pili', templateId: template.id, audience: { segment: 'phones', phones: ['255711000004', '255799999999'] } } });
  const id = c.body.campaign.id;
  await api(`/api/merchant/campaigns/${id}`, { method: 'PATCH', token: moranTok, body: { draftBody: 'Ofa. Jibu STOP kuacha.' } });
  await api(`/api/merchant/campaigns/${id}/approve`, { method: 'POST', token: moranTok });
  const priced = await api(`/api/merchant/campaigns/${id}/price`, { method: 'POST', token: moranTok });
  assert.deepEqual(priced.body.audience.exclusionReasons, { not_a_merchant_contact: 1 });
  const pay = await api(`/api/merchant/campaigns/${id}/pay`, { method: 'POST', token: moranTok, body: {} });
  await api(`/api/sandbox/payments/${pay.body.payment.reference}/settle`, { method: 'POST', body: { status: 'completed' } });
  assert.equal((await api(`/api/merchant/campaigns/${id}/confirm`, { method: 'POST', token: moranTok, body: { confirm: true } })).status, 200);
  const raw = JSON.stringify({ messageId: 'wamid.stop', from: '255711000004', text: 'STOP' });
  const sig = signBody(process.env.MORAN_SHARED_SECRET, raw);
  const stop = await fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': sig.timestamp, 'X-MoranBuy-Signature': sig.signature }, body: raw }).then((r) => r.json());
  assert.equal(stop.state, 'opted_out');
  const before = moranInternal.sent.length;
  const pass = await processCampaignQueue(db, sender);
  assert.equal(pass.skipped, 1);
  assert.equal(moranInternal.sent.length, before);
  const rec = await db('campaign_recipients').where({ campaign_id: id }).first();
  assert.equal(rec.skip_reason, 'opted_out');
});

test('publishing a product creates an outreach offer that must be answered; accepting needs the paid service, declining ends it', async () => {
  await db('merchant_entitlements').insert({ merchant_id: moranM.id, service: 'new_product_outreach', status: 'pending_payment', billing_state: 'unpaid' });
  const l = await api('/api/merchant/listings', { method: 'POST', token: moranTok, body: { name: 'Meza ya chakula', price: 700000, stock: 2 } });
  assert.equal(l.body.outreachOffer.status, 'offered');
  assert.equal((await db('campaign_recipients').count('id as n').first()).n, '2');
  const accept = await api(`/api/merchant/campaigns/outreach/offers/${l.body.outreachOffer.id}/answer`, { method: 'POST', token: moranTok, body: { accept: true } });
  assert.equal(accept.status, 403);
  await activateEntitlement(db, moranM.id, 'new_product_outreach', { actor: 'admin:test' });
  const ok = await api(`/api/merchant/campaigns/outreach/offers/${l.body.outreachOffer.id}/answer`, { method: 'POST', token: moranTok, body: { accept: true } });
  assert.equal(ok.body.campaign.status, 'draft');
  const draft = await api(`/api/merchant/campaigns/${ok.body.campaign.id}/draft`, { method: 'POST', token: moranTok, body: {} });
  assert.match(draft.body.campaign.draftBody, /Mpya Samaki Furniture: Meza ya chakula kwa TSh 700,000/);
  const l2 = await api('/api/merchant/listings', { method: 'POST', token: moranTok, body: { name: 'Kiti', price: 90000 } });
  const no = await api(`/api/merchant/campaigns/outreach/offers/${l2.body.outreachOffer.id}/answer`, { method: 'POST', token: moranTok, body: { accept: false } });
  assert.equal(no.body.campaign.status, 'declined');
  assert.equal((await api(`/api/merchant/campaigns/outreach/offers/${l2.body.outreachOffer.id}/answer`, { method: 'POST', token: moranTok, body: { accept: false } })).status, 409);
});

test('follow-up is offered, declining activates and charges nothing, accepting selects the paid service and returns a registration link', async () => {
  const offer = await api('/api/merchant/followup/offer', { token: standTok });
  assert.match(offer.body.question, /Baadhi ya wateja/);
  assert.equal(offer.body.decision, null);
  const no = await api('/api/merchant/followup/offer/answer', { method: 'POST', token: standTok, body: { accept: false } });
  assert.equal(no.body.decision, 'declined');
  assert.equal(await db('merchant_entitlements').where({ merchant_id: standM.id, service: 'paid_followup' }).first(), undefined);
  assert.equal((await api('/api/merchant/followup/leads', { token: standTok })).status, 403);
  const yes = await api('/api/merchant/followup/offer/answer', { method: 'POST', token: moranTok, body: { accept: true } });
  assert.equal(yes.body.decision, 'accepted');
  assert.match(yes.body.registrationUrl, /\/business\/#followup=/);
  const ent = await db('merchant_entitlements').where({ merchant_id: moranM.id, service: 'paid_followup' }).first();
  assert.equal(ent.status, 'pending_payment');
  assert.equal((await api('/api/merchant/followup/leads', { token: moranTok })).status, 403);
  assert.equal((await api('/api/merchant/entitlements/campaign_engine/check', { token: moranTok })).status, 200);
  assert.equal((await api('/api/merchant/followup/leads', { token: moranTok })).body.error, 'SERVICE_NOT_ACTIVE');
});

test('follow-up runs only when paid, not paused, consented and under the attempt limit; replies, opt-outs and purchases stop it; passes are idempotent', async () => {
  moranM = await db('merchants').where({ id: moranM.id }).first();
  await activateEntitlement(db, moranM.id, 'paid_followup', { actor: 'admin:test' });
  await recordConsent(db, { merchantId: moranM.id, phone: '255711000005', purpose: 'followup', status: 'granted', source: 'followup_offer' });
  const now = Date.parse('2026-10-28T10:00:00Z');
  const lead = await createLead(db, { merchantId: moranM.id, phone: '255711000005', listingId: listing.id, source: 'enquiry', statedIntention: 'nitarudi Ijumaa', now });
  assert.equal(lead.state, 'scheduled');
  assert.equal((await db('followup_tasks').where({ lead_id: lead.id }).count('id as n').first()).n, '2');
  const noBasis = await createLead(db, { merchantId: moranM.id, phone: '255711000006', source: 'enquiry', now });
  assert.equal(noBasis.state, 'stopped');
  assert.equal(noBasis.stop_reason, 'no_consent');

  const clock = () => now + 25 * 3600000;
  const before = moranInternal.sent.length;
  await api('/api/merchant/followup/settings', { method: 'PATCH', token: moranTok, body: { paused: true } });
  const paused = await processDueFollowups(db, sender, { dryRun: false, now: clock });
  assert.equal(paused.skipped, 1);
  assert.equal(moranInternal.sent.length, before);
  await api('/api/merchant/followup/settings', { method: 'PATCH', token: moranTok, body: { paused: false } });
  await db('followup_tasks').where({ lead_id: lead.id, attempt: 1 }).update({ status: 'pending' });
  const first = await processDueFollowups(db, sender, { dryRun: false, now: clock });
  assert.equal(first.sent, 1);
  assert.equal(moranInternal.sent.at(-1).to, '255711000005');
  assert.match(moranInternal.sent.at(-1).body, /Sofa L-shape/);
  const again = await processDueFollowups(db, sender, { dryRun: false, now: clock });
  assert.equal(again.sent + again.skipped + again.failed, 0);
  assert.equal((await db('followup_leads').where({ id: lead.id }).first()).state, 'contacted');

  const raw = JSON.stringify({ messageId: 'wamid.reply', from: '255711000005', text: 'Nimenunua tayari' });
  const sig = signBody(process.env.MORAN_SHARED_SECRET, raw);
  await fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': sig.timestamp, 'X-MoranBuy-Signature': sig.signature }, body: raw });
  const stopped = await db('followup_leads').where({ id: lead.id }).first();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stop_reason, 'customer_replied');
  assert.equal((await db('followup_tasks').where({ lead_id: lead.id, attempt: 2 }).first()).status, 'cancelled');
  const later = await processDueFollowups(db, sender, { dryRun: false, now: () => now + 80 * 3600000 });
  assert.equal(later.sent, 0);

  // A service entitlement that stops being paid stops the worker, and a dry run records without sending.
  await recordConsent(db, { merchantId: moranM.id, phone: '255711000007', purpose: 'followup', status: 'granted', source: 'followup_offer' });
  const lead2 = await createLead(db, { merchantId: moranM.id, phone: '255711000007', source: 'enquiry', now });
  await db('merchant_entitlements').where({ merchant_id: moranM.id, service: 'paid_followup' }).update({ billing_state: 'overdue' });
  const unpaid = await processDueFollowups(db, sender, { dryRun: false, now: clock });
  assert.equal(unpaid.skipped, 1);
  assert.equal((await db('followup_tasks').where({ lead_id: lead2.id, attempt: 1 }).first()).skip_reason, 'service_not_active_or_unpaid');
  await db('merchant_entitlements').where({ merchant_id: moranM.id, service: 'paid_followup' }).update({ billing_state: 'paid' });
  await db('followup_tasks').where({ lead_id: lead2.id, attempt: 1 }).update({ status: 'pending' });
  const sentBefore = moranInternal.sent.length;
  const dry = await processDueFollowups(db, new DryRunSender(), { dryRun: true, now: clock });
  assert.equal(dry.sent, 1);
  assert.equal(moranInternal.sent.length, sentBefore);
  assert.equal((await db('followup_tasks').where({ lead_id: lead2.id, attempt: 1 }).first()).dry_run, true);
});

test('a confirmed order gives the merchant a contact with service consent and, where follow-up was accepted, a lead', async () => {
  const send = async (event) => { const raw = JSON.stringify(event); const s = signBody(process.env.MORAN_SHARED_SECRET, raw); return fetch(`${base}/internal/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MoranBuy-Timestamp': s.timestamp, 'X-MoranBuy-Signature': s.signature }, body: raw }).then((r) => r.json()); };
  await send({ messageId: 'o1', from: '255711000008', text: 'Nina laki tano ya sofa, nipo Sinza, delivery' });
  await send({ messageId: 'o2', from: '255711000008', text: '1' });
  const yes = await send({ messageId: 'o3', from: '255711000008', text: 'ndio' });
  assert.equal(yes.state, 'confirmed');
  const contact = await db('contacts').where({ merchant_id: moranM.id, phone: '255711000008' }).first();
  assert.equal(contact.source, 'order');
  const consent = await db('consent_events').where({ merchant_id: moranM.id, phone: '255711000008', purpose: 'service' }).first();
  assert.equal(consent.status, 'granted');
  assert.equal(await db('consent_events').where({ merchant_id: moranM.id, phone: '255711000008', purpose: 'marketing' }).first(), undefined);
  const lead = await db('followup_leads').where({ merchant_id: moranM.id, phone: '255711000008' }).first();
  assert.equal(lead.consent_basis, 'service_relationship');
});
