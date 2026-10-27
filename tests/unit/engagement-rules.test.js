import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOptOut, detectOptIn, toMsisdn } from '@moranbuy/consent-management';
import { priceCampaign } from '@moranbuy/billing';
import { validateTemplateDraft, senderEligibility, fallbackDraft } from '@moranbuy/campaign-engine';
import { followupMessage } from '@moranbuy/followup-engine';

test('opt-out keywords are read only as whole messages, in Swahili and English', () => {
  assert.equal(detectOptOut('STOP'), true);
  assert.equal(detectOptOut('sitaki.'), true);
  assert.equal(detectOptOut('please do not stop the offers'), false);
  assert.equal(detectOptIn('anza'), true);
  assert.equal(toMsisdn('0712 345 678'), '255712345678');
});

test('campaign pricing separates provider charges, the service fee and tax, and reports an unconfigured provider rate instead of guessing', () => {
  const unknown = priceCampaign({ recipients: 100 });
  assert.equal(unknown.providerTotal, null);
  assert.equal(unknown.estimatedTotal, null);
  assert.equal(unknown.pricingSource, 'provider_rate_not_configured');
  const known = priceCampaign({ recipients: 100, pricing: { providerUnitTzs: 60 } });
  assert.deepEqual([known.providerTotal, known.serviceFee, known.taxes, known.estimatedTotal], [6000, 2000, 360, 8360]);
});

test('template drafts must carry an opt-out line, media where a media header is declared, and ordered variables', () => {
  assert.deepEqual(validateTemplateDraft({ name: 'x', category: 'MARKETING', headerFormat: 'NONE', body: 'Ofa mpya. Jibu STOP kuacha.', buttons: [] }), []);
  const bad = validateTemplateDraft({ name: 'x', category: 'MARKETING', headerFormat: 'IMAGE', body: 'Ofa {{2}} mpya', buttons: [] });
  assert.deepEqual(bad.map((p) => p.field).sort(), ['body', 'body', 'headerMediaUrl']);
});

test('sender eligibility is never assumed: only a linked merchant with a connected number may dispatch', () => {
  assert.equal(senderEligibility({ registration_type: 'standalone' }).eligible, false);
  assert.equal(senderEligibility({ registration_type: 'moran', moran_tenant_id: 't', verification_json: { waConnection: 'disconnected' } }).reason, 'number_not_connected');
  assert.equal(senderEligibility({ registration_type: 'moran', moran_tenant_id: 't', verification_json: { waConnection: 'connected' } }).sender.tenantId, 't');
});

test('fallback drafts and follow-up messages use only the facts and include the opt-out line', () => {
  const d = fallbackDraft({ product: { name: 'Sofa L', price: 450000, currency: 'TZS' }, merchant: { name: 'Samaki', location: 'Mbezi' } }, { language: 'sw', kind: 'new_product_outreach' });
  assert.match(d, /Mpya Samaki: Sofa L kwa TSh 450,000/);
  assert.match(d, /Jibu STOP kuacha/);
  assert.match(followupMessage({ listing_name: 'Sofa L' }, { business_name: 'Samaki' }, 'en'), /STOP/);
});
