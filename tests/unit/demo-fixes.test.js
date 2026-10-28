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
