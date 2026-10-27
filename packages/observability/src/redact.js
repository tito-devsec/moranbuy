const SECRET_KEYS = /(secret|token|password|api[_-]?key|authorization)/i;
const PHONE_RE = /\+?\d[\d\s-]{8,}\d/g;
const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|mcp_[A-Za-z0-9]{8,}|EAA[A-Za-z0-9]{20,})/g;

// Returns a copy of an object with secret-looking keys and phone numbers masked, for logs and admin views.
export function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE_RE, '[redacted]').replace(PHONE_RE, (m) => `${m.slice(0, 4)}…${m.slice(-2)}`);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

// Masks a phone number to its country code and last two digits.
export function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 6) return '***';
  return `${s.slice(0, 4)}…${s.slice(-2)}`;
}
