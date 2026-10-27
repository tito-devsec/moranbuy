// Money is handled as whole minor units (TZS has none, so an integer number of shillings).
export function toMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Amount must be a non-negative number');
  return Math.round(n);
}

// Formats an integer amount with thousands separators, e.g. "TSh 350,000".
export function formatMoney(amount, currency = 'TZS') {
  const label = currency === 'TZS' ? 'TSh' : currency;
  return `${label} ${Number(amount).toLocaleString('en-US')}`;
}

// Adds known amounts and reports whether any part of the total was unknown.
export function sumKnown(parts) {
  let total = 0;
  let unknown = false;
  for (const p of parts) {
    if (p === null || p === undefined) unknown = true;
    else total += Number(p);
  }
  return { total, unknown };
}
