import test from 'node:test';
import assert from 'node:assert/strict';
import { account } from '../src/state.mjs';
import { parseCodingUsage } from '../src/quota.mjs';

test('OAuth-only accounts need no irrelevant IAM or inference references', () => {
  const owner = account({ id: 'oauth-only', label: 'OAuth账号' });
  assert.deepEqual(owner.apiKeyRefs, {});
  assert.equal(owner.accessKeyRef, '');
  assert.equal(owner.secretKeyRef, '');
  assert.equal(account({ id: 'empty', label: '空引用', accessKeyRef: '', secretKeyRef: '' }).accessKeyRef, '');
});
test('unknown quota levels cannot address inherited Object properties', () => {
  assert.deepEqual(parseCodingUsage({ Result: { QuotaUsage: [{ Level: 'constructor', Percent: 0 }] } }).windows, []);
});
test('reserved account IDs cannot address inherited Object properties', () => {
  for (const id of ['constructor', 'prototype', '__proto__']) assert.throws(() => account({ id, label: 'invalid' }), /账号 ID/);
});
