import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, verifySessionToken } from '../src/auth.js';

test('session token round-trips a user id', async () => {
  const token = await createSessionToken('user-1', 'long-test-secret');
  assert.equal(await verifySessionToken(token, 'long-test-secret'), 'user-1');
});

test('tampered session token is rejected', async () => {
  const token = await createSessionToken('user-1', 'long-test-secret');
  assert.equal(await verifySessionToken(token + 'x', 'long-test-secret'), null);
});
