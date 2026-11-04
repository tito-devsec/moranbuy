import { rankOffers, DEFAULT_POLICY } from '@moranbuy/budget-matching';
import { museExtractRequest, museDraftRecommendation, numbersAreGrounded } from '@moranbuy/muse-intelligence';
import { formatMoney, shortRef } from '@moranbuy/core';
import { shoppingRequestSchema, mergeRequest } from './request.js';
import { fallbackExtract, parseAlternatives, parseUrgency, placeFromAnswer, tidyAttributes } from './parse.js';
import { normalizeProductType } from '@moranbuy/budget-matching';
import { clarificationQuestion, missingEssentials } from './clarify.js';
import { discoverOffers } from './discover.js';
import { researchResultsToOffers } from '@moranbuy/integrations';
import { buildFacts, renderReply, stripContacts, preferPictured } from './present.js';
import { upsertContact, recordConsent } from '@moranbuy/consent-management';
import { createLead, followupSettings, holdLeadsForOrder } from '@moranbuy/followup-engine';
import { recordDemandSignal, recordSchedule, fallbackTiming } from './signals.js';

const SESSION_TTL_MS = 6 * 3600000;

// The customer-facing shopping engine: one call per inbound message, returns the replies to send and the new session state.
export class ShoppingEngine {
  constructor({ db, muse, geocoder, policyLoader = null, researcher = null, nearby = null, leads = null, contact = null, profileLoader = null, onOrderConfirmed = null, now = Date.now }) {
    this.db = db; this.muse = muse; this.geocoder = geocoder; this.policyLoader = policyLoader; this.researcher = researcher; this.nearby = nearby; this.leads = leads; this.contact = contact; this.profileLoader = profileLoader; this.onOrderConfirmed = onOrderConfirmed; this.now = now;
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
  async handleMessage({ customer, text = '', imageUrl = null, imageDataUrl = null, sharedLocation = null, kind = null }) {
    // Moran sends a shared location with a placeholder caption; the coordinates are the message, the caption is not a request.
    text = String(text || '').replace(/\[\s*customer shared (?:their|a|the) location[^\]]*\]/gi, '').trim();
    let session = await this.openSession(customer.id);
    const sourceKind = kind || (imageUrl ? 'image' : sharedLocation ? 'location' : 'text');
    await this.db('session_messages').insert({ session_id: session.id, direction: 'in', content: [text, imageUrl ? `[image] ${imageUrl}` : null].filter(Boolean).join(' ') || '[location]', content_type: imageUrl ? 'image' : sharedLocation ? 'location' : 'text', kind: sourceKind });
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
    const lastAsked = session.state === 'clarifying' ? (context.asked || []).at(-1) || null : null;
    // A shared map pin is named (and its country read) before anything else, so Muse and the search both know the place.
    let pin = null;
    if (sharedLocation) {
      pin = { lat: Number(sharedLocation.lat), lng: Number(sharedLocation.lng), label: sharedLocation.label || null, country: null, source: 'customer_shared' };
      if (this.geocoder?.reverse) { const r = await this.geocoder.reverse(pin.lat, pin.lng).catch(() => null); if (r) { pin.label = pin.label || r.label; pin.country = r.country || null; } }
    }
    const museResult = await museExtractRequest(this.muse, { text, imageUrl: imageDataUrl ? null : imageUrl, imageDataUrl, context: { previousRequest: previous, presentedOffers: context.presented || null, answering: lastAsked, sharedPlace: pin?.label || null, requestRef: session.id } });
    if (museResult.ok && museResult.json) { extracted = tidyAttributes(sanitizeExtraction(museResult.json)); museStatus = 'ok'; }
    else { extracted = fallbackExtract(text); museStatus = museResult.status === 'disabled' ? 'disabled' : 'fallback'; }
    if (text && extracted.maxBudget === null) extracted.maxBudget = fallbackExtract(text).maxBudget;
    // A message with no words (a shared pin, a photo alone) says nothing about the customer's language; the conversation keeps the one it had.
    if (!text) delete extracted.language;
    // The plain words for "no alternatives" and urgency always count, even when Muse missed them.
    // Only the customer's own words rule alternatives out; a model's guess at "no alternatives" would hide the closest offers for no reason.
    if (text) { const said = parseAlternatives(text); if (extracted.alternativesOk === false && said.alternativesOk === undefined) delete extracted.alternativesOk; Object.assign(extracted, said); if (!extracted.urgency) extracted.urgency = parseUrgency(text); }
    if (pin) { extracted.location = pin; if (pin.label && !extracted.locationText) extracted.locationText = pin.label; }
    // A reply to "Upo wapi?" is the place itself, even without "nipo": "mbagala dar".
    if (lastAsked === 'location' && text && !extracted.locationText && !sharedLocation) { const place = placeFromAnswer(text); if (place) extracted.locationText = place; }
    // The product changes only when the customer clearly asks for a new one: never from a location, an answer to another question, or "mbadala ni upi?".
    if (previous?.productType && extracted.productType && extracted.productType !== previous.productType) {
      const namesProduct = !!normalizeProductType(text).productType || (museStatus === 'ok' && !lastAsked);
      if (sharedLocation || (lastAsked && lastAsked !== 'productType') || extracted.wantsAlternatives || !namesProduct) delete extracted.productType;
    }
    if (lastAsked && lastAsked !== 'productType' && !previous?.productType && extracted.productType && !normalizeProductType(text).productType && museStatus !== 'ok') delete extracted.productType;
    // An impossible budget (above TSh 1 billion) is asked again instead of searched.
    if (extracted.maxBudget && extracted.maxBudget > 1_000_000_000) extracted.maxBudget = null;
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
    // YES to "shall I ask this shop?" records the request; MoranBuy contacts the shop with the number it keeps private.
    if (intent.kind === 'confirm' && session.state === 'contact_confirm') { await signal(previous, 'contact_shop', 'asked'); return this.contactShop(session, customer, previous || {}); }
    // "Mbadala ni upi?" after a search shows the alternatives for the same request: over budget and found online.
    if (extracted.wantsAlternatives && previous?.productType && !normalizeProductType(text).productType) {
      const out = await this.match(session, customer, { ...previous, alternativesOk: true }, { museStatus, context: { ...context, alternatives: true } });
      await signal(previous, 'shop', out.result && (out.result.ranked.length || out.result.overBudget.length) ? 'presented' : 'no_match');
      return out;
    }
    // "NDIO" to a reminder reruns the search the customer made before, with nothing new mixed in.
    if (intent.kind === 'confirm' && session.state !== 'selected' && context.fromScheduleId && previous?.productType) {
      const { fromScheduleId, ...rest } = context;
      await this.db('customer_schedules').where({ id: fromScheduleId }).update({ status: 'done', updated_at: new Date(this.now()) }).catch(() => null);
      const out = await this.match(session, customer, previous, { museStatus, context: { ...rest, resumedFromScheduleId: fromScheduleId } });
      await signal(previous, 'shop', out.result && (out.result.ranked.length || out.result.overBudget.length) ? 'presented' : 'no_match');
      return out;
    }
    if (intent.kind === 'confirm' && session.state === 'selected') { await signal(previous, 'confirm', 'ordered', { merchantId: session.context_json?.selected?.merchantId || null, listingId: session.context_json?.selected?.listingId || null }); return this.confirm(session, customer, previous || {}); }

    let request;
    try { request = mergeRequest(previous, extracted); } catch { request = shoppingRequestSchema.parse(previous || {}); }
    if (!request.location && request.locationText && this.geocoder) {
      const found = await this.geocoder.geocode(request.locationText).catch(() => null);
      if (found) request.location = { lat: found.lat, lng: found.lng, label: found.label || request.locationText, country: found.country || null, source: 'customer_text_geocoded' };
    }

    if (intel.schedule) await recordSchedule(this.db, { customer, session, schedule: intel.schedule, now: this.now() }).catch(() => null);
    // The same question is asked at most twice; after that the search runs without that detail and says so.
    const askedTwice = ['location'].filter((f) => (context.asked || []).filter((a) => a === f).length >= 2);
    const ask = clarificationQuestion(request, { skip: askedTwice });
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
    const policy = this.policyLoader ? await this.policyLoader() : DEFAULT_POLICY;
    // MoranBuy's own shops come first; the web is searched only when fewer than three of them fit within budget. Online finds never outrank verified ones and cannot be ordered here.
    let researchStatus = null;
    if (this.researcher && rankOffers({ request, offers, policy, now: this.now() }).ranked.length < 3) {
      const r = await this.researcher.research(request).catch(() => ({ ok: false, status: 'error', results: [] }));
      researchStatus = r.status;
      if (r.ok) offers.push(...researchResultsToOffers(r.results));
    }
    let result = rankOffers({ request, offers: preferPictured(offers), policy, now: this.now() });
    // Nothing matched only because of an attribute (a brand, a model): the closest offers are shown instead of nothing, and the reply says which detail was not met.
    let relaxed = null;
    if (!result.ranked.length && !result.overBudget.length) {
      const failedKeys = [...new Set(result.excluded.flatMap((e) => (String(e.reason).startsWith('unsuitable:') ? e.reason.slice(11).split(',') : [])))];
      // A brand or model (often read off a photo) never hides every offer, even for a customer who wants no other product; other details stay exact when they asked for that.
      if (failedKeys.length && (request.alternativesOk !== false || failedKeys.every((k) => ['brand', 'model'].includes(k)))) {
        const essential = { ...(request.essentialAttributes || {}) }; const preferred = { ...(request.preferredAttributes || {}) };
        for (const k of failedKeys) { preferred[k] = essential[k]; delete essential[k]; }
        const again = rankOffers({ request: { ...request, essentialAttributes: essential, preferredAttributes: preferred }, offers: preferPictured(offers), policy, now: this.now() });
        if (again.ranked.length || again.overBudget.length) { result = again; relaxed = failedKeys.map((k) => `${k === 'brand' ? '' : `${k} `}${typeof request.essentialAttributes[k] === 'object' ? JSON.stringify(request.essentialAttributes[k]) : request.essentialAttributes[k]}`.trim()); }
      }
    }
    const facts = buildFacts(result, request);
    facts.relaxed = relaxed;
    const [run] = await this.db('matching_runs').insert({
      session_id: session.id, request_json: request, policy_json: result.policy, candidates: offers.length, ranked: result.ranked.length,
      over_budget: result.overBudget.length, excluded: result.excluded.length, none_within_budget: result.noneWithinBudget,
      excluded_json: JSON.stringify(result.excluded), muse_status: String(researchStatus ? `${museStatus};research:${researchStatus}` : museStatus).slice(0, 80), duration_ms: this.now() - started,
    }).returning('*');
    const rows = [];
    for (const group of ['ranked', 'overBudget']) {
      for (const r of result[group]) {
        // Online finds have no MoranBuy listing or business; their page link is kept in the evidence instead.
        const own = r.offer.source !== 'web';
        rows.push({ run_id: run.id, listing_id: own ? r.offer.id : null, merchant_id: own ? r.offer.merchantId : null, group: group === 'ranked' ? 'ranked' : 'over_budget', rank: r.rank, known_total: r.cost.knownTotal, total_confirmed: r.cost.totalConfirmed, budget_status: r.budget.status, distance_km: r.location.distanceKm, evidence_json: JSON.stringify({ cost: r.cost, budget: r.budget, suitability: r.suitability, location: r.location, trust: r.trust, reasons: r.reasons, offer: { name: r.offer.name, merchant: r.offer.merchantName, source: r.offer.source, price: r.offer.price, ...(own ? {} : { url: r.offer.sourceUrl }) } }) });
      }
    }
    if (rows.length) await this.db('matching_offers').insert(rows);

    let textOut = renderReply(facts, request.language);
    if (this.muse.enabled && !relaxed && (facts.ranked.length || facts.overBudget.length)) {
      const draft = await museDraftRecommendation(this.muse, { facts, language: request.language, requestRef: session.id });
      if (draft.ok && draft.json?.reply && numbersAreGrounded(draft.json.reply, facts)) textOut = String(draft.json.reply).slice(0, 1500);
    }
    // The shop's number is kept in the session only, for the moment the customer asks MoranBuy to contact the shop; it is never put in a message.
    const privateContact = new Map([...result.ranked, ...result.overBudget].map((r) => [r.offer.id, r.offer.contactPhone || null]));
    const presented = [...facts.ranked, ...facts.overBudget].map((o) => ({ option: o.option, listingId: o.listingId, merchantId: o.merchantId || null, name: o.name, variant: o.variant || null, merchant: o.merchant, knownTotal: o.knownTotal, totalConfirmed: o.totalConfirmed, budgetStatus: o.budgetStatus, imageUrl: o.imageUrl, area: o.area || o.locationLabel || null, kind: o.source === 'web' ? 'web' : 'own', contact: privateContact.get(o.listingId) || null }));
    // Shops near the customer from Google Maps continue the numbering: no prices there, so the customer can ask MoranBuy to check with the shop.
    const near = await this.nearbyShops(request, presented.length);
    presented.push(...near.entries);
    await this.save(session, { state: 'presented', request_json: request, current_run_id: run.id, context_json: { ...context, presented } });
    // Up to three offers with a photo go first, each with its price, shop, area and a line of description; no number or website is ever shown.
    const photos = [...facts.ranked, ...facts.overBudget].filter((o) => o.imageUrl).slice(0, 3).map((o) => ({ imageUrl: o.imageUrl, caption: photoCaption(o, request) }));
    // Few confirmed MoranBuy offers: Moran AI businesses with matching products are asked (their answer comes later, as new options).
    const own = [...result.ranked, ...result.overBudget].filter((r) => r.offer.source !== 'web').length;
    if (this.leads && own < 3) {
      const asked = await this.leads({ session, customer, request }).catch(() => ({ asked: 0 }));
      if (asked.asked) textOut += `\n\n${request.language === 'en' ? `I have also asked ${asked.asked} Moran AI shop${asked.asked > 1 ? 's' : ''} that sell this; if they agree, their offers will come here and can be paid safely through MoranBuy.` : `Pia nimeuliza maduka ${asked.asked} ya Moran AI yanayouza bidhaa hii; yakikubali, ofa zao zitakuja hapa na unaweza kulipa salama kupitia MoranBuy.`}`;
    }
    const replies = [...photos, { text: stripContacts(textOut) }];
    if (near.text) replies.push({ text: near.text });
    return this.reply(session, replies, { museStatus, run, result });
  }

