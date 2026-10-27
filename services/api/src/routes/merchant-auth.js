import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { ApiError } from '@moranbuy/core';
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshTokens, requireMerchantAuth, listEntitlements } from '@moranbuy/authorization';
import { registerStandaloneMerchant, authenticateMerchantUser, publicMerchant, linkMoranAccount } from '@moranbuy/merchant-management';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { merchantDeps } from '../services/merchants.js';

export const merchantAuthRouter = express.Router();

// Failed sign-ins are limited per account so a shared mobile-carrier IP never locks everyone out.
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `login:${String(req.body?.email || '').toLowerCase()}` });

const registerBody = z.object({
  businessName: z.string().trim().min(2).max(160),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  phone: z.string().max(32).optional(),
  industry: z.string().max(80).optional(),
  services: z.array(z.enum(['campaign_engine', 'new_product_outreach', 'paid_followup'])).max(3).optional(),
});

async function session(user, merchant) {
  return { accessToken: signAccessToken({ type: 'merchant', sub: user.id, merchantId: merchant.id, role: user.role, email: user.email }), refreshToken: await issueRefreshToken(db, { subjectType: 'merchant_user', subjectId: user.id }), merchant: publicMerchant(merchant), user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

// Standalone registration: the listing service is free and active, paid services are only selected.
merchantAuthRouter.post('/register', validate({ body: registerBody }), asyncHandler(async (req, res) => {
  const { merchant, user } = await registerStandaloneMerchant(db, { ...req.body, services: req.body.services || [], ip: req.ip });
  res.status(201).json({ ...(await session(user, merchant)), entitlements: await listEntitlements(db, merchant.id) });
}));

merchantAuthRouter.post('/login', loginLimiter, validate({ body: z.object({ email: z.string().min(1).max(255), password: z.string().min(1) }) }), asyncHandler(async (req, res) => {
  const { user, merchant } = await authenticateMerchantUser(db, req.body);
  res.json(await session(user, merchant));
}));

// "Link my Moran AI account": the merchant's own Moran credentials, never a shared secret; a 2FA challenge is relayed.
const linkBody = z.object({ email: z.string().max(255).optional(), password: z.string().max(128).optional(), twoFactorCode: z.string().max(12).optional(), twoFactorToken: z.string().max(400).optional() });
merchantAuthRouter.post('/link-moran', loginLimiter, validate({ body: linkBody }), asyncHandler(async (req, res) => {
  const { moran } = merchantDeps();
  if (!moran.configured) throw new ApiError(503, 'MORAN_NOT_CONFIGURED', 'The Moran AI connection is not configured on this server.');
  const out = await linkMoranAccount(db, moran, { ...req.body, existingMerchantId: null, ip: req.ip });
  if (out.twoFactorRequired) return res.status(202).json({ twoFactorRequired: true, twoFactorToken: out.twoFactorToken });
  res.status(201).json({ ...(await session(out.user, out.merchant)), moranServices: out.services, entitlements: await listEntitlements(db, out.merchant.id) });
}));

// A signed-in standalone merchant links its existing MoranBuy account to Moran and keeps its listings and identity.
merchantAuthRouter.post('/link-moran/attach', requireMerchantAuth(db), validate({ body: linkBody }), asyncHandler(async (req, res) => {
  const { moran } = merchantDeps();
  if (!moran.configured) throw new ApiError(503, 'MORAN_NOT_CONFIGURED', 'The Moran AI connection is not configured on this server.');
  const out = await linkMoranAccount(db, moran, { ...req.body, existingMerchantId: req.merchant.id, ip: req.ip });
  if (out.twoFactorRequired) return res.status(202).json({ twoFactorRequired: true, twoFactorToken: out.twoFactorToken });
  res.json({ merchant: publicMerchant(out.merchant), moranServices: out.services });
}));

merchantAuthRouter.post('/refresh', validate({ body: z.object({ refreshToken: z.string().min(20) }) }), asyncHandler(async (req, res) => {
  const rotated = await rotateRefreshToken(db, req.body.refreshToken);
  if (!rotated || rotated.subjectType !== 'merchant_user') throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Sign in again.');
  const user = await db('merchant_users').where({ id: rotated.subjectId }).first();
  const merchant = user && await db('merchants').where({ id: user.merchant_id }).first();
  if (!user?.is_active || merchant?.status !== 'active') throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Sign in again.');
  res.json({ accessToken: signAccessToken({ type: 'merchant', sub: user.id, merchantId: merchant.id, role: user.role, email: user.email }), refreshToken: rotated.refreshToken });
}));

merchantAuthRouter.post('/logout', requireMerchantAuth(db), asyncHandler(async (req, res) => {
  await revokeRefreshTokens(db, { subjectType: 'merchant_user', subjectId: req.merchantUser.id });
  res.json({ ok: true });
}));

merchantAuthRouter.get('/me', requireMerchantAuth(db), asyncHandler(async (req, res) => {
  res.json({ merchant: publicMerchant(req.merchant), user: { id: req.merchantUser.id, name: req.merchantUser.name, email: req.merchantUser.email, role: req.merchantUser.role }, entitlements: await listEntitlements(db, req.merchant.id) });
}));
