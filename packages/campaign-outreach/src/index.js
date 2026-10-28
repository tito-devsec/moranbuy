import { hasActiveEntitlement } from '@moranbuy/authorization';
import { audit } from '@moranbuy/observability';
import { ApiError, notFound } from '@moranbuy/core';

// When a product is published or its price changes, MoranBuy may offer a promotion; it asks, it never sends.
export async function offerOutreachForListing(db, { merchantId, listingId, trigger = 'listing_published' }) {
  const selected = await db('merchant_entitlements').where({ merchant_id: merchantId, service: 'new_product_outreach' }).first();
  if (!selected) return null;
  const listing = await db('listings').where({ id: listingId, merchant_id: merchantId }).whereNull('deleted_at').first();
  if (!listing || listing.status !== 'active' || !listing.moranbuy_visible || listing.admin_hidden_at) return null;
  const open = await db('campaigns').where({ merchant_id: merchantId, kind: 'new_product_outreach', listing_id: listingId }).whereIn('status', ['offered', 'draft', 'approved', 'priced', 'awaiting_payment', 'paid', 'ready']).first();
  if (open) return open;
  const [row] = await db('campaigns').insert({ merchant_id: merchantId, kind: 'new_product_outreach', name: `New product: ${listing.name}`.slice(0, 160), objective: `Tell customers about ${listing.name}`, listing_id: listingId, status: 'offered', audience_json: JSON.stringify({ segment: 'consented_contacts' }), draft_history_json: JSON.stringify([{ by: 'system', note: trigger, at: new Date().toISOString() }]) }).returning('*');
  await audit(db, { actorType: 'system', merchantId, action: 'outreach.offered', targetType: 'campaign', targetId: row.id, after: { listingId, trigger, entitlementStatus: selected.status } });
  return row;
}

export function listOutreachOffers(db, merchantId) {
  return db('campaigns as c').leftJoin('listings as l', 'l.id', 'c.listing_id').where({ 'c.merchant_id': merchantId, 'c.kind': 'new_product_outreach' }).orderBy('c.created_at', 'desc').limit(100).select('c.*', 'l.name as listing_name', 'l.price as listing_price', 'l.currency as listing_currency');
}

// The merchant answers the offer: accepting turns it into a draft campaign (still nothing sent); declining closes it.
export async function answerOutreachOffer(db, merchantId, id, { accept, actorId, ip = null }) {
  const row = await db('campaigns').where({ id, merchant_id: merchantId, kind: 'new_product_outreach' }).first();
  if (!row) throw notFound('OFFER_NOT_FOUND');
  if (row.status !== 'offered') throw new ApiError(409, 'OFFER_ANSWERED', 'This offer was already answered.');
  if (accept && !(await hasActiveEntitlement(db, merchantId, 'new_product_outreach'))) throw new ApiError(403, 'SERVICE_NOT_ACTIVE', 'Activate the new-product outreach service first (payment is verified before activation).', { service: 'new_product_outreach' });
  const [updated] = await db('campaigns').where({ id }).update({ status: accept ? 'draft' : 'declined', updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: accept ? 'outreach.accepted' : 'outreach.declined', targetType: 'campaign', targetId: id, ip });
  return updated;
}
