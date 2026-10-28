import { z } from 'zod';
import { ApiError, notFound } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';
import { museDraftCampaign, museDraftOutreach, museAudienceFit } from '@moranbuy/muse-intelligence';
import { resolveAudience } from '@moranbuy/consent-management';
import { priceCampaign, startPayment } from '@moranbuy/billing';
import { evaluateDispatchGates } from './gates.js';

export const campaignInput = z.object({
  name: z.string().trim().min(2).max(160),
  objective: z.string().max(1000).nullable().optional(),
  listingId: z.string().uuid().nullable().optional(),
  templateId: z.string().uuid().nullable().optional(),
  audience: z.object({ segment: z.enum(['consented_contacts', 'tag', 'phones', 'best_fit']).default('consented_contacts'), tag: z.string().max(40).optional(), phones: z.array(z.string().max(20)).max(5000).optional(), listingId: z.string().uuid().optional(), limit: z.number().int().min(1).max(5000).optional() }).optional(),
  language: z.enum(['sw', 'en']).optional(),
  mediaUrl: z.string().url().max(600).nullable().optional(),
});

export function publicCampaign(r, extra = {}) {
  if (!r) return null;
  return { id: r.id, merchantId: r.merchant_id, kind: r.kind, scheduledAt: r.scheduled_at || null, statusReason: r.status_reason || null, name: r.name, objective: r.objective, listingId: r.listing_id, templateId: r.template_id, audience: r.audience_json, language: r.language, draftBody: r.draft_body, draftHistory: r.draft_history_json || [], mediaUrl: r.media_url, status: r.status, audiencePreview: r.audience_preview_json || {}, pricing: r.pricing_json || {}, paymentId: r.payment_id, sender: r.sender_json || {}, gateResults: r.gate_results_json || {}, dryRun: r.dry_run, approvedAt: r.approved_at, confirmedAt: r.confirmed_at, dispatchedAt: r.dispatched_at, completedAt: r.completed_at, counts: { queued: r.count_queued, sent: r.count_sent, delivered: r.count_delivered, failed: r.count_failed, skipped: r.count_skipped }, createdAt: r.created_at, updatedAt: r.updated_at, ...extra };
}

const EDITABLE = ['draft', 'approved', 'priced', 'awaiting_payment'];

export async function listCampaigns(db, merchantId, { kind = null } = {}) {
  let q = db('campaigns').where({ merchant_id: merchantId }).orderBy('created_at', 'desc').limit(200);
  if (kind) q = q.where({ kind });
  return (await q).map((r) => publicCampaign(r));
}

export async function getCampaign(db, merchantId, id) {
  const row = await db('campaigns').where({ id, merchant_id: merchantId }).first();
  if (!row) throw notFound('CAMPAIGN_NOT_FOUND');
  return row;
}

// A listing used in a campaign must belong to the same merchant; the check is in the query, not the UI.
async function ownListing(db, merchantId, listingId) {
  if (!listingId) return null;
  const l = await db('listings').where({ id: listingId, merchant_id: merchantId }).whereNull('deleted_at').first();
  if (!l) throw new ApiError(400, 'VALIDATION_ERROR', 'That product does not belong to this business.', { listingId: 'unknown product' });
  return l;
}

export async function createCampaign(db, merchantId, input, { kind = 'campaign', actorId, ip = null, dryRun = true }) {
  await ownListing(db, merchantId, input.listingId);
  if (input.templateId && !(await db('message_templates').where({ id: input.templateId, merchant_id: merchantId }).first())) throw new ApiError(400, 'VALIDATION_ERROR', 'That template does not belong to this business.', { templateId: 'unknown template' });
  const [row] = await db('campaigns').insert({ merchant_id: merchantId, kind, name: input.name, objective: input.objective || null, listing_id: input.listingId || null, template_id: input.templateId || null, audience_json: JSON.stringify(input.audience || { segment: 'consented_contacts' }), language: input.language || 'sw', media_url: input.mediaUrl || null, dry_run: dryRun }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'campaign.created', targetType: 'campaign', targetId: row.id, after: { kind, name: row.name }, ip });
  return row;
}

export async function updateCampaign(db, merchantId, id, input, { actorId, ip = null }) {
  const current = await getCampaign(db, merchantId, id);
  if (!EDITABLE.includes(current.status)) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'This campaign can no longer be edited.');
  await ownListing(db, merchantId, input.listingId);
  const patch = { updated_at: db.fn.now(), status: 'draft', approved_at: null, pricing_json: '{}', payment_id: null };
  if (input.name !== undefined) patch.name = input.name;
  if (input.objective !== undefined) patch.objective = input.objective;
  if (input.listingId !== undefined) patch.listing_id = input.listingId;
  if (input.templateId !== undefined) patch.template_id = input.templateId;
  if (input.audience !== undefined) patch.audience_json = JSON.stringify(input.audience);
  if (input.language !== undefined) patch.language = input.language;
  if (input.mediaUrl !== undefined) patch.media_url = input.mediaUrl;
  if (input.draftBody !== undefined) { patch.draft_body = input.draftBody; patch.draft_history_json = JSON.stringify([...(current.draft_history_json || []), { by: 'merchant', body: input.draftBody, at: new Date().toISOString() }]); }
  const [row] = await db('campaigns').where({ id }).update(patch).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'campaign.updated', targetType: 'campaign', targetId: id, after: Object.keys(input), ip });
  return row;
}

