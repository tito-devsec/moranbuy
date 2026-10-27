import crypto from 'node:crypto';
import { ApiError } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';
import { selectServices } from '@moranbuy/authorization';

export const FOLLOWUP_OFFER_TEXT = {
  sw: 'Baadhi ya wateja huuliza kuhusu bidhaa na kusema watarudi baadaye. Je, ungependa kutumia huduma ya MoranBuy ya kufuatilia wateja wanaostahili kufuatiliwa? Ni huduma ya kulipia na inaanza tu ukikubali.',
  en: 'Some customers ask about a product and say they will come back later. Would you like MoranBuy\'s follow-up service to follow up the customers who qualify? It is a paid service and starts only if you accept.',
};

// The follow-up settings live on the merchant row; nothing is enabled until the merchant accepts.
export function followupSettings(merchant) {
  const s = merchant.settings_json?.followup || {};
  return { decision: s.decision || null, offeredAt: s.offeredAt || null, decidedAt: s.decidedAt || null, scheduleHours: s.scheduleHours || [24, 72], maxAttempts: s.maxAttempts || 2, paused: !!s.paused, quietHours: s.quietHours || { from: 21, to: 8 }, registrationToken: s.registrationToken || null };
}

async function saveSettings(db, merchantId, patch) {
  const merchant = await db('merchants').where({ id: merchantId }).first();
  const next = { ...(merchant.settings_json || {}), followup: { ...(merchant.settings_json?.followup || {}), ...patch } };
  const [row] = await db('merchants').where({ id: merchantId }).update({ settings_json: JSON.stringify(next), updated_at: db.fn.now() }).returning('*');
  return row;
}

// Records that the question was put to the merchant; asked once, never activated by asking.
export async function offerFollowup(db, merchantId, { language = 'sw' } = {}) {
  const merchant = await db('merchants').where({ id: merchantId }).first();
  const s = followupSettings(merchant);
  if (!s.offeredAt) { await saveSettings(db, merchantId, { offeredAt: new Date().toISOString() }); await audit(db, { actorType: 'system', merchantId, action: 'followup.offered', targetType: 'merchant', targetId: merchantId }); }
  return { question: FOLLOWUP_OFFER_TEXT[language] || FOLLOWUP_OFFER_TEXT.sw, decision: s.decision };
}

// Accepting selects the paid service and returns a one-time registration link; declining records the no and changes nothing else.
export async function answerFollowupOffer(db, merchantId, { accept, actorId, ip = null, appUrl }) {
  if (!accept) {
    await saveSettings(db, merchantId, { decision: 'declined', decidedAt: new Date().toISOString() });
    await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'followup.declined', targetType: 'merchant', targetId: merchantId, ip });
    return { decision: 'declined', registrationUrl: null };
  }
  const token = crypto.randomBytes(24).toString('base64url');
  await saveSettings(db, merchantId, { decision: 'accepted', decidedAt: new Date().toISOString(), registrationToken: token });
  await selectServices(db, merchantId, ['paid_followup'], { actor: `merchant:${actorId}` });
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'followup.accepted', targetType: 'merchant', targetId: merchantId, ip });
  return { decision: 'accepted', registrationUrl: `${String(appUrl).replace(/\/+$/, '')}/business/#followup=${token}`, service: 'paid_followup', nextSteps: ['verify your business', 'read the follow-up policy', 'pay for the service', 'set your schedule'] };
}

export async function updateFollowupSettings(db, merchantId, { scheduleHours, maxAttempts, paused, quietHours, actorId, ip = null }) {
  const patch = {};
  if (scheduleHours) patch.scheduleHours = scheduleHours.slice(0, 5).map((h) => Math.max(1, Math.min(720, Number(h))));
  if (maxAttempts) patch.maxAttempts = Math.max(1, Math.min(5, Number(maxAttempts)));
  if (paused !== undefined) patch.paused = !!paused;
  if (quietHours) patch.quietHours = quietHours;
  const row = await saveSettings(db, merchantId, patch);
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'followup.settings_updated', targetType: 'merchant', targetId: merchantId, after: patch, ip });
  return followupSettings(row);
}

export function assertCanOperate(merchant) {
  const s = followupSettings(merchant);
  if (s.decision !== 'accepted') throw new ApiError(403, 'FOLLOWUP_NOT_ACCEPTED', 'The follow-up service was not accepted by this business.');
  return s;
}
