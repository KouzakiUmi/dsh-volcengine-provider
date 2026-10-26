import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createAdapterLease, leasedStream } from '../src/adapter-lease.mjs';

function fixture() {
  let disposals = 0;
  const lease = createAdapterLease(async () => { disposals++; });
  return { lease, count: () => disposals };
}

test('retired scopes stay alive until every held call releases them', async () => {
  const { lease, count } = fixture();
  const first = lease.retain(), second = lease.retain();
  await lease.retire(); assert.equal(count(), 0);
  await first(); await first(); assert.equal(count(), 0); assert.equal(lease.references, 1);
  await second(); assert.equal(count(), 1); assert.equal(lease.closed, true);
  await lease.dispose(); assert.equal(count(), 1);
  assert.throws(() => lease.retain(), /卸载/);
});

test('unused retired scopes close immediately and force disposal is idempotent', async () => {
  const idle = fixture(); await idle.lease.retire(); assert.equal(idle.count(), 1);
  const active = fixture(); const release = active.lease.retain();
  await active.lease.dispose(); assert.equal(active.count(), 1);
  await release(); await active.lease.dispose(); assert.equal(active.count(), 1);
});

test('completed and failed streams release retired scopes', async () => {
  const complete = fixture();
  const stream = leasedStream(async function* () { yield 1; }, complete.lease);
  await complete.lease.retire();
  const values = []; for await (const value of stream) values.push(value);
  assert.deepEqual(values, [1]); assert.equal(complete.count(), 1);
  const failed = fixture();
  const errorStream = leasedStream(async function* () { throw new Error('fixture error'); }, failed.lease);
  await failed.lease.retire();
  await assert.rejects(() => errorStream.next(), /fixture error/);
  assert.equal(failed.count(), 1);
});

test('early return also releases a stream that was never started', async () => {
  const { lease, count } = fixture();
  const stream = leasedStream(async function* () { yield 1; }, lease);
  await lease.retire(); await stream.return();
  assert.equal(count(), 1); assert.equal(lease.references, 0);
});

test('returning an active stream and throwing into an unused one release both', async () => {
  const active = fixture();
  const stream = leasedStream(async function* () { yield 1; yield 2; }, active.lease);
  await stream.next(); await active.lease.retire(); await stream.return(); assert.equal(active.count(), 1);
  const unused = fixture();
  const other = leasedStream(async function* () { yield 1; }, unused.lease);
  await unused.lease.retire(); await assert.rejects(() => other.throw(new Error('cancelled')), /cancelled/);
  assert.equal(unused.count(), 1);
});

test('reported cleanup errors do not replace a completed stream or its original error', async () => {
  const reports = [];
  const complete = createAdapterLease(async () => { throw new Error('cleanup failed'); }, error => reports.push(error.message));
  const stream = leasedStream(async function* () { yield 'done'; }, complete);
  await complete.retire();
  const values = []; for await (const value of stream) values.push(value);
  assert.deepEqual(values, ['done']);
  const original = new Error('original stream error');
  const failed = createAdapterLease(async () => { throw new Error('cleanup failed again'); }, error => reports.push(error.message));
  const failure = leasedStream(async function* () { throw original; }, failed);
  await failed.retire();
  await assert.rejects(() => failure.next(), error => error === original);
  assert.deepEqual(reports, ['cleanup failed', 'cleanup failed again']);
});

test('real garbage collection releases an abandoned stream without retaining its iterator', () => {
  const moduleUrl = new URL('../src/adapter-lease.mjs', import.meta.url).href;
  const source = `
    import {createAdapterLease, leasedStream} from ${JSON.stringify(moduleUrl)};
    let disposed = 0;
    const lease = createAdapterLease(async () => { disposed++; });
    const registry = new FinalizationRegistry(release => { void release(); });
    let weak;
    (() => { const iterator = leasedStream(async function* () { yield 1; }, lease, undefined, registry); weak = new WeakRef(iterator); })();
    await lease.retire();
    for (let i = 0; i < 300 && !disposed; i++) { global.gc(); await new Promise(resolve => setTimeout(resolve, 10)); }
    if (disposed !== 1 || lease.references !== 0 || weak.deref() !== undefined) throw Error('Abandoned iterator is still retained');
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'GC subprocess failed');
});

test('unconsumed stream cleanup can release its retained scope', async () => {
  const { lease, count } = fixture();
  let cleanup, token, unregistered;
  const finalizers = { register(_target, held, key) { cleanup = held; token = key; }, unregister(key) { unregistered = key; } };
  leasedStream(async function* () { yield 1; }, lease, undefined, finalizers);
  await lease.retire(); assert.equal(count(), 0);
  await cleanup(); assert.equal(count(), 1); assert.equal(unregistered, token);
});
