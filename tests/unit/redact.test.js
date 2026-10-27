import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, maskPhone } from '@moranbuy/observability';

test('redact masks secret keys and phone numbers at any depth', () => {
  const out = redact({ apiKey: 'abc', nested: { password: 'x', note: 'call +255712345678 today' } });
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.nested.password, '[redacted]');
  assert.match(out.nested.note, /\+255…78/);
});

test('maskPhone keeps the country code and the last two digits', () => {
  assert.equal(maskPhone('255712345678'), '2557…78');
});
