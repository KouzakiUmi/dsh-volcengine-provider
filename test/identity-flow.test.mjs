import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArkController } from '../src/manager.mjs';
import { revision, validateState, StateStore } from '../src/state.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ark-identity-'));
  const calls = [];
  const identities = new Map();
  const controller = new ArkController({ statePath: join(root, 'state.json'), resolveRef: async () => undefined,
    cliFactory: (owner, home) => ({ home, executable: 'fake',
      whoami: async () => { calls.push(['whoami', home]); return identities.get(home) ?? { logged_in: true, name: '官方用户', user_id: 'user-1', account_id: 'account-1', token: 'NEVER-PERSIST' }; },
      status: async () => ({ profiles_summary: [{ type: 'agent-plan', name: 'agent' }] }),
      apiKey: async () => { calls.push(['key', home]); return home.includes('sessions') ? 'NEW-KEY' : 'OLD-KEY'; },
      models: async () => { calls.push(['models', home]); return { models: [] }; }
    }) });
  await controller.store.load();
  t.after(async () => { controller.dispose(); assert.ok(root.startsWith(join(tmpdir(), 'ark-identity-'))); await rm(root, { recursive: true, force: true }); });
  return { controller, root, calls, identities };
}

test('login saves only safe identity fields and exposes actual name without overwriting local label', async t => {
  const { controller } = await fixture(t);
  await controller.bindLogin('default', revision(controller.store.current), new AbortController().signal);
  const view = await controller.read();
  assert.equal(view.accounts[0].displayName, '官方用户');
  assert.equal(view.accounts[0].label, '现有方舟账号');
  assert.deepEqual(view.accounts[0].identity, { name: '官方用户', userId: 'user-1', accountId: 'account-1' });
  assert.deepEqual(view.accounts[0].hasQuotaAccess, { 'agent-plan': true, 'coding-plan': false });
  assert.deepEqual(view.accounts[0].oauthProfiles, { 'agent-plan': 'agent' });
  const disk = await readFile(controller.store.path, 'utf8');
  assert.ok(!disk.includes('NEVER-PERSIST'));
  await controller.store.load();
  assert.equal((await controller.read()).accounts[0].displayName, '官方用户');
});

test('legacy OAuth metadata recovers identity without requiring another browser login', async t => {
  const { controller, calls } = await fixture(t);
  controller.store.current.oauth.default = { profiles: { 'agent-plan': 'agent' }, loggedAt: 'old' };
  assert.equal((await controller.read()).accounts[0].displayName, '官方用户');
  await controller.read();
  assert.equal(calls.filter(c => c[0] === 'whoami').length, 1);
});

test('new login home is bound atomically and prepared old binding retains old identity', async t => {
  const { controller, calls, root } = await fixture(t);
  const old = { profiles: { 'agent-plan': 'agent' }, loggedAt: 'old', identity: { name: '旧用户' } };
  controller.store.current.oauth.default = old;
  const owner = controller.owner('default');
  const homeId = '12345678-1234-1234-1234-123456789abc';
  await controller.bindLogin('default', revision(controller.store.current), new AbortController().signal, homeId);
  assert.equal(controller.store.current.oauth.default.homeId, homeId);
  assert.equal(await controller.inferenceKey(owner, 'agent-plan', { binding: old }), 'OLD-KEY');
  assert.equal(await controller.inferenceKey(owner, 'agent-plan'), 'NEW-KEY');
  assert.ok(calls.some(c => c[0] === 'whoami' && c[1] === join(root, 'accounts', 'default', 'sessions', homeId)));
  assert.throws(() => validateState({ ...controller.store.current, oauth: { default: { ...old, homeId: '../outside' } } }), /隔离目录/);
});

test('failed login verification never changes previous binding or home', async t => {
  const { controller, root, identities } = await fixture(t);
  const old = { profiles: { 'agent-plan': 'agent' }, loggedAt: 'old', identity: { name: '旧用户' } };
  controller.store.current.oauth.default = old;
  const homeId = '12345678-1234-1234-1234-123456789abc';
  identities.set(join(root, 'accounts', 'default', 'sessions', homeId), { logged_in: false });
  await assert.rejects(controller.bindLogin('default', revision(controller.store.current), new AbortController().signal, homeId), /未确认/);
  assert.deepEqual(controller.store.current.oauth.default, old);
  assert.equal(await controller.inferenceKey(controller.owner('default'), 'agent-plan'), 'OLD-KEY');
});

test('OAuth model discovery cannot fall back to legacy profile for unbound plan', async t => {
  const { controller, calls } = await fixture(t);
  controller.store.current.accounts[0].cliProfile = 'legacy';
  controller.store.current.oauth.default = { profiles: { 'agent-plan': 'agent' }, loggedAt: 'old', identity: { name: '用户' } };
  await assert.rejects(controller.invoke({ op: 'models', accountId: 'default', plan: 'coding-plan', revision: revision(controller.store.current) }), /网页登录|profile/);
  assert.equal(calls.filter(c => c[0] === 'models').length, 0);
});

test('verified login remains successful when route activation fails separately', async t => {
  const { controller } = await fixture(t);
  controller.onChange = async () => { throw new Error('routing failed'); };
  await controller.bindLogin('default', revision(controller.store.current), new AbortController().signal);
  const view = await controller.read();
  assert.equal(view.accounts[0].displayName, '官方用户');
  assert.match(view.routingError, /路由更新失败/);
});

test('read synchronizes another instance state and updates routing once', async t => {
  const { controller } = await fixture(t);
  const other = new StateStore(controller.store.path);
  await other.load();
  await other.mutate(revision(other.current), state => { state.accounts[0].label = '另一实例备注'; return state; });
  let updates = 0;
  controller.onChange = async () => { updates++; };
  assert.equal((await controller.invoke({ op: 'read' })).accounts[0].label, '另一实例备注');
  await controller.invoke({ op: 'read' });
  assert.equal(updates, 1);
});

test('a broken credential resolver does not make account settings unreadable or expose errors', async t => {
  const { controller } = await fixture(t);
  controller.resolveRef = async () => { throw new Error('SECRET-ERROR'); };
  const view = await controller.read();
  assert.equal(view.accounts.length, 1);
  assert.ok(view.accounts[0].credentialError);
  assert.equal(view.accounts[0].hasApiKeys['agent-plan'], false);
  assert.ok(!JSON.stringify(view).includes('SECRET-ERROR'));
});
