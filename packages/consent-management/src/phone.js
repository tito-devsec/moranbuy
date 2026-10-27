// Normalises a Tanzanian (or international) number to digits in E.164 without the plus, Moran's msisdn form.
export function toMsisdn(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('255')) return d;
  if (d.startsWith('0') && d.length === 10) return `255${d.slice(1)}`;
  if (d.length === 9) return `255${d}`;
  return d;
}

export const isValidMsisdn = (v) => { const m = toMsisdn(v); return m.length >= 11 && m.length <= 15; };

const OPT_OUT = ['stop', 'unsubscribe', 'opt out', 'optout', 'usitume', 'sitaki', 'acha', 'ondoa', 'usinitumie', 'niondoe'];
const OPT_IN = ['start', 'subscribe', 'resume', 'anza', 'endelea', 'nataka ofa'];

// A whole-message keyword only, so "please don't stop the offers" is not read as an opt-out.
export function detectOptOut(text) { const c = String(text || '').trim().toLowerCase().replace(/[.!,?]+$/g, ''); return !!c && c.length <= 24 && OPT_OUT.includes(c); }
export function detectOptIn(text) { const c = String(text || '').trim().toLowerCase().replace(/[.!,?]+$/g, ''); return !!c && c.length <= 24 && OPT_IN.includes(c); }