// Facts Muse may write around: only what the listing and merchant rows say.
export async function campaignFacts(db, merchant, campaign) {
  const listing = campaign.listing_id ? await db('listings').where({ id: campaign.listing_id }).first() : null;
  const location = await db('merchant_locations').where({ merchant_id: merchant.id, is_default: true }).whereNull('deleted_at').first();
  return {
    product: listing ? { name: listing.name, price: Number(listing.price), currency: listing.currency, attributes: listing.attributes || {}, stock: listing.stock, status: listing.status, description: (listing.description || '').slice(0, 300) } : null,
    merchant: { name: merchant.business_name, location: location?.formatted_address || null, pickup: location?.pickup_available ?? null, delivery: location?.delivery_available ?? null },
  };
}

// The deterministic draft used when Muse is off or its draft fails the number check.
export function fallbackDraft(facts, { language = 'sw', objective = null, kind = 'campaign' } = {}) {
  const p = facts.product; const m = facts.merchant;
  const price = p ? `${p.currency === 'TZS' ? 'TSh' : p.currency} ${Number(p.price).toLocaleString('en-US')}` : null;
  if (language === 'en') return [p ? `${kind === 'new_product_outreach' ? 'New at' : 'From'} ${m.name}: ${p.name} at ${price}.` : `A message from ${m.name}.`, objective || '', m.location ? `Find us at ${m.location}.` : '', 'Reply for details. Reply STOP to opt out.'].filter(Boolean).join(' ');
  return [p ? `${kind === 'new_product_outreach' ? 'Mpya' : 'Kutoka'} ${m.name}: ${p.name} kwa ${price}.` : `Ujumbe kutoka ${m.name}.`, objective || '', m.location ? `Tupo ${m.location}.` : '', 'Jibu kupata maelezo. Jibu STOP kuacha.'].filter(Boolean).join(' ');
}

// Muse drafts from the facts; any draft with numbers that are not in the facts is replaced by the deterministic one and said so.
export async function draftCampaign(db, muse, merchant, id, { revision = null, actorId, ip = null }) {
  const campaign = await getCampaign(db, merchant.id, id);
  if (!EDITABLE.includes(campaign.status)) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'This campaign can no longer be edited.');
  const facts = await campaignFacts(db, merchant, campaign);
  const args = { objective: campaign.objective, product: facts.product, merchant: facts.merchant, language: campaign.language, merchantId: merchant.id };
  const r = campaign.kind === 'new_product_outreach' && !revision ? await museDraftOutreach(muse, args) : await museDraftCampaign(muse, { ...args, revision: revision ? { instruction: revision, previous: campaign.draft_body || '' } : null });
  const { numbersAreGrounded } = await import('@moranbuy/muse-intelligence');
  let body; let source;
  if (r.ok && r.json?.body && numbersAreGrounded(r.json.body, facts)) { body = String(r.json.body).slice(0, 1024); source = 'muse'; }
  else { body = fallbackDraft(facts, { language: campaign.language, objective: campaign.objective, kind: campaign.kind }); source = r.ok ? 'fallback_ungrounded' : `fallback_${r.status}`; }
  const history = [...(campaign.draft_history_json || []), { by: source, body, at: new Date().toISOString(), ...(revision ? { revision } : {}), notes: r.json?.notes || [] }];
  const [row] = await db('campaigns').where({ id }).update({ draft_body: body, draft_history_json: JSON.stringify(history), status: 'draft', approved_at: null, updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId: merchant.id, action: 'campaign.drafted', targetType: 'campaign', targetId: id, after: { source, revision: !!revision }, ip });
  return { campaign: row, draftSource: source, notes: r.json?.notes || [] };
}

// The merchant approves the words; that is not a dispatch.
export async function approveDraft(db, merchantId, id, { actorId, ip = null }) {
  const campaign = await getCampaign(db, merchantId, id);
  if (!campaign.draft_body) throw new ApiError(409, 'NO_DRAFT', 'Write or generate the message first.');
  if (!EDITABLE.includes(campaign.status)) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'This campaign can no longer be edited.');
  const [row] = await db('campaigns').where({ id }).update({ status: 'approved', approved_at: db.fn.now(), updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'campaign.draft_approved', targetType: 'campaign', targetId: id, ip });
  return row;
}