  // A Moran business agreed to offer its matching products to this customer: they are ranked for the request and become the new numbered options.
  async presentAgreedOffers(customer, offers, { businessName }) {
    const session = await this.db('shopping_sessions').where({ customer_id: customer.id }).whereNotIn('state', ['closed', 'confirmed']).orderBy('created_at', 'desc').first();
    if (!session || !offers.length) return null;
    const request = shoppingRequestSchema.parse(session.request_json || {});
    const policy = this.policyLoader ? await this.policyLoader() : DEFAULT_POLICY;
    const result = rankOffers({ request, offers, policy, now: this.now() });
    const facts = buildFacts(result, request);
    const all = [...facts.ranked, ...facts.overBudget];
    if (!all.length) return null;
    const presented = all.map((o) => ({ option: o.option, listingId: o.listingId, merchantId: o.merchantId || null, name: o.name, variant: o.variant || null, merchant: o.merchant, knownTotal: o.knownTotal, totalConfirmed: o.totalConfirmed, budgetStatus: o.budgetStatus, imageUrl: o.imageUrl }));
    await this.save(session, { state: 'presented', context_json: { ...(session.context_json || {}), presented, agreedBy: businessName } });
    const en = request.language === 'en';
    const intro = en ? `${businessName} agreed to offer you these. Reply with the number to order; MoranBuy holds your payment until it arrives.` : `${businessName} amekubali kukuletea hizi. Jibu namba kuagiza; MoranBuy inashikilia malipo yako hadi bidhaa ifike.`;
    const photos = all.filter((o) => o.imageUrl).slice(0, 3).map((o) => ({ imageUrl: o.imageUrl, caption: photoCaption(o, request) }));
    return this.reply(session, [...photos, { text: `${intro}\n${renderReply(facts, request.language)}` }]);
  }

