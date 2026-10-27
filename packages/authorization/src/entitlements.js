export const SERVICES = Object.freeze(['product_listing', 'campaign_engine', 'new_product_outreach', 'paid_followup', 'conversation_agent']);
export const PAID_SERVICES = Object.freeze(['campaign_engine', 'new_product_outreach', 'paid_followup', 'conversation_agent']);

// True only for an active, unexpired, paid-or-free entitlement; everything else is a no.
export async function hasActiveEntitlement(db, merchantId, service) {
  const row = await db('merchant_entitlements').where({ merchant_id: merchantId, service }).first();
  if (!row || row.status !== 'active') return false;
  if (!['paid', 'free'].includes(row.billing_state)) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false;
  return true;
}

// Records that a merchant selected services; paid ones wait for payment and an explicit activation, listing is free.
export async function selectServices(db, merchantId, services, { actor = 'merchant' } = {}) {
  const chosen = [...new Set(services)].filter((s) => SERVICES.includes(s));
  for (const service of chosen) {
    const paid = PAID_SERVICES.includes(service);
    await db('merchant_entitlements').insert({ merchant_id: merchantId, service, status: paid ? 'pending_payment' : 'active', billing_state: paid ? 'unpaid' : 'free', activated_at: paid ? null : db.fn.now(), activated_by: paid ? null : actor })
      .onConflict(['merchant_id', 'service']).ignore();
  }
  return listEntitlements(db, merchantId);
}

export function listEntitlements(db, merchantId) {
  return db('merchant_entitlements').where({ merchant_id: merchantId }).orderBy('service');
}

// Activation after a verified payment or an admin decision; never automatic on selection.
export async function activateEntitlement(db, merchantId, service, { billingState = 'paid', actor, expiresAt = null, limits = {} }) {
  const [row] = await db('merchant_entitlements').where({ merchant_id: merchantId, service }).update({ status: 'active', billing_state: billingState, activated_at: db.fn.now(), activated_by: actor, expires_at: expiresAt, paused_at: null, limits_json: JSON.stringify(limits) }).returning('*');
  return row || null;
}

export async function pauseEntitlement(db, merchantId, service, { status = 'paused' } = {}) {
  const [row] = await db('merchant_entitlements').where({ merchant_id: merchantId, service }).update({ status, paused_at: db.fn.now() }).returning('*');
  return row || null;
}
