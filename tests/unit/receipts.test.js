import test from 'node:test';
import assert from 'node:assert/strict';
import { amountValue } from '@moranbuy/billing';
import { renderReceiptPdf, receiptSummary, checkCode, receiptNumber, eatDate } from '../../services/api/src/services/protection/receipts.js';

const facts = { receiptNo: receiptNumber(7), orderRef: 'MB-7K2Q9P', ...eatDate('2026-10-29T11:35:00Z'), businessName: 'Duka la Sinza', servedBy: 'Asha', servedRole: 'Owner', items: [{ name: 'Sofa', quantity: 1, unitPrice: 320000 }], deliveryFee: 10000, total: 330000, currency: 'TSh', method: 'M-Pesa', paymentRef: 'SNP-1', customerPhone: '255700000501', status: 'PAID - HELD BY MORANBUY' };

test('a receipt is a PDF whose QR summary names the business, who served, every item and the total, with a check code that changes when a figure is edited', async () => {
  assert.equal(facts.receiptNo, 'MB-R-000007');
  assert.deepEqual([facts.date, facts.time], ['29-10-2026', '14:35']);
  const opts = { secret: 's'.repeat(32), appUrl: 'https://buy.moranai.co.tz' };
  const r = await renderReceiptPdf(facts, opts);
  assert.equal(r.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(r.qrText, /Duka la Sinza \(served by Asha\)/);
  assert.match(r.qrText, /1x Sofa @ 320,000\.00/);
  assert.match(r.qrText, /TOTAL TSh 330,000\.00/);
  assert.match(r.qrText, /Customer 2557••••501/);
  assert.match(r.qrText, /Verify: https:\/\/buy\.moranai\.co\.tz\/r\/MB-R-000007\?c=/);
  assert.notEqual(checkCode(receiptSummary({ ...facts, total: 300000 }), opts.secret), r.checkCode);
});

test('Snippe amounts are read whether they come as a number or as { value, currency }', () => {
  assert.equal(amountValue(5000), 5000);
  assert.equal(amountValue({ value: 50000, currency: 'TZS' }), 50000);
  assert.equal(amountValue(null), null);
});
