import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '@moranbuy/core';

// Password hashing with bcrypt at a cost that is slow for attackers and fine for sign-in.
export const hashPassword = (password) => bcrypt.hash(String(password), 12);
export const verifyPassword = (password, hash) => (hash ? bcrypt.compare(String(password), hash) : Promise.resolve(false));

// AES-256-GCM for tokens MoranBuy must keep (a linked merchant's Moran refresh token); output is iv.tag.ciphertext in base64.
function key() { return Buffer.from(config().ENCRYPTION_KEY, 'hex'); }

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// SHA-256 hex of an opaque token, which is all the database ever stores.
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
