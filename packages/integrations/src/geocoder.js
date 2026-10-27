import { config } from '@moranbuy/core';

// Nominatim lookups for a place the customer or merchant typed; one request per call, cached by the caller, never a guess.
export class Geocoder {
  constructor({ cfg = null, fetchImpl = globalThis.fetch } = {}) {
    const c = cfg || config();
    this.baseUrl = String(c.GEOCODER_BASE_URL).replace(/\/+$/, '');
    this.userAgent = `MoranBuy/0.1 (${c.GEOCODER_CONTACT_EMAIL || 'no-contact-set'})`;
    this.country = c.DEFAULT_COUNTRY;
    this.fetchImpl = fetchImpl;
  }

  // Returns { lat, lng, label } for a text address, or null when nothing was found.
  async geocode(text) {
    const q = String(text || '').trim();
    if (!q) return null;
    const url = `${this.baseUrl}/search?format=jsonv2&limit=1&countrycodes=${this.country.toLowerCase()}&q=${encodeURIComponent(q)}`;
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    const hit = rows?.[0];
    if (!hit) return null;
    return { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name };
  }
}

// A geocoder for tests that answers from a fixed map and records what was asked.
export class FakeGeocoder {
  constructor(map = {}) { this.map = map; this.calls = []; }
  async geocode(text) {
    this.calls.push(text);
    const key = Object.keys(this.map).find((k) => String(text).toLowerCase().includes(k.toLowerCase()));
    return key ? this.map[key] : null;
  }
}
