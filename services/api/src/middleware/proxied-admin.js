import crypto from 'node:crypto';
import { config, ApiError } from '@moranbuy/core';
import { db } from '../db/connection.js';

const ROLE_MAP = { super_admin: 'super_admin', admin: 'admin', finance: 'admin', support: 'support', viewer: 'support' };

// Signature over timestamp, method, path and raw body, so a signed request cannot be replayed against another route.
export function signAdminProxy(secret, { method, path, rawBody = '', timestamp = Math.floor(Date.now() / 1000) }) {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${method.toUpperCase()}.${path}.${rawBody}`).digest('hex');
  return { timestamp: String(timestamp), signature };
}

// A Super Admin request forwarded by Moran: verified by the shared secret, the admin identity in headers becomes a shadow admin row here.
export function proxiedAdmin(dbImpl = db) {
  return async (req, _res, next) => {
    try {
      const sig = req.headers['x-moranbuy-signature'];
      const email = req.headers['x-moranbuy-admin-email'];
      if (!sig || !email) return next();
      const c = config();
      const ts = Number(req.headers['x-moranbuy-timestamp']);
      if (!c.MORAN_SHARED_SECRET || !Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) throw new ApiError(401, 'BAD_SIGNATURE', 'Proxy signature rejected.');
      const expected = crypto.createHmac('sha256', c.MORAN_SHARED_SECRET).update(`${ts}.${req.method.toUpperCase()}.${req.originalUrl}.${req.rawBody || ''}`).digest('hex');
      const a = Buffer.from(String(sig)); const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ApiError(401, 'BAD_SIGNATURE', 'Proxy signature rejected.');
      const role = ROLE_MAP[String(req.headers['x-moranbuy-admin-role'] || '').toLowerCase()] || 'support';
      const name = String(req.headers['x-moranbuy-admin-name'] || email).slice(0, 120);
      const mail = String(email).toLowerCase();
      // The shadow row has no usable password: it exists so audit events name the Moran admin.
      const [admin] = await dbImpl('admin_users').insert({ email: mail, name, password_hash: `proxied:${crypto.randomBytes(16).toString('hex')}`, role, is_active: true, last_login_at: dbImpl.fn.now() })
        .onConflict('email').merge({ name, role, last_login_at: dbImpl.fn.now() }).returning('*');
      if (!admin.is_active) throw new ApiError(401, 'ADMIN_DISABLED', 'This admin account is disabled in MoranBuy.');
      req.admin = { ...admin, proxied: true };
      next();
    } catch (err) { next(err); }
  };
}
