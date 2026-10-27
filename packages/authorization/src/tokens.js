import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '@moranbuy/core';
import { sha256 } from './crypto.js';

const ACCESS_TTL = '15m';
const REFRESH_DAYS = 30;

// Short-lived access tokens; the subject type keeps merchant and admin sessions apart.
export function signAccessToken({ type, sub, merchantId = null, role = null, email = null }) {
  return jwt.sign({ type, sub, mid: merchantId, role, email }, config().AUTH_SECRET, { expiresIn: ACCESS_TTL, algorithm: 'HS256' });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config().AUTH_SECRET, { algorithms: ['HS256'] });
}

// Opaque refresh tokens stored only as a hash; rotation revokes the old one.
export async function issueRefreshToken(db, { subjectType, subjectId }) {
  const raw = crypto.randomBytes(48).toString('base64url');
  await db('refresh_tokens').insert({ subject_type: subjectType, subject_id: subjectId, token_hash: sha256(raw), expires_at: new Date(Date.now() + REFRESH_DAYS * 86400000) });
  return raw;
}

export async function rotateRefreshToken(db, raw) {
  const row = await db('refresh_tokens').where({ token_hash: sha256(raw) }).first();
  if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  await db('refresh_tokens').where({ id: row.id }).update({ revoked_at: db.fn.now() });
  const next = await issueRefreshToken(db, { subjectType: row.subject_type, subjectId: row.subject_id });
  return { subjectType: row.subject_type, subjectId: row.subject_id, refreshToken: next };
}

export async function revokeRefreshTokens(db, { subjectType, subjectId }) {
  await db('refresh_tokens').where({ subject_type: subjectType, subject_id: subjectId }).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}
