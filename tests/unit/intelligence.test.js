import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlace, TANZANIA_REGIONS } from '@moranbuy/location-ranking';
import { fallbackExtractProduct } from '@moranbuy/muse-intelligence';
import { fallbackTiming, dueFromWords } from '@moranbuy/reverse-marketplace';

test('places resolve to a region and district, longest name first, unknown stays null', () => {
  assert.deepEqual(resolvePlace('Nipo Sinza, Dar es Salaam'), { region: 'Dar es Salaam', district: 'Kinondoni', matched: 'sinza' });
  assert.equal(resolvePlace('mbezi beach').district, 'Kinondoni');
  assert.equal(resolvePlace('Mbezi').district, 'Ubungo');
  assert.equal(resolvePlace('Njiro, Arusha').district, 'Arusha City');
  assert.deepEqual(resolvePlace('Mwanza'), { region: 'Mwanza', district: 'Nyamagana', matched: 'mwanza' });
  assert.equal(resolvePlace('Dodoma').region, 'Dodoma');
  assert.equal(resolvePlace('somewhere far').region, null);
  assert.equal(TANZANIA_REGIONS.length, 31);
});

test('a product sent by chat is read without a model: name, price words, stock, seats and type', () => {
  const p = fallbackExtractProduct('Bidhaa: Sofa ya watu 3 kijivu, bei laki 3, idadi 5');
  assert.equal(p.name, 'Sofa ya watu 3 kijivu');
  assert.equal(p.price, 300000);
  assert.equal(p.stock, 5);
  assert.equal(p.productType, 'sofa');
  assert.equal(p.category, 'furniture');
  assert.deepEqual(p.attributes, { seats: 3, color: 'kijivu' });
  const q = fallbackExtractProduct('Product: Samsung A15 phone, price 420,000, used');
  assert.equal(q.price, 420000);
  assert.equal(q.productType, 'smartphone');
  assert.equal(q.condition, 'used');
  assert.equal(fallbackExtractProduct('Bidhaa:').name, null);
});

test('purchase timing and schedules are read from the words when Muse is off', () => {
  assert.deepEqual(fallbackTiming('Naangalia tu bei'), { purchaseTiming: 'browsing', schedule: null });
  const t = fallbackTiming('Nitanunua wiki ijayo nikilipwa');
  assert.equal(t.purchaseTiming, 'later');
  assert.equal(t.schedule.when, 'wiki ijayo');
  assert.equal(fallbackTiming('Nataka sofa sasa').purchaseTiming, null);
  const now = Date.UTC(2026, 9, 28, 12);
  assert.equal(dueFromWords('kesho', now).getTime(), now + 86400000);
  assert.equal(dueFromWords('next week', now).getTime(), now + 7 * 86400000);
  assert.equal(dueFromWords('nikipata pesa', now), null);
});
