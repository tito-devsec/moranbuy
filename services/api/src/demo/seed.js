import { logger } from '@moranbuy/observability';
import { db } from '../db/connection.js';

// The demo's sample shops around Dar es Salaam; the owners' numbers are reserved demo numbers, never real people.
export const DEMO_SHOPS = Object.freeze([
  { key: 'juma', name: 'Duka la Juma Electronics', owner: 'Juma Mussa', phone: '255700990001', lat: -6.7731, lng: 39.2262, area: 'Sinza Mori', fee: 3000, radius: 15,
    items: [['Blender 1.5L glass jar', 'blender', 'appliances', 85000, { capacity: '1.5L', colour: 'black' }], ['Electric kettle 1.7L', 'kettle', 'appliances', 45000, {}], ['Steam iron', 'iron', 'appliances', 38000, {}]] },
  { key: 'mwenge', name: 'Mwenge Home Store', owner: 'Rehema Ally', phone: '255700990002', lat: -6.7676, lng: 39.2245, area: 'Mwenge', fee: 5000, radius: 20,
    items: [['Blender 2L with grinder', 'blender', 'appliances', 89000, { capacity: '2L' }], ['Gas cooker 4 burner', 'gas cooker', 'appliances', 480000, {}], ['3-seater sofa grey', 'sofa', 'furniture', 320000, { seats: 3, colour: 'grey' }]] },
  { key: 'sinza', name: 'Sinza Smart Shop', owner: 'Baraka John', phone: '255700990003', lat: -6.7781, lng: 39.2301, area: 'Sinza', fee: 2000, radius: 10,
    items: [['Mini blender 0.6L', 'blender', 'appliances', 62000, { capacity: '0.6L' }], ['Smartphone 128GB', 'smartphone', 'phones', 350000, { storage: '128GB' }], ['Smartphone 64GB', 'smartphone', 'phones', 260000, { storage: '64GB' }]] },
  { key: 'kariakoo', name: 'Kariakoo Wholesale Corner', owner: 'Said Hamisi', phone: '255700990004', lat: -6.8193, lng: 39.2737, area: 'Kariakoo', fee: null, radius: 30,
    items: [['Blender 1.5L plastic jar', 'blender', 'appliances', 70000, { capacity: '1.5L' }], ['Mattress 5x6 high density', 'mattress', 'furniture', 210000, {}], ['3-seater sofa leather', 'sofa', 'furniture', 420000, { seats: 3 }]] },
  { key: 'masaki', name: 'Masaki Premium Living', owner: 'Grace Peter', phone: '255700990005', lat: -6.7486, lng: 39.2824, area: 'Masaki', fee: 15000, radius: 25,
    items: [['Professional blender 2L', 'blender', 'appliances', 165000, { capacity: '2L' }], ['Smart TV 43 inch', 'television', 'electronics', 690000, {}]] },
]);

const DEMO_TAG = 'demo_sandbox';

// Creates the sample shops once; running it again changes nothing, so every restart of the demo starts from the same catalogue.
export async function seedDemoShops(dbImpl = db) {
  let created = 0;
  for (const s of DEMO_SHOPS) {
    let m = await dbImpl('merchants').where({ contact_phone: s.phone }).first();
    if (!m) {
      [m] = await dbImpl('merchants').insert({ registration_type: 'standalone', business_name: s.name, slug: `demo-${s.key}`, verification_status: 'verified', status: 'active', contact_phone: s.phone, owner_name: s.owner, payout_phone: s.phone, settings_json: JSON.stringify({ demo: DEMO_TAG, language: 'sw' }) }).returning('*');
      await dbImpl('merchant_locations').insert({ merchant_id: m.id, name: `${s.name}`, region: 'Dar es Salaam', district: s.area, latitude: s.lat, longitude: s.lng, location_source: 'USER_PIN', formatted_address: `${s.area}, Dar es Salaam`, delivery_available: true, delivery_fee: s.fee, delivery_radius_km: s.radius, is_default: true });
      for (const [name, productType, category, price, attributes] of s.items) {
        await dbImpl('listings').insert({ merchant_id: m.id, name, product_type: productType, category, price, attributes: JSON.stringify(attributes), stock: 6, status: 'active', source: 'moranbuy' });
      }
      created += 1;
    }
  }
  if (created) logger.info({ created }, 'Demo shops seeded');
  return created;
}

export const demoShopByPhone = (phone) => DEMO_SHOPS.find((s) => s.phone === phone) || null;
