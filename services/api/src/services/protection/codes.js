import crypto from 'node:crypto';
import { config } from '@moranbuy/core';

// Handover codes: six characters without look-alikes (no 0/O, 1/I), about a billion possibilities, stored only as a keyed hash.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

export function hashCode(orderId, code, secret = null) {
  return crypto.createHmac('sha256', `handover:${secret || config().AUTH_SECRET}`).update(`${orderId}:${normalizeCode(code)}`).digest('hex');
}

export function codeMatches(orderId, code, hash, secret = null) {
  if (!hash) return false;
  const a = Buffer.from(hashCode(orderId, code, secret), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A six-character word in a message that could be a handover code; order references (MB-...) are ignored.
export function findCodeCandidate(text) {
  const words = String(text || '').toUpperCase().replace(/MB-[A-Z0-9]+/g, ' ').split(/[^A-Z0-9-]+/).map((w) => w.replace(/-/g, ''));
  return words.find((w) => w.length === CODE_LENGTH && /^[A-Z0-9]+$/.test(w)) || null;
}
