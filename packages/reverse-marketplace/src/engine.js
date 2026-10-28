import { rankOffers, DEFAULT_POLICY } from '@moranbuy/budget-matching';
import { museExtractRequest, museDraftRecommendation, numbersAreGrounded } from '@moranbuy/muse-intelligence';
import { formatMoney, shortRef } from '@moranbuy/core';
import { shoppingRequestSchema, mergeRequest } from './request.js';
import { fallbackExtract } from './parse.js';
import { clarificationQuestion, missingEssentials } from './clarify.js';
import { discoverOffers } from './discover.js';
import { researchResultsToOffers } from '@moranbuy/integrations';
import { buildFacts, renderReply } from './present.js';
import { upsertContact, recordConsent } from '@moranbuy/consent-management';
import { createLead, followupSettings } from '@moranbuy/followup-engine';
import { recordDemandSignal, recordSchedule, fallbackTiming } from './signals.js';

const SESSION_TTL_MS = 6 * 3600000;

// The customer-facing shopping engine: one call per inbound message, returns the replies to send and the new session state.
export class ShoppingEngine {
  constructor({ db, muse, geocoder, policyLoader = null, researcher = null, profileLoader = null, onOrderConfirmed = null, now = Date.now }) {
    this.db = db; this.muse = muse; this.geocoder = geocoder; this.policyLoader = policyLoader; this.researcher = researcher; this.profileLoader = profileLoader; this.onOrderConfirmed = onOrderConfirmed; this.now = now;
  }

  // Finds the customer's open session or starts one.
  async openSession(customerId) {
    const open = await this.db('shopping_sessions').where({ customer_id: customerId }).whereNotIn('state', ['closed', 'confirmed']).orderBy('created_at', 'desc').first();
    if (open && (!open.expires_at || new Date(open.expires_at).getTime() > this.now())) return open;
    const [row] = await this.db('shopping_sessions').insert({ customer_id: customerId, expires_at: new Date(this.now() + SESSION_TTL_MS) }).returning('*');
    row.isNew = true;
    return row;
  }

