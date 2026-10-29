import { ApiError, conflict } from '@moranbuy/core';
import { hashPassword, verifyPassword, selectServices } from '@moranbuy/authorization';
import { audit } from '@moranbuy/observability';

// A URL-safe slug from the business name with a short suffix so two shops with one name never clash.
export function makeSlug(name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'shop';
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

// Creates a standalone merchant with its owner and the free product-listing service; paid services only get selected.
export async function registerStandaloneMerchant(db, { businessName, ownerName, email, password, phone = null, industry = null, services = [], ip = null }) {
  const mail = String(email).trim().toLowerCase();
  if (await db('merchant_users').where({ email: mail }).first()) throw conflict('EMAIL_ALREADY_REGISTERED', 'That email already has a MoranBuy account.');
  return db.transaction(async (trx) => {
    const [merchant] = await trx('merchants').insert({ registration_type: 'standalone', business_name: String(businessName).trim(), slug: makeSlug(businessName), industry, contact_phone: phone, contact_email: mail }).returning('*');
    const [user] = await trx('merchant_users').insert({ merchant_id: merchant.id, email: mail, name: String(ownerName).trim(), password_hash: await hashPassword(password), role: 'owner' }).returning('*');
    await selectServices(trx, merchant.id, ['product_listing', ...services]);
    await audit(trx, { actorType: 'merchant', actorId: user.id, merchantId: merchant.id, action: 'merchant.registered', targetType: 'merchant', targetId: merchant.id, after: { registrationType: 'standalone', services }, ip });
    return { merchant, user };
  });
}

// Email and password sign-in for merchant users; the same answer for a wrong email and a wrong password.
export async function authenticateMerchantUser(db, { email, password }) {
  const user = await db('merchant_users').where({ email: String(email).trim().toLowerCase() }).first();
  const ok = user && user.is_active && (await verifyPassword(password, user.password_hash));
  if (!ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is not correct.');
  const merchant = await db('merchants').where({ id: user.merchant_id }).first();
  if (!merchant || merchant.status !== 'active') throw new ApiError(403, 'MERCHANT_SUSPENDED', 'This merchant account is suspended.');
  await db('merchant_users').where({ id: user.id }).update({ last_login_at: db.fn.now() });
  return { user, merchant };
}

// What the apps may show about a merchant; nothing encrypted or internal leaves.
export function publicMerchant(m) {
  if (!m) return null;
  return {
    id: m.id, registrationType: m.registration_type, businessName: m.business_name, slug: m.slug, industry: m.industry, description: m.description,
    country: m.country, currency: m.currency, contactPhone: m.contact_phone, contactEmail: m.contact_email, verificationStatus: m.verification_status,
    status: m.status, moranLinked: !!m.moran_tenant_id, moranTenantId: m.moran_tenant_id || null, moranServices: m.moran_services_json || [], productsSyncedAt: m.products_synced_at, createdAt: m.created_at,
    ownerName: m.owner_name || null, payoutPhone: m.payout_phone || null,
  };
}

// Stores verification documents' references and marks the merchant pending review.
export async function submitVerification(db, merchantId, { registrationNumber = null, taxId = null, documentUrls = [], documentUploadIds = [], notes = null, actorId, ip = null }) {
  const before = await db('merchants').where({ id: merchantId }).first('verification_status', 'verification_json');
  // Uploaded documents must be this business's own verification files; their ids are kept, not their contents.
  const docs = documentUploadIds.length ? await db('uploads').whereIn('id', documentUploadIds).where({ merchant_id: merchantId, purpose: 'verification_document' }).select('id', 'mime', 'size_bytes', 'original_name') : [];
  if (docs.length !== documentUploadIds.length) throw new ApiError(400, 'BAD_DOCUMENT', 'A document is not one of your verification uploads.');
  const payload = { registrationNumber, taxId, documentUrls, documents: docs.map((d) => ({ uploadId: d.id, mime: d.mime, sizeBytes: d.size_bytes, name: d.original_name })), notes, submittedAt: new Date().toISOString() };
  const [row] = await db('merchants').where({ id: merchantId }).update({ verification_status: 'pending', verification_json: JSON.stringify(payload), updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'merchant.verification_submitted', targetType: 'merchant', targetId: merchantId, before, after: { verificationStatus: 'pending' }, ip });
  return row;
}
