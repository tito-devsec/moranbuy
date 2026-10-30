import { z } from 'zod';

const attrValue = z.union([z.string(), z.number(), z.boolean(), z.object({ min: z.number().optional(), max: z.number().optional() }), z.array(z.union([z.string(), z.number()]))]);

// The validated structured shopping request every engine stage works from.
export const shoppingRequestSchema = z.object({
  productType: z.string().trim().min(1).max(80).nullable().default(null),
  category: z.string().trim().max(40).nullable().default(null),
  essentialAttributes: z.record(attrValue).default({}),
  preferredAttributes: z.record(attrValue).default({}),
  maxBudget: z.number().int().positive().nullable().default(null),
  currency: z.string().length(3).default('TZS'),
  quantity: z.number().int().positive().max(1000).default(1),
  locationText: z.string().trim().max(200).nullable().default(null),
  location: z.object({ lat: z.number(), lng: z.number(), label: z.string().max(200).nullable().default(null), source: z.enum(['customer_pin', 'customer_text_geocoded', 'customer_shared']).default('customer_shared') }).nullable().default(null),
  fulfilment: z.enum(['delivery', 'pickup', 'any']).default('any'),
  alternativesOk: z.boolean().default(true),
  urgency: z.string().max(120).nullable().default(null),
  language: z.enum(['sw', 'en']).default('sw'),
});

// Merges a new extraction into the running request, keeping anything the customer already said.
export function mergeRequest(previous, extracted) {
  const prev = previous || {};
  const next = { ...prev };
  for (const [k, v] of Object.entries(extracted || {})) {
    if (v === null || v === undefined || v === '' || k === 'wantsAlternatives') continue;
    if (k === 'essentialAttributes' || k === 'preferredAttributes') next[k] = { ...(prev[k] || {}), ...v };
    else next[k] = v;
  }
  return shoppingRequestSchema.parse(next);
}
