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
  // The configured country is tried first; a place not found there is looked up worldwide, so a customer abroad is placed in their own country.
  async geocode(text) {
    const q = String(text || '').trim();
    if (!q) return null;
    for (const scope of [`&countrycodes=${this.country.toLowerCase()}`, '']) {
      const url = `${this.baseUrl}/search?format=jsonv2&limit=1&addressdetails=1${scope}&q=${encodeURIComponent(q)}`;
      const res = await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const rows = await res.json().catch(() => []);
      const hit = rows?.[0];
      if (hit) return { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name, country: hit.address?.country_code ? String(hit.address.country_code).toUpperCase() : this.country };
    }
    return null;
  }

  // A shared map pin: returns { label, city, country } for coordinates, or null; the country code is upper case (TZ).
  async reverse(lat, lng) {
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
    const url = `${this.baseUrl}/reverse?format=jsonv2&zoom=14&lat=${Number(lat)}&lon=${Number(lng)}`;
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const hit = await res.json().catch(() => null);
    if (!hit?.display_name) return null;
    const a = hit.address || {};
    return { label: hit.display_name, city: a.city || a.town || a.county || a.state || null, country: a.country_code ? String(a.country_code).toUpperCase() : null };
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
  // The nearest known place within about five kilometres answers a shared pin.
  async reverse(lat, lng) {
    this.calls.push(`reverse:${lat},${lng}`);
    const hit = Object.values(this.map).find((v) => Math.abs(v.lat - lat) < 0.05 && Math.abs(v.lng - lng) < 0.05);
    return hit ? { label: hit.label, city: null, country: hit.country || 'TZ' } : null;
  }
}
