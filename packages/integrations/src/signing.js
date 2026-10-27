import crypto from 'node:crypto';

// HMAC-SHA256 over `${timestamp}.${rawBody}`; the same scheme Moran's payment webhook already uses.
export function signBody(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { timestamp: String(timestamp), signature };
}

// Verifies a signed body in constant time and rejects timestamps older than five minutes.
export function verifySignedBody(secret, rawBody, timestamp, signature, { maxAgeSeconds = 300, now = Date.now } = {}) {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(now() / 1000) - ts) > maxAgeSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
