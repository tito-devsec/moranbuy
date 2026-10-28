// Numbers spelled out for speech: Meta's MMS voices read letters, not digits, so prices and counts are said in words.
const SW_ONES = ['', 'moja', 'mbili', 'tatu', 'nne', 'tano', 'sita', 'saba', 'nane', 'tisa'];
const SW_TENS = ['', 'kumi', 'ishirini', 'thelathini', 'arobaini', 'hamsini', 'sitini', 'sabini', 'themanini', 'tisini'];

function sw100(n) {
  const t = Math.floor(n / 10), u = n % 10;
  if (!t) return SW_ONES[u];
  return u ? `${SW_TENS[t]} na ${SW_ONES[u]}` : SW_TENS[t];
}

function sw1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  if (!h) return sw100(r);
  if (!r) return `mia ${SW_ONES[h]}`;
  return r < 10 ? `mia ${SW_ONES[h]} na ${SW_ONES[r]}` : `mia ${SW_ONES[h]} ${sw100(r)}`;
}

// 350000 is "laki tatu na elfu hamsini"; laki (100,000) is used the way Tanzanians say prices.
export function swahiliNumber(n) {
  n = Math.floor(Math.abs(Number(n)));
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'sifuri';
  if (n < 1000) return sw1000(n);
  if (n < 100000) {
    const r = n % 1000;
    return `elfu ${sw1000(Math.floor(n / 1000))}${r ? ` na ${sw1000(r)}` : ''}`;
  }
  if (n < 1000000) {
    const r = n % 100000;
    return `laki ${SW_ONES[Math.floor(n / 100000)]}${r ? ` na ${swahiliNumber(r)}` : ''}`;
  }
  if (n < 1e12) {
    const r = n % 1000000;
    return `milioni ${swahiliNumber(Math.floor(n / 1000000))}${r ? ` na ${swahiliNumber(r)}` : ''}`;
  }
  return String(n).split('').map((d) => (d === '0' ? 'sifuri' : SW_ONES[d])).join(' ');
}

const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function en1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  const tail = r < 20 ? EN_ONES[r] : `${EN_TENS[Math.floor(r / 10)]}${r % 10 ? ` ${EN_ONES[r % 10]}` : ''}`;
  if (!h) return tail;
  return `${EN_ONES[h]} hundred${r ? ` and ${tail}` : ''}`;
}

export function englishNumber(n) {
  n = Math.floor(Math.abs(Number(n)));
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'zero';
  if (n >= 1e12) return String(n).split('').map((d) => (d === '0' ? 'zero' : EN_ONES[d])).join(' ');
  const parts = [];
  for (const [size, word] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= size) { parts.push(`${en1000(Math.floor(n / size))} ${word}`); n %= size; }
  }
  if (n) parts.push(parts.length && n < 100 ? `and ${en1000(n)}` : en1000(n));
  return parts.join(' ');
}

// Every number in a sentence said in words, with the few units MoranBuy's replies use.
export function spellNumbers(text, language = 'sw') {
  const say = language === 'en' ? englishNumber : swahiliNumber;
  const point = language === 'en' ? 'point' : 'nukta';
  return String(text)
    .replace(/(\d)\s*km\b/gi, `$1 ${language === 'en' ? 'kilometres' : 'kilomita'}`)
    .replace(/(\d)\s*%/g, `$1 ${language === 'en' ? 'percent' : 'asilimia'}`)
    .replace(/\bkm\b/gi, language === 'en' ? 'kilometres' : 'kilomita')
    .replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, (m) => {
      const [whole, frac] = m.replace(/,/g, '').split('.');
      return ` ${say(Number(whole))}${frac ? ` ${point} ${frac.split('').map((d) => say(Number(d))).join(' ')}` : ''} `;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}