  // Handles one inbound message end to end and returns { replies: [{text, imageUrl?}], session, run }.
  async handleMessage({ customer, text = '', imageUrl = null, sharedLocation = null, kind = null }) {
    let session = await this.openSession(customer.id);
    const sourceKind = kind || (imageUrl ? 'image' : sharedLocation ? 'location' : 'text');
    await this.db('session_messages').insert({ session_id: session.id, direction: 'in', content: text || (imageUrl ? `[image] ${imageUrl}` : '[location]'), content_type: imageUrl ? 'image' : sharedLocation ? 'location' : 'text', kind: sourceKind });
    // A voice note Moran could not transcribe cannot be shopped from; the customer is asked to type or send a photo.
    if (sourceKind === 'voice' && (!text || /^\[/.test(text.trim()))) {
      const lang = customer.language === 'en' ? 'en' : 'sw';
      return this.reply(session, [{ text: lang === 'en' ? 'I could not hear that voice note. Please type what you are looking for, your budget and where you are, or send a photo.' : 'Sikuweza kusikia sauti hiyo. Tafadhali andika unachotafuta, bajeti yako na ulipo, au tuma picha.' }]);
    }
    const previous = session.request_json && Object.keys(session.request_json).length ? session.request_json : null;
    const context = session.context_json || {};

    // Read the message with Muse when available, with the deterministic parser as the recorded fallback.
    let museStatus = 'disabled';
    let extracted = null;
    const museResult = await museExtractRequest(this.muse, { text, imageUrl, context: { previousRequest: previous, presentedOffers: context.presented || null, requestRef: session.id } });
    if (museResult.ok && museResult.json) { extracted = sanitizeExtraction(museResult.json); museStatus = 'ok'; }
    else { extracted = fallbackExtract(text); museStatus = museResult.status === 'disabled' ? 'disabled' : 'fallback'; }
    if (text && extracted.maxBudget === null) extracted.maxBudget = fallbackExtract(text).maxBudget;
    if (sharedLocation) extracted.location = { lat: Number(sharedLocation.lat), lng: Number(sharedLocation.lng), label: sharedLocation.label || null, source: 'customer_shared' };
    // What Muse read about timing, a schedule and the name is kept beside the request; the deterministic reading fills in when Muse did not answer.
    const guess = fallbackTiming(text);
    const intel = { purchaseTiming: ['now', 'later', 'browsing'].includes(museResult.json?.purchaseTiming) ? museResult.json.purchaseTiming : guess.purchaseTiming, schedule: museResult.json?.schedule?.when ? { when: String(museResult.json.schedule.when).slice(0, 160), note: museResult.json.schedule.note ? String(museResult.json.schedule.note).slice(0, 500) : null } : guess.schedule, customerName: typeof museResult.json?.customerName === 'string' ? museResult.json.customerName : null };
    const signal = (request, intent, outcome, extra = {}) => recordDemandSignal(this.db, { customer, session, request, kind: sourceKind, intent, outcome, purchaseTiming: intel.purchaseTiming, customerName: intel.customerName, now: this.now(), ...extra }).catch(() => null);

    // Option selection and confirmation are decided by deterministic rules on the stored options, never by the model alone.
    const intent = readIntent(text, extracted, context);
    if (intent.kind === 'cancel') { await signal(previous, 'cancel', 'cancelled'); return this.close(session, customer, intent.language, 'cancelled'); }
    if (intent.kind === 'select' && context.presented?.length) {
      const picked = context.presented.find((p) => p.option === intent.option);
      await signal(previous, 'select', 'selected', { merchantId: picked?.merchantId || null, listingId: picked?.listingId && !String(picked.listingId).startsWith('web:') ? picked.listingId : null });
      return this.select(session, customer, intent.option, previous || {});
    }
    if (intent.kind === 'confirm' && session.state === 'selected') { await signal(previous, 'confirm', 'ordered', { merchantId: session.context_json?.selected?.merchantId || null, listingId: session.context_json?.selected?.listingId || null }); return this.confirm(session, customer, previous || {}); }

    let request;
    try { request = mergeRequest(previous, extracted); } catch { request = shoppingRequestSchema.parse(previous || {}); }
    if (!request.location && request.locationText && this.geocoder) {
      const found = await this.geocoder.geocode(request.locationText).catch(() => null);
      if (found) request.location = { lat: found.lat, lng: found.lng, label: found.label || request.locationText, source: 'customer_text_geocoded' };
    }

    if (intel.schedule) await recordSchedule(this.db, { customer, session, schedule: intel.schedule, now: this.now() }).catch(() => null);
    const ask = clarificationQuestion(request);
    if (ask) {
      await this.save(session, { state: 'clarifying', request_json: request, context_json: { ...context, asked: [...(context.asked || []), ask.field] } });
      await signal(request, 'clarify', 'asked');
      return this.reply(session, [{ text: ask.question }], { museStatus });
    }
    const out = await this.match(session, customer, request, { museStatus, context });
    await signal(request, 'shop', out.result && (out.result.ranked.length || out.result.overBudget.length) ? 'presented' : 'no_match');
    return out;
  }

  // Runs discovery and ranking, stores the evidence, and presents the top offers.
  async match(session, customer, request, { museStatus, context }) {
    const started = this.now();
    const offers = await discoverOffers(this.db, request);
    // Web research, when switched on, adds unverified "found online" offers; they never outrank verified in-budget ones and cannot be ordered here.
    let researchStatus = null;
    if (this.researcher) {
      const r = await this.researcher.research(request).catch(() => ({ ok: false, status: 'error', results: [] }));
      researchStatus = r.status;
      if (r.ok) offers.push(...researchResultsToOffers(r.results));
    }
    const policy = this.policyLoader ? await this.policyLoader() : DEFAULT_POLICY;
    const result = rankOffers({ request, offers, policy, now: this.now() });
    const facts = buildFacts(result, request);
    const [run] = await this.db('matching_runs').insert({
      session_id: session.id, request_json: request, policy_json: result.policy, candidates: offers.length, ranked: result.ranked.length,
      over_budget: result.overBudget.length, excluded: result.excluded.length, none_within_budget: result.noneWithinBudget,
      excluded_json: JSON.stringify(result.excluded), muse_status: researchStatus ? `${museStatus};research:${researchStatus}` : museStatus, duration_ms: this.now() - started,
    }).returning('*');
    const rows = [];
    for (const group of ['ranked', 'overBudget']) {
      for (const r of result[group]) {
        rows.push({ run_id: run.id, listing_id: r.offer.id, merchant_id: r.offer.merchantId, group: group === 'ranked' ? 'ranked' : 'over_budget', rank: r.rank, known_total: r.cost.knownTotal, total_confirmed: r.cost.totalConfirmed, budget_status: r.budget.status, distance_km: r.location.distanceKm, evidence_json: JSON.stringify({ cost: r.cost, budget: r.budget, suitability: r.suitability, location: r.location, trust: r.trust, reasons: r.reasons, offer: { name: r.offer.name, merchant: r.offer.merchantName, source: r.offer.source, price: r.offer.price } }) });
      }
    }
    if (rows.length) await this.db('matching_offers').insert(rows);

    let textOut = renderReply(facts, request.language);
    if (this.muse.enabled && (facts.ranked.length || facts.overBudget.length)) {
      const draft = await museDraftRecommendation(this.muse, { facts, language: request.language, requestRef: session.id });
      if (draft.ok && draft.json?.reply && numbersAreGrounded(draft.json.reply, facts)) textOut = String(draft.json.reply).slice(0, 1500);
    }
    const presented = [...facts.ranked, ...facts.overBudget].map((o) => ({ option: o.option, listingId: o.listingId, merchantId: o.merchantId || null, name: o.name, merchant: o.merchant, knownTotal: o.knownTotal, totalConfirmed: o.totalConfirmed, budgetStatus: o.budgetStatus, imageUrl: o.imageUrl }));
    await this.save(session, { state: 'presented', request_json: request, current_run_id: run.id, context_json: { ...context, presented } });
    const replies = [{ text: textOut }];
    const first = presented.find((p) => p.imageUrl);
    if (first) replies.unshift({ imageUrl: first.imageUrl, caption: `${first.option}. ${first.name} - ${first.merchant}` });
    return this.reply(session, replies, { museStatus, run, result });
  }

  // The customer picked an option: re-check the listing now and read back the known costs before any order exists.
  async select(session, customer, option, request) {
    const presented = (session.context_json?.presented || []).find((p) => p.option === option);
    const lang = request.language || 'sw';
    if (!presented) return this.reply(session, [{ text: lang === 'en' ? 'Please reply with one of the option numbers shown.' : 'Tafadhali jibu kwa namba ya chaguo lililoonyeshwa.' }]);
    if (String(presented.listingId || '').startsWith('web:')) return this.reply(session, [{ text: lang === 'en' ? 'That one was found online and is not a MoranBuy merchant, so I cannot order it for you. Pick another option or ask me to search again.' : 'Hilo limepatikana mtandaoni na si muuzaji wa MoranBuy, kwa hiyo siwezi kuliagiza. Chagua namba nyingine au niambie nitafute tena.' }]);
    const listing = await this.db('listings as l').join('merchants as m', 'm.id', 'l.merchant_id').where('l.id', presented.listingId).whereNull('l.deleted_at').first('l.*', 'm.business_name', 'm.status as merchant_status');
    if (!listing || listing.status !== 'active' || listing.merchant_status !== 'active' || (listing.stock !== null && listing.stock < (request.quantity || 1))) {
      await this.save(session, { state: 'presented' });
      return this.reply(session, [{ text: lang === 'en' ? 'That offer is no longer available. Reply with another option number or tell me to search again.' : 'Chaguo hilo halipo tena. Jibu namba nyingine au niambie nitafute tena.' }]);
    }
    const cur = request.currency || listing.currency;
    const totalLine = presented.totalConfirmed
      ? (lang === 'en' ? `Known total: ${formatMoney(presented.knownTotal, cur)}.` : `Jumla inayojulikana: ${formatMoney(presented.knownTotal, cur)}.`)
      : (lang === 'en' ? `Price ${formatMoney(listing.price, cur)}; the delivery fee is not yet confirmed and will be agreed with ${listing.business_name}.` : `Bei ${formatMoney(listing.price, cur)}; gharama ya delivery haijathibitishwa, itakubaliwa na ${listing.business_name}.`);
    const askConfirm = lang === 'en' ? 'Reply YES to place this order with the merchant, or NO to go back.' : 'Jibu NDIO kuweka oda hii kwa muuzaji, au HAPANA kurudi.';
    await this.save(session, { state: 'selected', selected_offer_id: presented.listingId, context_json: { ...session.context_json, selected: { listingId: presented.listingId, option, knownTotal: presented.knownTotal, totalConfirmed: presented.totalConfirmed, price: listing.price, merchantId: listing.merchant_id, merchantName: listing.business_name } } });
    return this.reply(session, [{ text: `${option}. ${listing.name} - ${listing.business_name}. ${totalLine} ${askConfirm}` }]);
  }

  // Only an explicit YES creates an order; it is recorded as pending with the merchant and the customer gets its reference.
  async confirm(session, customer, request) {
    const sel = session.context_json?.selected;
    const lang = request.language || 'sw';
    if (!sel) return this.reply(session, [{ text: lang === 'en' ? 'Pick an option first.' : 'Chagua chaguo kwanza.' }]);
    const ref = shortRef('MB');
    const fulfilment = request.fulfilment === 'pickup' ? 'pickup' : request.fulfilment === 'delivery' ? 'delivery' : 'pickup';
    const [order] = await this.db('orders').insert({
      order_ref: ref, customer_id: customer.id, session_id: session.id, merchant_id: sel.merchantId, listing_id: sel.listingId, quantity: request.quantity || 1,
      unit_price: sel.price, delivery_fee: sel.totalConfirmed ? sel.knownTotal - sel.price * (request.quantity || 1) : null, known_total: sel.knownTotal, total_confirmed: sel.totalConfirmed,
      currency: request.currency || 'TZS', fulfilment, customer_location_json: request.location ? JSON.stringify(request.location) : null, status: 'pending_merchant', confirmed_at: new Date(this.now()),
    }).returning('*');
    // The business owner is told at once; a failure to tell them never undoes the order and is recorded for admins.
    if (this.onOrderConfirmed) await this.onOrderConfirmed(order).catch((err) => this.db('merchant_notifications').insert({ merchant_id: order.merchant_id, event: 'order_confirmed', target_type: 'order', target_id: order.id, channel: 'whatsapp', kind: 'text', status: 'failed', error: String(err.message).slice(0, 500), idempotency_key: `order_confirmed:${order.id}:err` }).catch(() => {}));
    await this.save(session, { state: 'confirmed' });
    // The merchant now has a real relationship with this customer: a contact and service consent for the order, and a lead only where follow-up was accepted.
    if (customer.channel === 'whatsapp') {
      await upsertContact(this.db, { merchantId: sel.merchantId, phone: customer.channel_ref, name: customer.name || null, source: 'order' });
      await recordConsent(this.db, { merchantId: sel.merchantId, phone: customer.channel_ref, purpose: 'service', status: 'granted', source: 'order_confirmation', evidenceRef: ref });
      const merchant = await this.db('merchants').where({ id: sel.merchantId }).first();
      if (followupSettings(merchant).decision === 'accepted') await createLead(this.db, { merchantId: sel.merchantId, phone: customer.channel_ref, listingId: sel.listingId, source: 'order', statedIntention: 'placed an order', customerRef: customer.id, now: this.now() });
    }
    const text = lang === 'en'
      ? `Order ${ref} sent to ${sel.merchantName}. Status: waiting for the merchant to accept. I will tell you when it changes.`
      : `Oda ${ref} imetumwa kwa ${sel.merchantName}. Hali: inasubiri muuzaji akubali. Nitakujulisha ikibadilika.`;
    return this.reply(session, [{ text }], { orderRef: ref });
  }

  async close(session, customer, language, reason) {
    await this.save(session, { state: 'closed', context_json: { ...session.context_json, closedReason: reason } });
    return this.reply(session, [{ text: language === 'en' ? 'Okay, cancelled. Tell me what you need whenever you are ready.' : 'Sawa, nimeghairi. Niambie unachohitaji wakati wowote.' }]);
  }

  async save(session, patch) {
    const row = { ...patch, updated_at: new Date(this.now()) };
    for (const k of ['request_json', 'context_json']) if (row[k] && typeof row[k] === 'object') row[k] = JSON.stringify(row[k]);
    await this.db('shopping_sessions').where({ id: session.id }).update(row);
    Object.assign(session, patch);
  }

  async reply(session, replies, extra = {}) {
    // On a customer's first message of a new session the agent introduces itself with the name chosen in Super Admin.
    if (session.isNew && this.profileLoader && replies[0]?.text) {
      const p = await this.profileLoader().catch(() => null);
      const lang = session.request_json?.language === 'en' ? 'en' : 'sw';
      const greeting = p ? (lang === 'en' ? (p.greetingEn || `Hello, I am ${p.name} from MoranBuy.`) : (p.greetingSw || `Habari, mimi ni ${p.name} wa MoranBuy.`)) : null;
      if (greeting) replies[0] = { ...replies[0], text: `${greeting} ${replies[0].text}` };
      session.isNew = false;
    }
    for (const r of replies) await this.db('session_messages').insert({ session_id: session.id, direction: 'out', content: r.text || r.caption || '', content_type: r.imageUrl ? 'image' : 'text' });
    return { replies, session, ...extra };
  }
}

// Keeps only the fields the request schema knows and the control fields the engine reads.
function sanitizeExtraction(j) {
  const keep = ['productType', 'category', 'essentialAttributes', 'preferredAttributes', 'maxBudget', 'currency', 'quantity', 'locationText', 'fulfilment', 'alternativesOk', 'urgency', 'language', 'intent', 'selection'];
  const out = {};
  for (const k of keep) if (j[k] !== undefined) out[k] = j[k];
  if (out.maxBudget !== null && out.maxBudget !== undefined) out.maxBudget = Number.isFinite(Number(out.maxBudget)) ? Math.round(Number(out.maxBudget)) : null;
  if (out.quantity !== undefined) out.quantity = Number.isFinite(Number(out.quantity)) && Number(out.quantity) > 0 ? Math.round(Number(out.quantity)) : 1;
  for (const k of ['essentialAttributes', 'preferredAttributes']) if (out[k] && typeof out[k] !== 'object') delete out[k];
  return out;
}

// Reads control intents from the text with fixed rules; the model's reading is used only to pick an option number.
function readIntent(text, extracted, context) {
  const t = String(text || '').trim().toLowerCase();
  const language = extracted.language === 'en' ? 'en' : 'sw';
  if (/^(hapana|no|ghairi|cancel|acha|stop)\b/.test(t)) return { kind: 'cancel', language };
  if (/^(ndio|ndiyo|yes|sawa|confirm|nakubali|ok)\b/.test(t)) return { kind: 'confirm', language };
  const num = t.match(/^(?:option|chaguo|namba|nambari)?\s*(\d{1,2})\b/);
  if (num && context.presented?.length) return { kind: 'select', option: Number(num[1]), language };
  if (extracted.intent === 'select' && Number.isInteger(extracted.selection) && context.presented?.length) return { kind: 'select', option: extracted.selection, language };
  return { kind: 'shop', language };
}