  // Shops from Google Maps near the customer, numbered after the offers; the number and the map link stay out of the message.
  async nearbyShops(request, startAt = 0) {
    if (!this.nearby || !request.location) return { text: null, entries: [] };
    const r = await this.nearby.find(request).catch(() => ({ ok: false, shops: [] }));
    if (!r.shops?.length) return { text: null, entries: [] };
    const en = request.language === 'en';
    const lines = [en ? `Shops near you that sell ${request.productType} (prices not known):` : `Maduka karibu nawe yanayouza ${request.productType} (bei haijulikani):`];
    const entries = [];
    r.shops.forEach((s, i) => {
      const option = startAt + i + 1;
      const bits = [s.distanceKm !== null ? `${s.distanceKm} km` : null, s.rating ? `${s.rating}★${s.ratings ? ` (${s.ratings})` : ''}` : null, s.openNow === true ? (en ? 'open now' : 'wazi sasa') : s.openNow === false ? (en ? 'closed now' : 'imefungwa sasa') : null].filter(Boolean);
      lines.push(`${option}. ${s.name}${s.address ? `, ${s.address}` : ''}${bits.length ? ` - ${bits.join(', ')}` : ''}`);
      entries.push({ option, listingId: `shop:${s.placeId || option}`, merchantId: null, name: request.productType, variant: null, merchant: s.name, knownTotal: null, totalConfirmed: false, budgetStatus: 'unknown', imageUrl: null, area: s.address || null, kind: 'shop', contact: s.phone || null });
    });
    lines.push(en ? 'Reply with a shop number and I will ask that shop for the price and whether it is in stock.' : 'Jibu namba ya duka nikuulizie bei na kama bidhaa ipo.');
    return { text: stripContacts(lines.join('\n')).slice(0, 1500), entries };
  }

