// Shilling amounts the way Tanzanians write and say them: digits with k or m, and Swahili words ("laki tatu na nusu", "laki mbili na elfu hamsini").
const WORD_NUMBERS = { moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10, ishirini: 20, thelathini: 30, arobaini: 40, hamsini: 50, sitini: 60, sabini: 70, themanini: 80, tisini: 90, mia: 100, one: 1, two: 2, three: 3, four: 4, five: 5 };

// A count in words or digits, with Swahili tens joined by "na": "ishirini na tano" is 25.
function countOf(words) {
  const parts = String(words || '').trim().split(/\s+na\s+/);
  let total = 0;
  for (const p of parts) {
    const v = WORD_NUMBERS[p] ?? (/^\d+(\.\d+)?$/.test(p) ? Number(p) : null);
    if (v === null) return total || null;
    total += v;
  }
  return total || null;
}

export function parseShillings(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  let m = t.match(/(?:tsh|tzs|sh|shilingi)?\s*(\d+(?:\.\d+)?)\s*(m|mil|milioni|million|k|elfu|laki)?\b/g);
  let best = null;
  for (const chunk of m || []) {
    const mm = chunk.match(/(\d+(?:\.\d+)?)\s*(m|mil|milioni|million|k|elfu|laki)?/);
    if (!mm) continue;
    let n = Number(mm[1]);
    const unit = mm[2];
    // A number that is already a full amount keeps its value: "350000 laki" or "90000 elfu" is a slip of the tongue, not 35 billion.
    if (unit && n >= 1000) { if (best === null || n > best) best = Math.round(n); continue; }
    if (unit === 'laki') n *= 100000;
    else if (unit === 'k' || unit === 'elfu') n *= 1000;
    else if (unit) n *= 1000000;
    if (n >= 1000 && (best === null || n > best)) best = Math.round(n);
  }
  // Swahili also puts the unit first: "laki tatu", "laki 4", "milioni mbili".
  const UNITS = { laki: 100000, elfu: 1000, milioni: 1000000 };
  // "laki tatu na nusu" is 350,000; "laki mbili na elfu hamsini" is 250,000; "elfu ishirini na tano" is 25,000.
  const COUNT = '(?:\\d+(?:\\.\\d+)?|[a-z]+(?:\\s+na\\s+(?!nusu\\b|elfu\\b|laki\\b)[a-z]+)?)';
  for (const mm of t.matchAll(new RegExp(`\\b(laki|elfu|milioni)\\s+(${COUNT})(\\s+na\\s+nusu)?(?:\\s+na\\s+(laki|elfu)\\s+(${COUNT}))?`, 'g'))) {
    const count = countOf(mm[2]);
    if (count === null) continue;
    // "laki 350000" names the whole amount after the word: keep 350,000.
    if (count >= 1000) { if (best === null || count > best) best = Math.round(count); continue; }
    let n = (count + (mm[3] ? 0.5 : 0)) * UNITS[mm[1]];
    if (mm[4] && UNITS[mm[4]] < UNITS[mm[1]]) n += (countOf(mm[5]) || 0) * UNITS[mm[4]];
    n = Math.round(n);
    if (best === null || n > best) best = n;
  }
  return best;
}

