import { randomUUID, randomBytes } from 'node:crypto';

// A fresh UUID v4.
export const newId = () => randomUUID();

// A short human-friendly reference such as "MB-7K2P9Q".
export function shortRef(prefix = 'MB') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}-${out}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// True when the value looks like a UUID.
export const isUuid = (v) => UUID_RE.test(String(v || ''));