  // The customer picked an option: re-check the listing now and read back the known costs before any order exists.
  async select(session, customer, option, request) {
    const presented = (session.context_json?.presented || []).find((p) => p.option === option);
    const lang = request.language || 'sw';
    if (!presented) return this.reply(session, [{ text: lang === 'en' ? 'Please reply with one of the option numbers shown.' : 'Tafadhali jibu kwa namba ya chaguo lililoonyeshwa.' }]);
    if (/^(web|shop):/.test(String(presented.listingId || ''))) return this.askContact(session, presented, request);
    const listing = await this.db('listings as l').join('merchants as m', 'm.id', 'l.merchant_id').where('l.id', presented.listingId).whereNull('l.deleted_at').first('l.*', 'm.business_name', 'm.status as merchant_status');
    const variant = presented.variant ? (Array.isArray(listing?.variants) ? listing.variants : []).find((v) => v && v.name === presented.variant) : null;
    const stockNow = variant && variant.stock !== null && variant.stock !== undefined ? Number(variant.stock) : listing?.stock;
    const priceNow = variant && Number(variant.price) > 0 ? Number(variant.price) : listing?.price;
    if (!listing || listing.status !== 'active' || listing.merchant_status !== 'active' || (presented.variant && !variant) || (stockNow !== null && stockNow !== undefined && stockNow < (request.quantity || 1))) {
      await this.save(session, { state: 'presented' });
      return this.reply(session, [{ text: lang === 'en' ? 'That offer is no longer available. Reply with another option number or tell me to search again.' : 'Chaguo hilo halipo tena. Jibu namba nyingine au niambie nitafute tena.' }]);
    }
    const cur = request.currency || listing.currency;
    const totalLine = presented.totalConfirmed
      ? (lang === 'en' ? `Known total: ${formatMoney(presented.knownTotal, cur)}.` : `Jumla inayojulikana: ${formatMoney(presented.knownTotal, cur)}.`)
      : (lang === 'en' ? `Price ${formatMoney(priceNow, cur)}; the delivery fee is not yet confirmed and will be agreed with ${listing.business_name}.` : `Bei ${formatMoney(priceNow, cur)}; gharama ya delivery haijathibitishwa, itakubaliwa na ${listing.business_name}.`);
    const askConfirm = lang === 'en' ? 'Reply YES to place this order with the merchant, or NO to go back.' : 'Jibu NDIO kuweka oda hii kwa muuzaji, au HAPANA kurudi.';
    await this.save(session, { state: 'selected', selected_offer_id: presented.listingId, context_json: { ...session.context_json, selected: { listingId: presented.listingId, option, knownTotal: presented.knownTotal, totalConfirmed: presented.totalConfirmed, price: priceNow, variant: presented.variant || null, merchantId: listing.merchant_id, merchantName: listing.business_name } } });
    return this.reply(session, [{ text: `${option}. ${listing.name}${presented.variant ? ` (${presented.variant})` : ''} - ${listing.business_name}. ${totalLine} ${askConfirm}` }]);
  }

