import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBudget } from '@moranbuy/reverse-marketplace';
import { greetingFor } from '../../packages/reverse-marketplace/src/engine.js';

test('Swahili budgets with "na nusu" and "na elfu ..." add up, in words or digits', () => {
  assert.equal(parseBudget('Nina laki tatu na nusu ya sofa'), 350000);
  assert.equal(parseBudget('bajeti laki 3 na nusu'), 350000);
  assert.equal(parseBudget('milioni moja na nusu'), 1500000);
  assert.equal(parseBudget('laki mbili na elfu hamsini'), 250000);
  assert.equal(parseBudget('laki nne na elfu 20'), 420000);
  assert.equal(parseBudget('elfu ishirini na tano'), 25000);
  // Unchanged forms still read the same.
  assert.equal(parseBudget('Nina laki tatu ya sofa'), 300000);
  assert.equal(parseBudget('TSh 350,000'), 350000);
  assert.equal(parseBudget('nataka sofa na nusu saa'), null);
});

test('the greeting names the agent once, whatever name the admin chose', () => {
  assert.equal(greetingFor({ name: 'MoranBuy' }, 'sw'), 'Habari, mimi ni MoranBuy.');
  assert.equal(greetingFor({ name: 'MoranBuy' }, 'en'), 'Hello, I am MoranBuy.');
  assert.equal(greetingFor({ name: 'Moranbuy Assistant' }, 'sw'), 'Habari, mimi ni Moranbuy Assistant.');
  assert.equal(greetingFor({ name: 'Neema' }, 'sw'), 'Habari, mimi ni Neema wa MoranBuy.');
  assert.equal(greetingFor({ name: 'Neema' }, 'en'), 'Hello, I am Neema from MoranBuy.');
  assert.equal(greetingFor({ name: 'Neema', greetingSw: 'Karibu MoranBuy!' }, 'sw'), 'Karibu MoranBuy!');
});

test('a business product price uses the same Swahili amount reader as customer budgets', async () => {
  const { fallbackExtractProduct } = await import('@moranbuy/muse-intelligence');
  const p = fallbackExtractProduct('Bidhaa: Kabati la nguo milango 3, bei laki 2 na elfu hamsini, idadi 4');
  assert.equal(p.price, 250000);
  assert.equal(p.stock, 4);
  assert.equal(fallbackExtractProduct('Bidhaa: Meza, bei laki 4 na nusu, idadi 2').price, 450000);
  assert.equal(fallbackExtractProduct('Product: Samsung A15 phone, price 420,000, used').price, 420000);
  assert.equal(fallbackExtractProduct('Bidhaa: Sofa ya watu 3, bei 250k').price, 250000);
  // The seat count is not mistaken for a price.
  assert.equal(fallbackExtractProduct('Bidhaa: Sofa ya watu 3, idadi 2').price, null);
});

test('the signed channel to Moran uses the private address when one is set, else the public one', async () => {
  const { MoranInternalClient } = await import('@moranbuy/integrations');
  const base = { MORAN_SHARED_SECRET: 'x'.repeat(32) };
  assert.equal(new MoranInternalClient({ cfg: { ...base, MORAN_BACKEND_BASE_URL: 'https://api.example', MORAN_INTERNAL_BASE_URL: 'http://backend:3000/' } }).baseUrl, 'http://backend:3000');
  assert.equal(new MoranInternalClient({ cfg: { ...base, MORAN_BACKEND_BASE_URL: 'https://api.example' } }).baseUrl, 'https://api.example');
});
