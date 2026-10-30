// Reads a listing page for what the search left out: the product photo, a description and the listed price.
// Polite by design: robots.txt is obeyed, one page per result, 6 seconds and 1.5 MB at most, no logins, no forms.

const UA = 'MoranBuyBot/1.0 (+https://buy.moranai.co.tz)';
const robotsCache = new Map();

async function robotsAllows(fetchImpl, url) {
  const u = new URL(url);
  const key = u.origin;
  if (!robotsCache.has(key)) {
    let txt = '';
    try { const r = await fetchImpl(`${key}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(4000) }); txt = r.ok ? (await r.text()).slice(0, 200000) : ''; } catch { txt = ''; }
    // Only the rules for every robot ("User-agent: *") apply to MoranBuy.
    const rules = []; let applies = false;
    for (const line of txt.split(/\r?\n/)) {
      const [k, ...rest] = line.split(':'); const v = rest.join(':').trim(); const field = k.trim().toLowerCase();
      if (field === 'user-agent') applies = v === '*';
      else if (applies && field === 'disallow' && v) rules.push(v);
    }
    robotsCache.set(key, rules);
  }
  return !robotsCache.get(key).some((p) => u.pathname.startsWith(p.replace(/\*.*$/, '')));
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const meta = (html, prop) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i')); return m ? decode(m[1]) : null; };

// The product in a page's JSON-LD, if it has one.
function jsonLdProduct(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const items = [].concat(data?.['@graph'] || data);
    for (const it of items) {
      if (!it || !/Product/i.test([].concat(it['@type']).join(' '))) continue;
      const offer = [].concat(it.offers || [])[0] || {};
      const image = [].concat(it.image || [])[0];
      return { name: it.name || null, description: it.description || null, image: typeof image === 'object' ? image?.url : image || null, price: offer.price ?? offer.lowPrice ?? null, currency: offer.priceCurrency || null };
    }
  }
  return null;
}

// A link that really answers with an image (checked with a small ranged request).
export async function isImage(fetchImpl, url) {
  try {
    const r = await fetchImpl(url, { method: 'GET', headers: { 'User-Agent': UA, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(5000), redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    try { await r.body?.cancel?.(); } catch { /* ignore */ }
    return r.ok && /^image\/(jpe?g|png|webp|gif)/i.test(type);
  } catch { return false; }
}

export async function pageDetails(url, { fetchImpl = globalThis.fetch, checkImage = true } = {}) {
  try {
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'bad_url' };
    if (!(await robotsAllows(fetchImpl, url))) return { ok: false, reason: 'robots' };
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(6000), redirect: 'follow' });
    if (!r.ok) return { ok: false, reason: `http_${r.status}` };
    if (!/html/i.test(r.headers.get('content-type') || 'text/html')) return { ok: false, reason: 'not_html' };
    const reader = r.body?.getReader?.();
    let html = '';
    if (reader) {
      const dec = new TextDecoder(); let total = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; html += dec.decode(value, { stream: true }); if (total > 1_500_000) { try { await reader.cancel(); } catch { /* ignore */ } break; } }
    } else html = (await r.text()).slice(0, 1_500_000);
    const ld = jsonLdProduct(html);
    const base = r.url || url;
    const abs = (u) => { try { return u ? new URL(u, base).toString() : null; } catch { return null; } };
    let image = abs(ld?.image || meta(html, 'og:image') || meta(html, 'og:image:secure_url') || meta(html, 'twitter:image'));
    if (image && checkImage && !(await isImage(fetchImpl, image))) image = null;
    const description = decode(ld?.description || meta(html, 'og:description') || meta(html, 'description') || '').replace(/\s+/g, ' ').slice(0, 400) || null;
    const price = ld?.price !== null && ld?.price !== undefined && Number(ld.price) > 0 ? Math.round(Number(ld.price)) : null;
    return { ok: true, imageUrl: image, description, price, currency: ld?.currency || null, title: decode(ld?.name || meta(html, 'og:title') || '').slice(0, 300) || null };
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'error' };
  }
}

export function resetRobotsCacheForTests() { robotsCache.clear(); }
