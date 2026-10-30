// Shops near the customer from Google's Places API (New): name, address, distance, opening hours, rating, phone, a photo and directions.
// Places has no prices or stock, so these are shown as "shops near you", never as priced offers. It is a maps service, not an AI model.

const FIELDS = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.rating', 'places.userRatingCount', 'places.nationalPhoneNumber', 'places.internationalPhoneNumber', 'places.currentOpeningHours.openNow', 'places.googleMapsUri', 'places.websiteUri', 'places.photos', 'places.businessStatus'].join(',');

const SHOP_WORDS = { smartphone: 'phone shop', laptop: 'computer shop', television: 'electronics shop', fridge: 'electronics shop', speaker: 'electronics shop', sofa: 'furniture shop', bed: 'furniture shop', mattress: 'mattress shop', cooker: 'home appliance shop', blender: 'home appliance shop', generator: 'generator shop' };

const km = (a, b) => { const R = 6371; const r = (d) => (d * Math.PI) / 180; const dLat = r(b.lat - a.lat); const dLng = r(b.lng - a.lng); const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

// "laptop" near Mbagala becomes "computer shop laptop"; a brand is added when the customer named one.
export function shopQuery(request) {
  const type = request.productType || 'shop';
  const kind = SHOP_WORDS[type] || `${type} shop`;
  const brand = request.essentialAttributes?.brand ? ` ${request.essentialAttributes.brand}` : '';
  return `${kind}${brand} ${type === kind ? '' : type}`.replace(/\s+/g, ' ').trim();
}

export async function searchNearbyShops({ fetchImpl = globalThis.fetch, apiKey, request, location, maxResults = 4, radiusM = 8000, recorder = null }) {
  if (!apiKey || !location) return { ok: false, status: !apiKey ? 'disabled' : 'no_location', shops: [] };
  const started = Date.now();
  const textQuery = shopQuery(request);
  try {
    const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify({ textQuery, maxResultCount: Math.min(10, maxResults + 2), languageCode: 'en', regionCode: 'TZ', locationBias: { circle: { center: { latitude: location.lat, longitude: location.lng }, radius: radiusM } } }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      await recorder?.({ feature: 'places_search', provider: 'google', model: 'places-v1', status: 'error', latencyMs: Date.now() - started, errorCode: `HTTP_${res.status}`, errorRedacted: String(data?.error?.message || '').slice(0, 300) });
      return { ok: false, status: 'error', code: `HTTP_${res.status}`, shops: [] };
    }
    const shops = [];
    for (const p of data.places || []) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      const at = p.location ? { lat: p.location.latitude, lng: p.location.longitude } : null;
      shops.push({
        placeId: p.id,
        name: p.displayName?.text || 'Shop',
        address: p.formattedAddress || null,
        distanceKm: at ? Math.round(km(location, at) * 10) / 10 : null,
        rating: p.rating ?? null,
        ratings: p.userRatingCount ?? null,
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
        openNow: p.currentOpeningHours?.openNow ?? null,
        mapsUrl: p.googleMapsUri || null,
        website: p.websiteUri || null,
        photoName: p.photos?.[0]?.name || null,
      });
    }
    shops.sort((a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99));
    const top = shops.slice(0, maxResults);
    // A photo link that does not carry the key: Google returns a public image address for the photo.
    for (const s of top) {
      if (!s.photoName) continue;
      try {
        const r = await fetchImpl(`https://places.googleapis.com/v1/${s.photoName}/media?maxWidthPx=800&skipHttpRedirect=true`, { headers: { 'X-Goog-Api-Key': apiKey }, signal: AbortSignal.timeout(6000) });
        const j = await r.json().catch(() => ({}));
        s.photoUrl = r.ok && /^https:\/\//.test(j.photoUri || '') ? j.photoUri : null;
      } catch { s.photoUrl = null; }
      delete s.photoName;
    }
    for (const s of top) delete s.photoName;
    await recorder?.({ feature: 'places_search', provider: 'google', model: 'places-v1', status: 'ok', latencyMs: Date.now() - started });
    return { ok: true, status: 'ok', shops: top, query: textQuery };
  } catch (err) {
    await recorder?.({ feature: 'places_search', provider: 'google', model: 'places-v1', status: 'error', latencyMs: Date.now() - started, errorCode: err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', errorRedacted: err.message });
    return { ok: false, status: 'error', shops: [] };
  }
}
