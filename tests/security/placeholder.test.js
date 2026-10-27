import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the example environment file holds no real-looking secrets', () => {
  const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC )?PRIVATE KEY/);
});
