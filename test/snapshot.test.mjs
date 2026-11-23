// src/snapshot.mjs 的隔离测试：额度中间层的落盘、加载与失效规则。
// 全部使用 mkdtemp 临时目录，不读写真实数据目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuotaSnapshotStore, SNAPSHOT_VERSION } from '../src/snapshot.mjs';

const dirs = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-volc-snapshot-'));
  dirs.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test('快照落盘后可通过新实例恢复，且只保留展示字段', async () => {
  const dir = await tempDir();
  const path = join(dir, 'quota-snapshot.json');
  const store = new QuotaSnapshotStore({ path });
  store.set('default:agent-plan', 'fingerprint-1', {
    accountId: 'default', plan: 'agent-plan', state: 'ok', updatedAt: '2026-11-20T00:00:00Z',
    windows: [{ kind: '5h', percent: 10 }],
    secret: 'SHOULD-NOT-PERSIST',
    raw: { token: 'SHOULD-NOT-PERSIST' }
  });
  await store.whenIdle();

  const reloaded = new QuotaSnapshotStore({ path });
  await reloaded.load();
  const entry = reloaded.get('default:agent-plan', 'fingerprint-1');
  assert.ok(entry, '新实例应恢复快照');
  assert.equal(entry.value.state, 'ok');
  assert.deepEqual(entry.value.windows, [{ kind: '5h', percent: 10 }]);
  assert.equal(Object.hasOwn(entry.value, 'secret'), false);
  assert.equal(Object.hasOwn(entry.value, 'raw'), false);
  const disk = await readFile(path, 'utf8');
  assert.doesNotMatch(disk, /SHOULD-NOT-PERSIST/);
});

test('身份指纹不匹配时快照不可见，避免账号切换串用旧结果', async () => {
  const dir = await tempDir();
  const path = join(dir, 'quota-snapshot.json');
  const store = new QuotaSnapshotStore({ path });
  store.set('default:agent-plan', 'fingerprint-old', { accountId: 'default', plan: 'agent-plan', state: 'ok', windows: [] });
  await store.whenIdle();
  assert.ok(store.get('default:agent-plan', 'fingerprint-old'));
  assert.equal(store.get('default:agent-plan', 'fingerprint-new'), undefined);
  assert.equal(store.get('missing:plan', 'fingerprint-old'), undefined);
});

test('损坏或版本不符的快照文件被丢弃，不影响后续写入', async () => {
  const dir = await tempDir();
  const path = join(dir, 'quota-snapshot.json');
  await writeFile(path, '{ not json');
  const store = new QuotaSnapshotStore({ path });
  await store.load();
  assert.deepEqual(store.map(), {});

  await writeFile(path, JSON.stringify({ version: SNAPSHOT_VERSION + 1, entries: { 'x:y': { fingerprint: 'f', at: 1, value: { state: 'ok' } } } }));
  const store2 = new QuotaSnapshotStore({ path });
  await store2.load();
  assert.deepEqual(store2.map(), {}, '版本不符应整份丢弃');

  store2.set('default:plan', 'f', { state: 'ok', windows: [] });
  await store2.whenIdle();
  const reloaded = new QuotaSnapshotStore({ path });
  await reloaded.load();
  assert.ok(reloaded.get('default:plan', 'f'), '丢弃损坏文件后仍可正常写入');
});

test('prune 只保留有效条目，close 后不再落盘', async () => {
  const dir = await tempDir();
  const path = join(dir, 'quota-snapshot.json');
  const store = new QuotaSnapshotStore({ path });
  store.set('a:agent-plan', 'f', { state: 'ok', windows: [] });
  store.set('b:agent-plan', 'f', { state: 'ok', windows: [] });
  store.prune(key => key.startsWith('a:'));
  await store.whenIdle();
  assert.equal(store.get('a:agent-plan', 'f').value.state, 'ok');
  assert.equal(store.get('b:agent-plan', 'f'), undefined);

  const before = await readFile(path, 'utf8');
  await store.close();
  store.set('c:agent-plan', 'f', { state: 'ok', windows: [] });
  await store.whenIdle();
  assert.equal(await readFile(path, 'utf8'), before, '关闭后不再写文件');
});
