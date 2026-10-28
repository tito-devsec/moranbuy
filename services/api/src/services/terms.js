import { config } from '@moranbuy/core';
import { recordConsent } from '@moranbuy/consent-management';
import { audit } from '@moranbuy/observability';
import { db } from '../db/connection.js';

// The terms question every new sender gets before the agent answers; wording and version are edited in Super Admin → MoranBuy → Notifications.
export const DEFAULT_TERMS = Object.freeze({
  version: '2026-10-28',
  textSw: 'Karibu MoranBuy. Kwa kuendelea kuwasiliana na MoranBuy unakubali Masharti ya Huduma na Sera ya Faragha: {terms_url} na {privacy_url}. Je, unakubali?',
  textEn: 'Welcome to MoranBuy. By chatting with MoranBuy you accept our Terms of Service and Privacy Policy: {terms_url} and {privacy_url}. Do you accept?',
  acceptSw: 'Nakubali', rejectSw: 'Sikubali', acceptEn: 'I accept', rejectEn: 'I decline',
  rejectedSw: 'Sawa. MoranBuy haitakujibu hadi ukubali masharti. Andika NAKUBALI wakati wowote kuendelea.',
  rejectedEn: 'Okay. MoranBuy will not reply until you accept the terms. Type I ACCEPT at any time to continue.',
  acceptedSw: 'Asante. Niambie bidhaa unayotaka, bajeti yako ya juu, na ulipo.',
  acceptedEn: 'Thank you. Tell me what you need, the most you can spend, and where you are.',
});

export async function loadTerms(dbImpl = db) {
  const row = await dbImpl('platform_settings').where({ key: 'terms' }).first();
  const c = config();
  const base = String(c.APP_URL).replace(/\/+$/, '');
  return { ...DEFAULT_TERMS, ...(row?.value || {}), termsUrl: `${base}/terms`, privacyUrl: `${base}/privacy` };
}

export const BUTTON_ACCEPT = 'terms_accept';
export const BUTTON_REJECT = 'terms_reject';
const ACCEPT_WORDS = /^(nakubali|i accept|accept|kubali|ndio|ndiyo|yes|ok|sawa)\.?$/i;
const REJECT_WORDS = /^(sikubali|i decline|decline|reject|hapana|no|kataa)\.?$/i;

function fill(text, t) { return String(text).replace('{terms_url}', t.termsUrl).replace('{privacy_url}', t.privacyUrl); }

// The message with its two buttons, in the sender's language.
export function termsPrompt(t, language = 'sw') {
  const sw = language !== 'en';
  return { body: fill(sw ? t.textSw : t.textEn, t), buttons: [{ id: BUTTON_ACCEPT, title: sw ? t.acceptSw : t.acceptEn }, { id: BUTTON_REJECT, title: sw ? t.rejectSw : t.rejectEn }], footer: `MoranBuy · ${t.version}` };
}

// Decides whether a sender may be answered; handles accept and reject; otherwise asks again and asks the caller to stop.
export async function termsGate({ dbImpl = db, customer, text = '', buttonId = null, channel = 'whatsapp', acceptTerms = false }) {
  const t = await loadTerms(dbImpl);
  const language = customer.language === 'en' ? 'en' : 'sw';
  if (customer.terms_status === 'accepted' && customer.terms_version === t.version) return { pass: true };
  const accepts = acceptTerms || buttonId === BUTTON_ACCEPT || ACCEPT_WORDS.test(String(text).trim());
  const rejects = buttonId === BUTTON_REJECT || REJECT_WORDS.test(String(text).trim());
  if (accepts) {
    await dbImpl('customers').where({ id: customer.id }).update({ terms_status: 'accepted', terms_version: t.version, terms_accepted_at: dbImpl.fn.now() });
    // A WhatsApp sender's acceptance is also a consent event on the phone; a web token has no phone, so the customer row and the audit carry it.
    if (channel === 'whatsapp') await recordConsent(dbImpl, { merchantId: null, phone: customer.channel_ref, purpose: 'service', channel, status: 'granted', source: buttonId ? 'inbound_keyword' : 'inbound_keyword', evidenceRef: `terms:${t.version}` });
    await audit(dbImpl, { actorType: 'customer', actorId: customer.id, action: 'terms.accepted', targetType: 'customer', targetId: customer.id, after: { version: t.version, channel } });
    Object.assign(customer, { terms_status: 'accepted', terms_version: t.version });
    return { pass: false, accepted: true, replies: [{ text: language === 'en' ? t.acceptedEn : t.acceptedSw }] };
  }
  if (rejects) {
    await dbImpl('customers').where({ id: customer.id }).update({ terms_status: 'rejected', terms_version: t.version });
    await audit(dbImpl, { actorType: 'customer', actorId: customer.id, action: 'terms.rejected', targetType: 'customer', targetId: customer.id, after: { version: t.version, channel } });
    return { pass: false, rejected: true, replies: [{ text: language === 'en' ? t.rejectedEn : t.rejectedSw }] };
  }
  // Anything else from someone who has not accepted gets the question again and no answer.
  await dbImpl('customers').where({ id: customer.id }).increment('terms_prompts', 1);
  const p = termsPrompt(t, language);
  return { pass: false, prompted: true, replies: [{ buttons: p.buttons, text: p.body, footer: p.footer }], terms: { version: t.version, text: p.body, termsUrl: t.termsUrl, privacyUrl: t.privacyUrl, accept: p.buttons[0].title, reject: p.buttons[1].title } };
}
