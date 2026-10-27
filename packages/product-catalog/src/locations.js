import { z } from 'zod';
import { ApiError, notFound } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';

export const locationInput = z.object({
  name: z.string().trim().min(2).max(120),
  country: z.string().length(2).optional(),
  region: z.string().max(100).nullable().optional(),
  district: z.string().max(100).nullable().optional(),
  ward: z.string().max(100).nullable().optional(),
  street: z.string().max(200).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  pickupAvailable: z.boolean().optional(),
  deliveryAvailable: z.boolean().nullable().optional(),
  deliveryRadiusKm: z.number().int().positive().max(2000).nullable().optional(),
  deliveryFee: z.number().int().nonnegative().nullable().optional(),
  deliveryNotes: z.string().max(500).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export function publicLocation(r) {
  if (!r) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id, merchantId: r.merchant_id, name: r.name, country: r.country, region: r.region, district: r.district, ward: r.ward, street: r.street, address: r.address,
    formattedAddress: r.formatted_address, latitude: num(r.latitude), longitude: num(r.longitude), source: r.location_source, pickupAvailable: r.pickup_available,
    deliveryAvailable: r.delivery_available, deliveryRadiusKm: r.delivery_radius_km, deliveryFee: r.delivery_fee, deliveryNotes: r.delivery_notes, isDefault: r.is_default,
    origin: r.source, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listLocations(db, merchantId) {
  const rows = await db('merchant_locations').where({ merchant_id: merchantId }).whereNull('deleted_at').orderBy('is_default', 'desc').orderBy('created_at');
  return rows.map(publicLocation);
}

// Builds the stored row: a pin the merchant placed wins; otherwise the typed address is geocoded, and a place nobody can find stays without coordinates.
async function resolvePosition(input, geocoder) {
  const country = (input.country || 'TZ').toUpperCase();
  if (input.latitude !== null && input.latitude !== undefined && input.longitude !== null && input.longitude !== undefined) {
    return { latitude: input.latitude, longitude: input.longitude, location_source: 'USER_PIN', formatted_address: [input.street, input.ward, input.district, input.region].filter(Boolean).join(', ') || input.address || null, geocoded: false };
  }
  const text = [input.address, input.street, input.ward, input.district, input.region].filter(Boolean).join(', ');
  const found = text && geocoder ? await geocoder.geocode(`${text}, ${country}`).catch(() => null) : null;
  if (found) return { latitude: found.lat, longitude: found.lng, location_source: 'GEOCODED', formatted_address: found.label || text, geocoded: true };
  return { latitude: null, longitude: null, location_source: input.address || text ? 'USER_ADDRESS' : null, formatted_address: text || null, geocoded: false };
}

export async function createLocation(db, merchantId, input, { geocoder = null, actorId, ip = null }) {
  const pos = await resolvePosition(input, geocoder);
  return db.transaction(async (trx) => {
    const count = await trx('merchant_locations').where({ merchant_id: merchantId }).whereNull('deleted_at').count('id as n').first();
    const isDefault = input.isDefault ?? Number(count.n) === 0;
    if (isDefault) await trx('merchant_locations').where({ merchant_id: merchantId }).update({ is_default: false });
    const [row] = await trx('merchant_locations').insert({
      merchant_id: merchantId, name: input.name, country: (input.country || 'TZ').toUpperCase(), region: input.region || null, district: input.district || null, ward: input.ward || null, street: input.street || null, address: input.address || null,
      formatted_address: pos.formatted_address, latitude: pos.latitude, longitude: pos.longitude, location_source: pos.location_source,
      pickup_available: input.pickupAvailable ?? true, delivery_available: input.deliveryAvailable ?? null, delivery_radius_km: input.deliveryRadiusKm ?? null, delivery_fee: input.deliveryFee ?? null, delivery_notes: input.deliveryNotes || null, is_default: isDefault,
    }).returning('*');
    await audit(trx, { actorType: 'merchant', actorId, merchantId, action: 'location.created', targetType: 'location', targetId: row.id, after: { name: row.name, source: row.location_source }, ip });
    return { ...publicLocation(row), positionFound: pos.latitude !== null };
  });
}

export async function updateLocation(db, merchantId, id, input, { geocoder = null, actorId, ip = null }) {
  const current = await db('merchant_locations').where({ id, merchant_id: merchantId }).whereNull('deleted_at').first();
  if (!current) throw notFound('LOCATION_NOT_FOUND', 'That location was not found.');
  if (current.source === 'moran') throw new ApiError(409, 'FIELD_OWNED_BY_MORAN', 'This location comes from Moran AI; edit it there. Delivery settings can be set on a MoranBuy location.');
  const merged = { ...publicLocation(current), ...input };
  const addressChanged = ['address', 'street', 'ward', 'district', 'region', 'latitude', 'longitude'].some((k) => input[k] !== undefined);
  const pos = addressChanged ? await resolvePosition(merged, geocoder) : { latitude: current.latitude, longitude: current.longitude, location_source: current.location_source, formatted_address: current.formatted_address };
  return db.transaction(async (trx) => {
    if (input.isDefault) await trx('merchant_locations').where({ merchant_id: merchantId }).update({ is_default: false });
    const [row] = await trx('merchant_locations').where({ id }).update({
      name: merged.name, region: merged.region ?? null, district: merged.district ?? null, ward: merged.ward ?? null, street: merged.street ?? null, address: merged.address ?? null,
      formatted_address: pos.formatted_address, latitude: pos.latitude, longitude: pos.longitude, location_source: pos.location_source,
      pickup_available: merged.pickupAvailable ?? true, delivery_available: merged.deliveryAvailable ?? null, delivery_radius_km: merged.deliveryRadiusKm ?? null, delivery_fee: merged.deliveryFee ?? null, delivery_notes: merged.deliveryNotes ?? null,
      is_default: input.isDefault ? true : current.is_default, updated_at: trx.fn.now(),
    }).returning('*');
    await audit(trx, { actorType: 'merchant', actorId, merchantId, action: 'location.updated', targetType: 'location', targetId: id, before: { deliveryFee: current.delivery_fee }, after: { deliveryFee: row.delivery_fee }, ip });
    return publicLocation(row);
  });
}

export async function deleteLocation(db, merchantId, id, { actorId, ip = null }) {
  const current = await db('merchant_locations').where({ id, merchant_id: merchantId }).whereNull('deleted_at').first();
  if (!current) throw notFound('LOCATION_NOT_FOUND', 'That location was not found.');
  await db('merchant_locations').where({ id }).update({ deleted_at: db.fn.now(), is_default: false });
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'location.deleted', targetType: 'location', targetId: id, ip });
}
