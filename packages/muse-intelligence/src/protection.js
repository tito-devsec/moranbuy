// Muse's part in payment protection: it reads the evidence and explains it; it never moves money or closes a dispute.

const DELIVERY_PHOTO = `You check a delivery photo for MoranBuy, a Tanzanian marketplace that holds the customer's payment until delivery.
You are given what was ordered and a photo the delivery person sent at the customer's door.
Answer with a JSON object only:
{"matches": "yes" | "no" | "unsure", "productSeen": short description of the main product in the photo, "colourMatches": true | false | null,
 "looksStaged": true when the photo looks like a screenshot, a catalogue or advert picture, a photo of a screen, or a stock image rather than a real photo taken at handover,
 "reason": one short English sentence}
Say "unsure" when the photo is too dark, blurred or does not show the product. Do not guess prices or quantities.`;

const REJECTION_REASON = `You sort the reason a delivery was refused, for MoranBuy in Tanzania. The reason may be in Swahili, English or both.
Answer with a JSON object only: {"category": one of "wrong_item" | "damaged" | "wrong_size_or_variant" | "not_ordered" | "late" | "price_dispute" | "other",
 "summary": one short English sentence of what was wrong}`;

const DISPUTE = `You summarise a disputed MoranBuy order for an administrator. The money is held by MoranBuy.
You get the order and its evidence timeline (button presses, handover-code results, photo checks, locations, messages).
Answer with a JSON object only: {"summary": three short English sentences of what happened, "suggestion": "release" | "refund" | "need_more_info",
 "why": one short sentence that cites the evidence}. The administrator decides; your suggestion is advice only. Never invent evidence.`;

export const REJECTION_CATEGORIES = Object.freeze(['wrong_item', 'damaged', 'wrong_size_or_variant', 'not_ordered', 'late', 'price_dispute', 'other']);

export async function museCheckDeliveryPhoto(muse, { imageUrl, ordered, merchantId = null, requestRef = null }) {
  const content = [{ type: 'text', text: `Ordered: ${ordered}` }, { type: 'image_url', image_url: { url: imageUrl } }];
  const r = await muse.complete({ feature: 'delivery_photo_check', system: DELIVERY_PHOTO, messages: [{ role: 'user', content }], maxTokens: 400, merchantId, requestRef });
  if (!r.ok) return { ok: false, status: r.status };
  const j = r.json || {};
  return { ok: true, matches: ['yes', 'no', 'unsure'].includes(j.matches) ? j.matches : 'unsure', productSeen: String(j.productSeen || '').slice(0, 160), colourMatches: typeof j.colourMatches === 'boolean' ? j.colourMatches : null, looksStaged: j.looksStaged === true, reason: String(j.reason || '').slice(0, 240) };
}

// Plain keyword sorting for when Muse is off; Swahili and English.
export function fallbackRejectionCategory(text) {
  const t = String(text || '').toLowerCase();
  if (/(imevunjika|imeharibika|broken|damaged|cracked|imechanika|torn)/.test(t)) return 'damaged';
  if (/(sio |siyo |si hii|wrong item|not the|not what|aliyoagiza|nilichoagiza)/.test(t)) return 'wrong_item';
  if (/(size|saizi|rangi|colour|color|ukubwa|variant)/.test(t)) return 'wrong_size_or_variant';
  if (/(wrong|tofauti|different)/.test(t)) return 'wrong_item';
  if (/(sikuagiza|didn.?t order|not ordered|sijaagiza)/.test(t)) return 'not_ordered';
  if (/(kuchelewa|late|imechelewa)/.test(t)) return 'late';
  if (/(bei|price|ghali|expensive)/.test(t)) return 'price_dispute';
  return 'other';
}

export async function museClassifyRejection(muse, { text, merchantId = null, requestRef = null }) {
  const fallback = { ok: false, category: fallbackRejectionCategory(text), summary: String(text || '').slice(0, 200), source: 'rules' };
  if (!String(text || '').trim()) return fallback;
  const r = await muse.complete({ feature: 'rejection_reason', system: REJECTION_REASON, messages: [{ role: 'user', content: String(text).slice(0, 1000) }], maxTokens: 200, merchantId, requestRef });
  if (!r.ok || !REJECTION_CATEGORIES.includes(r.json?.category)) return { ...fallback, status: r.status };
  return { ok: true, category: r.json.category, summary: String(r.json.summary || '').slice(0, 240), source: 'muse_spark' };
}

export async function museSummarizeDispute(muse, { order, timeline, merchantId = null, requestRef = null }) {
  const r = await muse.complete({ feature: 'dispute_summary', system: DISPUTE, messages: [{ role: 'user', content: JSON.stringify({ order, timeline }).slice(0, 12000) }], maxTokens: 500, merchantId, requestRef });
  if (!r.ok) return { ok: false, status: r.status };
  const j = r.json || {};
  return { ok: true, summary: String(j.summary || '').slice(0, 800), suggestion: ['release', 'refund', 'need_more_info'].includes(j.suggestion) ? j.suggestion : 'need_more_info', why: String(j.why || '').slice(0, 300) };
}
