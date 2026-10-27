import { z } from 'zod';
import { ApiError, notFound } from '@moranbuy/core';
import { audit } from '@moranbuy/observability';

// Meta's documented component limits, checked here before anything is submitted anywhere.
const LIMITS = { name: 512, header: 60, body: 1024, footer: 60, buttonText: 25, maxButtons: 10 };

export const templateInput = z.object({
  name: z.string().trim().min(1).max(LIMITS.name).regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and underscores only'),
  language: z.enum(['sw', 'en', 'en_US', 'en_GB']).default('sw'),
  category: z.enum(['MARKETING', 'UTILITY']).default('MARKETING'),
  headerFormat: z.enum(['NONE', 'TEXT', 'IMAGE', 'VIDEO']).default('NONE'),
  headerText: z.string().max(LIMITS.header).nullable().optional(),
  headerMediaUrl: z.string().url().max(600).nullable().optional(),
  body: z.string().min(1).max(LIMITS.body),
  footer: z.string().max(LIMITS.footer).nullable().optional(),
  buttons: z.array(z.object({ type: z.enum(['QUICK_REPLY', 'URL']), text: z.string().min(1).max(LIMITS.buttonText), url: z.string().url().optional() })).max(LIMITS.maxButtons).default([]),
});

// Deterministic checks on a template draft; returns field problems, empty when valid.
export function validateTemplateDraft(d) {
  const problems = [];
  if (d.headerFormat === 'TEXT' && !d.headerText) problems.push({ field: 'headerText', message: 'A text header needs text.' });
  if (['IMAGE', 'VIDEO'].includes(d.headerFormat) && !d.headerMediaUrl) problems.push({ field: 'headerMediaUrl', message: 'Upload a sample image or video; Meta reviews the template with it.' });
  if (d.headerFormat === 'IMAGE' && d.headerMediaUrl && !/\.(jpe?g|png)(\?|$)/i.test(d.headerMediaUrl)) problems.push({ field: 'headerMediaUrl', message: 'An image header must be a JPEG or PNG.' });
  if (d.headerFormat === 'VIDEO' && d.headerMediaUrl && !/\.(mp4|3gp)(\?|$)/i.test(d.headerMediaUrl)) problems.push({ field: 'headerMediaUrl', message: 'A video header must be MP4 or 3GP.' });
  if (d.category === 'MARKETING' && !/stop/i.test(d.body) && !/stop/i.test(d.footer || '')) problems.push({ field: 'body', message: 'A marketing message must tell people how to opt out (for example "Jibu STOP kuacha").' });
  const vars = (String(d.body).match(/\{\{\s*\d+\s*\}\}/g) || []).map((v) => Number(v.replace(/\D/g, '')));
  for (let i = 1; i <= vars.length; i += 1) if (!vars.includes(i)) problems.push({ field: 'body', message: `Variables must be numbered in order; {{${i}}} is missing.` });
  for (const b of d.buttons || []) if (b.type === 'URL' && !b.url) problems.push({ field: 'buttons', message: 'A URL button needs a URL.' });
  return problems;
}

export function publicTemplate(r) {
  if (!r) return null;
  return { id: r.id, merchantId: r.merchant_id, name: r.name, language: r.language, category: r.category, headerFormat: r.header_format, headerText: r.header_text, headerMediaUrl: r.header_media_url, body: r.body, footer: r.footer, buttons: r.buttons_json || [], status: r.status, provider: r.provider, providerTemplateId: r.provider_template_id, statusReason: r.status_reason, submittedAt: r.submitted_at, reviewedAt: r.reviewed_at, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listTemplates(db, merchantId) { return db('message_templates').where({ merchant_id: merchantId }).orderBy('updated_at', 'desc').then((rows) => rows.map(publicTemplate)); }

export async function saveTemplate(db, merchantId, input, { id = null, actorId, ip = null }) {
  const problems = validateTemplateDraft(input);
  if (problems.length) throw new ApiError(400, 'TEMPLATE_INVALID', 'The template needs changes before it can be submitted.', Object.fromEntries(problems.map((p) => [p.field, p.message])));
  const row = { merchant_id: merchantId, name: input.name, language: input.language, category: input.category, header_format: input.headerFormat, header_text: input.headerText || null, header_media_url: input.headerMediaUrl || null, body: input.body, footer: input.footer || null, buttons_json: JSON.stringify(input.buttons || []), updated_at: db.fn.now() };
  let saved;
  if (id) {
    const current = await db('message_templates').where({ id, merchant_id: merchantId }).first();
    if (!current) throw notFound('TEMPLATE_NOT_FOUND');
    if (['pending', 'approved'].includes(current.status)) throw new ApiError(409, 'TEMPLATE_LOCKED', 'A submitted or approved template cannot be edited; create a new one.');
    [saved] = await db('message_templates').where({ id }).update({ ...row, status: 'draft', status_reason: null }).returning('*');
  } else {
    [saved] = await db('message_templates').insert(row).returning('*');
  }
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: id ? 'template.updated' : 'template.created', targetType: 'template', targetId: saved.id, after: { name: saved.name, status: saved.status }, ip });
  return publicTemplate(saved);
}