// Audience and cost with every exclusion reason; the provider rate is reported unknown when nobody configured it.
export async function priceAndPreview(db, merchantId, id, { pricing, actorId, ip = null, muse = null }) {
  const campaign = await getCampaign(db, merchantId, id);
  if (!['approved', 'priced', 'awaiting_payment', 'draft'].includes(campaign.status)) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'This campaign can no longer be priced.');
  // A best-fit audience follows the campaign's own product unless the merchant named another.
  const audienceSpec = campaign.audience_json?.segment === 'best_fit' ? { ...campaign.audience_json, listingId: campaign.audience_json.listingId || campaign.listing_id || null } : campaign.audience_json;
  const audience = await resolveAudience(db, { merchantId, audience: audienceSpec, purpose: 'marketing' });
  // Muse explains the fit of the strongest matches in words; it can reorder and explain, never add anyone.
  let fit = null;
  if (audienceSpec?.segment === 'best_fit' && audience.included.length) {
    const top = audience.included.slice(0, 30).map((i, idx) => ({ ref: `c${idx + 1}`, phone: i.phone, asked: i.fit }));
    fit = { counted: audience.included.length, explained: [] };
    if (muse?.enabled) {
      const facts = await campaignFacts(db, await db('merchants').where({ id: merchantId }).first(), campaign);
      const r = await museAudienceFit(muse, { offer: facts.product, candidates: top.map(({ ref, asked }) => ({ ref, ...asked })), language: campaign.language || 'sw', merchantId }).catch(() => ({ ok: false }));
      if (r.ok && Array.isArray(r.json?.ranked)) fit.explained = r.json.ranked.filter((x) => top.some((c) => c.ref === x.ref)).slice(0, 30).map((x) => ({ phone: top.find((c) => c.ref === x.ref).phone.replace(/^(\d{6})\d+(\d{2})$/, '$1***$2'), score: Number(x.score) || 0, reason: String(x.reason || '').slice(0, 200) }));
    }
    if (!fit.explained.length) fit.explained = top.map((c) => ({ phone: c.phone.replace(/^(\d{6})\d+(\d{2})$/, '$1***$2'), score: c.asked.score, reason: c.asked.reasons.join(', ') }));
  }
  const price = priceCampaign({ recipients: audience.included.length, pricing });
  const [row] = await db('campaigns').where({ id }).update({ audience_preview_json: JSON.stringify({ counts: audience.counts, exclusionReasons: audience.exclusionReasons, segment: audience.segment, fit, previewedAt: new Date().toISOString() }), pricing_json: JSON.stringify(price), status: campaign.status === 'approved' || campaign.status === 'priced' ? 'priced' : campaign.status, updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'campaign.priced', targetType: 'campaign', targetId: id, after: { recipients: audience.included.length, estimatedTotal: price.estimatedTotal }, ip });
  return { campaign: row, audience: { counts: audience.counts, exclusionReasons: audience.exclusionReasons, segment: audience.segment, fit }, pricing: price };
}

export async function startCampaignPayment(db, provider, merchantId, id, { phone = null, actorId, ip = null }) {
  const campaign = await getCampaign(db, merchantId, id);
  if (campaign.status !== 'priced') throw new ApiError(409, 'NOT_PRICED', 'Approve the draft and review the cost first.');
  const price = campaign.pricing_json || {};
  if (price.estimatedTotal === null || price.estimatedTotal === undefined) throw new ApiError(409, 'PRICING_INCOMPLETE', price.note || 'The cost cannot be computed yet.');
  if (!price.recipients) throw new ApiError(409, 'NO_RECIPIENTS', 'Nobody eligible to receive this campaign.');
  const payment = await startPayment(db, provider, { merchantId, purpose: 'campaign', targetId: id, amount: price.estimatedTotal, currency: price.currency, phone, breakdown: price, actorId });
  const [row] = await db('campaigns').where({ id }).update({ payment_id: payment.id, status: 'awaiting_payment', updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'campaign.payment_started', targetType: 'campaign', targetId: id, after: { paymentId: payment.id, amount: payment.amount }, ip });
  return { campaign: row, payment };
}

// Runs every gate; a campaign becomes ready only when all pass, and the results are stored whatever they are.
export async function checkReadiness(db, merchant, id, { pricingConfigured }) {
  const campaign = await getCampaign(db, merchant.id, id);
  const template = campaign.template_id ? await db('message_templates').where({ id: campaign.template_id, merchant_id: merchant.id }).first() : null;
  const result = await evaluateDispatchGates(db, { campaign, merchant, template, pricingConfigured });
  const status = result.ok ? 'ready' : campaign.status === 'ready' ? 'paid' : campaign.status;
  const [row] = await db('campaigns').where({ id }).update({ gate_results_json: JSON.stringify(result.gates), sender_json: JSON.stringify(result.sender || {}), status: ['dispatching', 'completed', 'cancelled'].includes(campaign.status) ? campaign.status : status, updated_at: db.fn.now() }).returning('*');
  return { campaign: row, ...result };
}