  // An online find or a map shop is not a MoranBuy business, so it cannot be ordered here: the customer is asked whether MoranBuy should check with the shop.
  async askContact(session, presented, request) {
    const en = request.language === 'en';
    const price = presented.kind === 'web' && presented.knownTotal ? formatMoney(presented.knownTotal, request.currency || 'TZS') : null;
    await this.save(session, { state: 'contact_confirm', context_json: { ...session.context_json, contactTarget: { option: presented.option, kind: presented.kind || 'web', listingId: presented.listingId, name: presented.name, merchant: presented.merchant, price: presented.knownTotal || null, area: presented.area || null, imageUrl: presented.imageUrl || null, contact: presented.contact || null } } });
    const what = `${presented.option}. ${presented.name} - ${presented.merchant}${price ? ` (${price})` : ''}`;
    return this.reply(session, [{ text: en
      ? `${what}. This shop is not on MoranBuy yet, so it cannot be ordered here. Shall I contact the shop for you to confirm that it is in stock and the final price, and tell you here? Reply YES or NO.`
      : `${what}. Duka hili bado halijajiunga na MoranBuy, kwa hiyo siwezi kuagiza hapa. Nikuwasiliane na duka kuthibitisha kama bidhaa ipo na bei ya mwisho, kisha nikujulishe hapa? Jibu NDIO au HAPANA.` }]);
  }

