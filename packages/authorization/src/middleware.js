import { ApiError } from '@moranbuy/core';
import { verifyAccessToken } from './tokens.js';
import { hasActiveEntitlement } from './entitlements.js';

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Authenticates a merchant user, re-reading the user and merchant on every request so a suspension bites at once.
export function requireMerchantAuth(db) {
  return async (req, _res, next) => {
    try {
      const token = bearer(req);
      if (!token) throw new ApiError(401, 'MISSING_TOKEN', 'Sign in to continue.');
      let payload;
      try { payload = verifyAccessToken(token); } catch { throw new ApiError(401, 'INVALID_TOKEN', 'Your session has expired. Sign in again.'); }
      if (payload.type !== 'merchant') throw new ApiError(403, 'WRONG_TOKEN_TYPE', 'This is not a merchant session.');
      const user = await db('merchant_users').where({ id: payload.sub }).first();
      if (!user || !user.is_active) throw new ApiError(401, 'USER_DISABLED', 'This account is disabled.');
      const merchant = await db('merchants').where({ id: user.merchant_id }).first();
      if (!merchant) throw new ApiError(401, 'MERCHANT_NOT_FOUND', 'Merchant not found.');
      if (merchant.status !== 'active') throw new ApiError(403, 'MERCHANT_SUSPENDED', 'This merchant account is suspended.');
      req.merchantUser = user;
      req.merchant = merchant;
      next();
    } catch (err) { next(err); }
  };
}

// Authenticates a platform admin; disabled admins are cut off before their token expires.
export function requireAdminAuth(db, ...roles) {
  return async (req, _res, next) => {
    try {
      // An admin Super Admin's proxy already identified (proxiedAdmin) only needs the role check.
      if (req.admin?.proxied) {
        if (roles.length && !roles.includes(req.admin.role)) throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Your role does not allow this.');
        return next();
      }
      const token = bearer(req);
      if (!token) throw new ApiError(401, 'MISSING_TOKEN', 'Sign in to continue.');
      let payload;
      try { payload = verifyAccessToken(token); } catch { throw new ApiError(401, 'INVALID_TOKEN', 'Your session has expired. Sign in again.'); }
      if (payload.type !== 'admin') throw new ApiError(403, 'WRONG_TOKEN_TYPE', 'This is not an admin session.');
      const admin = await db('admin_users').where({ id: payload.sub }).first();
      if (!admin || !admin.is_active) throw new ApiError(401, 'ADMIN_DISABLED', 'This admin account is disabled.');
      if (roles.length && !roles.includes(admin.role)) throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Your role does not allow this.');
      req.admin = admin;
      next();
    } catch (err) { next(err); }
  };
}

// Refuses a merchant route unless the named service is active for that merchant right now.
export function requireEntitlement(db, service) {
  return async (req, _res, next) => {
    try {
      if (!req.merchant) throw new ApiError(401, 'MISSING_TOKEN', 'Sign in to continue.');
      const ok = await hasActiveEntitlement(db, req.merchant.id, service);
      if (!ok) throw new ApiError(403, 'SERVICE_NOT_ACTIVE', `The ${service.replace(/_/g, ' ')} service is not active for this business.`, { service });
      next();
    } catch (err) { next(err); }
  };
}