// Submission goes through Moran for a linked merchant with the merchant's own token; a standalone merchant is told the real next step.
export async function submitTemplate(db, merchantId, id, { merchant, moran = null, moranToken = null, actorId, ip = null }) {
  const current = await db('message_templates').where({ id, merchant_id: merchantId }).first();
  if (!current) throw notFound('TEMPLATE_NOT_FOUND');
  if (merchant.registration_type !== 'moran' || !moran || !moranToken) {
    await db('message_templates').where({ id }).update({ status: 'unavailable', status_reason: 'Template submission needs a WhatsApp Business account. Link a Moran AI account with a connected number, then submit again.', updated_at: db.fn.now() });
    throw new ApiError(409, 'TEMPLATE_SUBMISSION_UNAVAILABLE', 'Template submission needs a WhatsApp Business account connected through Moran AI. Link your Moran AI account and connect your number, then submit again.');
  }
  const serviceId = merchant.moran_services_json?.[0]?.id || null;
  const draft = { name: current.name, category: current.category, language: current.language, messageType: 'DEFAULT', header: { format: current.header_format, ...(current.header_text ? { text: current.header_text } : {}), ...(current.header_media_url ? { mediaUrl: current.header_media_url } : {}) }, body: current.body, ...(current.footer ? { footer: current.footer } : {}), buttons: (current.buttons_json || []).map((b) => ({ type: b.type, text: b.text, ...(b.url ? { url: b.url } : {}) })) };
  const created = await moran.createTemplate(moranToken, serviceId, draft);
  if (!created.ok) throw new ApiError(502, 'MORAN_TEMPLATE_REJECTED', created.data?.message || 'Moran AI did not accept the template draft.', created.data?.errors);
  const providerId = created.data?.template?.id;
  const submitted = await moran.submitTemplate(moranToken, providerId);
  const status = submitted.ok ? String(submitted.data?.template?.status || 'PENDING').toLowerCase() : 'draft';
  const [row] = await db('message_templates').where({ id }).update({ provider: 'moran', provider_template_id: providerId, status: ['pending', 'approved', 'rejected', 'paused'].includes(status) ? status : 'pending', status_reason: submitted.ok ? null : submitted.data?.message || 'Submission failed', submitted_at: submitted.ok ? db.fn.now() : null, updated_at: db.fn.now() }).returning('*');
  await audit(db, { actorType: 'merchant', actorId, merchantId, action: 'template.submitted', targetType: 'template', targetId: id, after: { providerTemplateId: providerId, status: row.status, ok: submitted.ok }, ip });
  if (!submitted.ok) throw new ApiError(502, submitted.data?.error || 'MORAN_SUBMIT_FAILED', submitted.data?.message || 'Meta did not accept the submission.');
  return publicTemplate(row);
}

// Refreshes the status from Moran; Moran's status is Meta's, MoranBuy never sets approved itself.
export async function refreshTemplateStatus(db, merchantId, id, { moran, moranToken }) {
  const current = await db('message_templates').where({ id, merchant_id: merchantId }).first();
  if (!current?.provider_template_id) return publicTemplate(current);
  const r = await moran.getTemplate(moranToken, current.provider_template_id);
  if (!r.ok) return publicTemplate(current);
  const status = String(r.data?.template?.status || current.status).toLowerCase();
  const [row] = await db('message_templates').where({ id }).update({ status: ['pending', 'approved', 'rejected', 'paused', 'disabled'].includes(status) ? status : current.status, status_reason: r.data?.template?.rejection_reason || r.data?.template?.rejectionReason || null, reviewed_at: ['approved', 'rejected'].includes(status) ? db.fn.now() : current.reviewed_at, updated_at: db.fn.now() }).returning('*');
  return publicTemplate(row);
}