  async contactShop(session, customer, request) {
    const en = request.language === 'en';
    const target = session.context_json?.contactTarget;
    const made = target && this.contact ? await this.contact({ session, customer, request, target }).catch(() => null) : null;
    await this.save(session, { state: 'presented' });
    if (!made) return this.reply(session, [{ text: en ? 'Sorry, I could not send your request to the shop right now. Pick another option or try again later.' : 'Samahani, sikuweza kutuma ombi lako kwa duka sasa. Chagua chaguo lingine au jaribu tena baadaye.' }]);
    return this.reply(session, [{ text: en
      ? `Done. I have asked ${target.merchant} about ${target.name}. I will tell you here as soon as they answer (request ${made.ref}). You can pick another option meanwhile.`
      : `Sawa. Nimeomba ${target.merchant} kuthibitisha ${target.name}. Nitakujulisha hapa mara tu watakapojibu (ombi ${made.ref}). Unaweza kuchagua chaguo lingine wakati huu.` }]);
  }

  // Only an explicit YES creates an order; it is recorded as pending with the merchant and the customer gets its reference.
  async confirm(session, customer, request) {
    const sel = session.context_json?.selected;
    const lang = request.language || 'sw';
    if (!sel) return this.reply(session, [{ text: lang === 'en' ? 'Pick an option first.' : 'Chagua chaguo kwanza.' }]);
    const ref = shortRef('MB');
    const fulfilment = request.fulfilment === 'pickup' ? 'pickup' : request.fulfilment === 'delivery' ? 'delivery' : 'pickup';
    const [order] = await this.db('orders').insert({
      order_ref: ref, customer_id: customer.id, session_id: session.id, merchant_id: sel.merchantId, listing_id: sel.listingId, variant: sel.variant || null, quantity: request.quantity || 1,
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
      // Earlier leads stop nudging now; they count as converted only when the merchant accepts or delivers.
      await holdLeadsForOrder(this.db, { merchantId: sel.merchantId, phone: customer.channel_ref, orderRef: ref });
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
      const greeting = p ? greetingFor(p, lang) : null;
      if (greeting) replies[0] = { ...replies[0], text: `${greeting} ${replies[0].text}` };
      session.isNew = false;
    }
    for (const r of replies) await this.db('session_messages').insert({ session_id: session.id, direction: 'out', content: r.text || r.caption || '', content_type: r.imageUrl ? 'image' : 'text' });
    return { replies, session, ...extra };
  }
}

// One photo's caption: option, name, price, shop and area, a line of description, and the link for an online find.
function photoCaption(o, request) {
  const en = request.language === 'en';
  const where = [o.merchant, o.area || o.locationLabel].filter(Boolean).join(', ');
  const lines = [`${o.option}. ${o.name}`, `${formatMoney(o.price, request.currency || 'TZS')}${where ? ` - ${where}` : ''}${o.source === 'web' ? (en ? ' (found online, not confirmed)' : ' (imepatikana mtandaoni, haijathibitishwa)') : ''}`];
  if (o.description) lines.push(o.description);
  return stripContacts(lines.join('\n')).slice(0, 1000);
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

// The agent introduces itself once by the name chosen in Super Admin; "of MoranBuy" is added only when the name does not already say it.
export function greetingFor(profile, lang = 'sw') {
  if (lang === 'en' && profile.greetingEn) return profile.greetingEn;
  if (lang !== 'en' && profile.greetingSw) return profile.greetingSw;
  const name = String(profile.name || 'MoranBuy').trim();
  const saysMoranBuy = /moran\s*buy/i.test(name);
  if (lang === 'en') return saysMoranBuy ? `Hello, I am ${name}.` : `Hello, I am ${name} from MoranBuy.`;
  return saysMoranBuy ? `Habari, mimi ni ${name}.` : `Habari, mimi ni ${name} wa MoranBuy.`;
}
