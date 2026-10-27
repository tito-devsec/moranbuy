const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

// Great-circle distance in kilometres between two coordinates, or null when either side is missing.
export function distanceKm(a, b) {
  if (!hasCoords(a) || !hasCoords(b)) return null;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R_KM * Math.asin(Math.sqrt(h)) * 10) / 10;
}

// True when a point has finite latitude and longitude.
export function hasCoords(p) {
  return !!p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
}
