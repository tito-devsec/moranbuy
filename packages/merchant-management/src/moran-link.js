import { ApiError, conflict } from '@moranbuy/core';
import { encrypt, decrypt, hashPassword, selectServices } from '@moranbuy/authorization';
import { audit } from '@moranbuy/observability';
import { makeSlug } from './register.js';

// Signs a Moran AI owner in with their own credentials and links or creates the MoranBuy merchant for that tenant.
export async function linkMoranAccount(db, moran, { email, password, twoFactorCode = null, twoFactorToken = null, existingMerchantId = null, ip = null }) {
  let login;
  if (twoFactorToken) login = await moran.secondStep({ token: twoFactorToken, code: twoFactorCode });
  else login = await moran.login({ email, password });
  if (login.status === 401 || login.status === 403) throw new ApiError(401, 'MORAN_INVALID_CREDENTIALS', login.data?.message || 'Moran AI did not accept these credentials.');
  if (login.data?.twoFactorRequired || login.data?.error === 'TWO_FACTOR_REQUIRED') return { twoFactorRequired: true, twoFactorToken: login.data.token || login.data.twoFactorToken || null };
  if (!login.ok || !login.data?.accessToken) throw new ApiError(502, 'MORAN_LOGIN_FAILED', 'Could not sign in to Moran AI right now.');
  const { accessToken, refreshToken } = login.data;
  const me = await moran.me(accessToken);
  if (!me.ok || !me.data?.tenant?.id) throw new ApiError(502, 'MORAN_ME_FAILED', 'Could not read the Moran AI account.');
  const tenant = me.data.tenant;
  if (me.data.user && me.data.user.role !== 'owner') throw new ApiError(403, 'MORAN_OWNER_ONLY', 'Only the Moran AI business owner can link the account.');
  const servicesRes = await moran.services(accessToken);
  const services = (servicesRes.data?.services || []).map((s) => ({ id: s.id, name: s.name, kind: s.kind || 'products' }));

  return db.transaction(async (trx) => {
    const linked = await trx('merchants').where({ moran_tenant_id: String(tenant.id) }).first();
    if (linked && existingMerchantId && linked.id !== existingMerchantId) throw conflict('MORAN_ALREADY_LINKED', 'That Moran AI business is linked to another MoranBuy account.');
    const patch = { registration_type: 'moran', moran_tenant_id: String(tenant.id), moran_owner_email: tenant.owner_email || null, moran_refresh_token_encrypted: refreshToken ? encrypt(refreshToken) : null, moran_linked_at: trx.fn.now(), moran_services_json: JSON.stringify(services), updated_at: trx.fn.now() };
    let merchant;
    let user = null;
    if (linked || existingMerchantId) {
      const id = linked?.id || existingMerchantId;
      [merchant] = await trx('merchants').where({ id }).update(patch).returning('*');
      user = await trx('merchant_users').where({ merchant_id: id, role: 'owner' }).orderBy('created_at').first();
    } else {
      [merchant] = await trx('merchants').insert({ ...patch, business_name: tenant.business_name || 'Moran business', slug: makeSlug(tenant.business_name || 'moran'), industry: tenant.industry || null, contact_email: tenant.owner_email || null, contact_phone: tenant.owner_wa_number || null, verification_status: tenant.wa_connection_status === 'connected' ? 'verified' : 'pending', verification_json: JSON.stringify({ source: 'moran', waConnection: tenant.wa_connection_status || null }) }).returning('*');
      const mail = String(tenant.owner_email || email).toLowerCase();
      const taken = await trx('merchant_users').where({ email: mail }).first();
      [user] = taken ? [taken] : await trx('merchant_users').insert({ merchant_id: merchant.id, email: mail, name: tenant.owner_name || 'Owner', password_hash: await hashPassword(password || Math.random().toString(36)), role: 'owner' }).returning('*');
      await selectServices(trx, merchant.id, ['product_listing']);
    }
    await audit(trx, { actorType: 'merchant', actorId: user?.id || null, merchantId: merchant.id, action: 'merchant.moran_linked', targetType: 'merchant', targetId: merchant.id, after: { moranTenantId: tenant.id, services: services.length }, ip });
    return { merchant, user, accessToken, services };
  });
}

// A fresh Moran access token for a linked merchant from its stored refresh token; the rotated token is stored back.
export async function moranAccessTokenFor(db, moran, merchant) {
  if (!merchant.moran_refresh_token_encrypted) throw new ApiError(409, 'MORAN_NOT_LINKED', 'Link the Moran AI account first.');
  const res = await moran.refresh(decrypt(merchant.moran_refresh_token_encrypted));
  if (!res.ok || !res.data?.accessToken) throw new ApiError(409, 'MORAN_RELINK_REQUIRED', 'The Moran AI link has expired. Sign in to Moran AI again.');
  if (res.data.refreshToken) await db('merchants').where({ id: merchant.id }).update({ moran_refresh_token_encrypted: encrypt(res.data.refreshToken) });
  return res.data.accessToken;
}
