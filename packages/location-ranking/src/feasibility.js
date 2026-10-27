import { distanceKm, hasCoords } from './distance.js';

// Decides how convenient an offer's location is for this customer; every field is derived from known data or left null.
export function assessLocation({ customerLocation, offer, fulfilment = 'any' }) {
  const d = distanceKm(customerLocation, offer.location);
  const delivery = offer.delivery || {};
  let deliveryAvailable = delivery.available ?? null;
  // A known service radius with a known distance settles whether delivery reaches the customer.
  if (deliveryAvailable === true && d !== null && Number.isFinite(Number(delivery.radiusKm))) {
    deliveryAvailable = d <= Number(delivery.radiusKm);
  }
  const pickupAvailable = offer.pickup ?? (hasCoords(offer.location) ? true : null);
  const notes = [];
  if (d === null) notes.push('distance_unknown');
  if (deliveryAvailable === null) notes.push('delivery_unknown');
  if (delivery.fee === null || delivery.fee === undefined) notes.push('delivery_fee_unknown');

  let score = 50;
  if (d !== null) score = Math.max(0, 100 - Math.min(100, d * 3));
  if (fulfilment === 'delivery') {
    if (deliveryAvailable === true) score = Math.min(100, score + 25);
    else if (deliveryAvailable === false) score = Math.max(0, score - 40);
  } else if (fulfilment === 'pickup') {
    if (pickupAvailable === false) score = Math.max(0, score - 40);
  } else if (deliveryAvailable === true) {
    score = Math.min(100, score + 10);
  }
  return { distanceKm: d, deliveryAvailable, pickupAvailable, score: Math.round(score), notes };
}
