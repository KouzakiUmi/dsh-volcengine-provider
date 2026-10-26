// 账号状态模块的隔离测试：node --test test/state.test.mjs
// 全部状态文件写在 mkdtemp 临时目录里，不触碰真实用户目录、不读取任何真实凭据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	StateStore,
	account,
	assertPlan,
	initialState,
	validateState,
	revision,
	PLANS,
	ROUTES,
	LABELS
} from '../src/state.mjs';

const dirs = [];
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-volc-state-'));
	dirs.push(dir);
	return dir;
}
after(async () => {
	for (const dir of dirs) {
		assert.ok(dir.startsWith(join(tmpdir(), 'dsh-volc-state-')));
		await rm(dir, { recursive: true, force: true });
	}
});

// ── 账号结构：只接受凭据引用 ────────────────────────────────────────────────────

test('account() 只接受凭据引用，拒绝任何明文密钥字段', () => {
	const base = {
		id: 'default',
		label: '方舟账号',
		apiKeyRefs: { 'agent-plan': 'ARK_AGENT_KEY' },
		accessKeyRef: 'VOLC_ACCESSKEY',
		secretKeyRef: 'VOLC_SECRETKEY'
	};
	const ok = account(base);
	assert.equal(ok.id, 'default');
	assert.equal(ok.label, '方舟账号');

	for (const forbidden of ['apiKey', 'secretKey', 'accessKeyId', 'secretAccessKey', 'token', 'password']) {
		assert.throws(
			() => account({ ...base, [forbidden]: 'sk-plaintext-value' }),
			/只接受凭据引用，不接受密钥/,
			`字段 ${forbidden} 应当被拒绝`
		);
	}
});

test('account() 校验 ID、名称、引用名与 cliProfile 格式', () => {
	const base = { id: 'a1', label: 'x', accessKeyRef: 'AK_REF', secretKeyRef: 'SK_REF' };
	assert.equal(account(base).id, 'a1');
	for (const badId of ['A', '1abc', 'has space', 'has_underscore', '', 'a'.repeat(65)]) {
		assert.throws(() => account({ ...base, id: badId }), /账号 ID/);
	}
	assert.throws(() => account({ ...base, label: '   ' }), /账号名称/);
	assert.throws(() => account({ ...base, label: 'x'.repeat(81) }), /账号名称/);
	assert.throws(() => account({ ...base, accessKeyRef: 'bad ref!' }), /AK\/SK 凭据引用/);
	assert.throws(() => account({ ...base, secretKeyRef: 'bad-ref!' }), /AK\/SK 凭据引用/);
	assert.throws(() => account({ ...base, cliProfile: 'bad profile' }), /ArkCli profile/);
	assert.equal(account({ ...base, cliProfile: 'work-1' }).cliProfile, 'work-1');
});

test('account() 的 apiKeyRefs 按订阅类型隔离，未登记的类型被丢弃', () => {
	const result = account({
		id: 'a1',
		label: 'x',
		apiKeyRefs: { 'agent-plan': 'AGENT_REF', 'coding-plan': 'CODING_REF', 'other-plan': 'IGNORED_REF' },
		accessKeyRef: 'AK_REF',
		secretKeyRef: 'SK_REF'
	});
	assert.deepEqual(result.apiKeyRefs, { 'agent-plan': 'AGENT_REF', 'coding-plan': 'CODING_REF' });
	assert.ok(!('other-plan' in result.apiKeyRefs));
	assert.ok(!JSON.stringify(result).includes('IGNORED_REF'));
});

test('assertPlan 只接受两个已知订阅类型', () => {
	assert.equal(assertPlan('agent-plan'), 'agent-plan');
	assert.equal(assertPlan('coding-plan'), 'coding-plan');
	assert.throws(() => assertPlan('enterprise'), /未知订阅类型/);
	assert.throws(() => assertPlan(''), /未知订阅类型/);
	assert.throws(() => assertPlan(undefined), /未知订阅类型/);
	assert.deepEqual(PLANS, ['agent-plan', 'coding-plan']);
	assert.notEqual(ROUTES['agent-plan'], ROUTES['coding-plan']);
	assert.ok(LABELS['agent-plan'] && LABELS['coding-plan']);
});

// ── 状态结构校验 ────────────────────────────────────────────────────────────────

test('validateState 拒绝重复账号 ID', () => {
	const state = initialState();
	state.accounts.push(state.accounts[0]);
	assert.throws(() => validateState(state), /账号 ID 重复/);
});

test('validateState 拒绝指向不存在账号的 active 绑定', () => {
	const state = initialState();
	state.active['agent-plan'] = 'ghost';
	assert.throws(() => validateState(state), /所选账号不存在/);
	state.active['agent-plan'] = null;
	assert.doesNotThrow(() => validateState(state));
});

test('validateState 丢弃不存在账号的 OAuth 绑定', () => {
	const state = initialState();
	state.oauth['ghost-account'] = { profiles: { 'agent-plan': 'p' }, loggedAt: '2026-01-01T00:00:00.000Z' };
	const result = validateState(state);
	assert.deepEqual(Object.keys(result.oauth), []);
});

test('validateState 的两个订阅绑定互相独立', () => {
	const state = initialState();
	state.active['agent-plan'] = null;
	const result = validateState(state);
	assert.equal(result.active['agent-plan'], null);
	assert.equal(result.active['coding-plan'], 'default');
});

test('validateState 拒绝带明文密钥的账号', () => {
	const state = initialState();
	state.accounts[0].apiKey = 'sk-live-plaintext';
	assert.throws(() => validateState(state), /只接受凭据引用，不接受密钥/);
});

// ── 持久化与 revision 冲突 ──────────────────────────────────────────────────────

test('StateStore.load 在文件缺失时返回初始状态且不落盘', async () => {
	const dir = await tempDir();
	const path = join(dir, 'nested', 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	assert.equal(state.accounts.length, 1);
	assert.equal(state.accounts[0].id, 'default');
	assert.equal(existsSync(path), false, 'load 不应写文件');
});

test('StateStore.load 遇到损坏文件时报错且不覆盖原文件', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	await writeFile(path, '{ this is not json', 'utf8');
	const store = new StateStore(path);
	await assert.rejects(() => store.load(), /无法读取方舟账号状态；原文件未被覆盖/);
	assert.equal(await readFile(path, 'utf8'), '{ this is not json');
});

test('StateStore.load 遇到不兼容版本时报错且不覆盖原文件', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const original = JSON.stringify({ version: 99, accounts: [], active: {}, catalogs: {}, oauth: {} });
	await writeFile(path, original, 'utf8');
	const store = new StateStore(path);
	await assert.rejects(() => store.load(), /无法读取方舟账号状态；原文件未被覆盖/);
	assert.equal(await readFile(path, 'utf8'), original);
});

test('StateStore.mutate 持久化变更并可被重新加载', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	const next = await store.mutate(revision(state), draft => {
		draft.accounts[0].label = '改名后的账号';
		return draft;
	});
	assert.equal(next.accounts[0].label, '改名后的账号');

	const reloaded = await new StateStore(path).load();
	assert.equal(reloaded.accounts[0].label, '改名后的账号');
	assert.equal(revision(reloaded), revision(next));
});

test('StateStore.mutate 拒绝过期的 revision，且不改磁盘', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	await assert.rejects(
		() => store.mutate('stale-revision', draft => {
			draft.accounts[0].label = '不该写入';
			return draft;
		}),
		/设置已改变，请刷新后重试/
	);
	assert.equal(existsSync(path), false, '冲突的变更不应创建文件');
	assert.equal(store.current.accounts[0].label, '现有方舟账号');
});

test('同一 revision 的并发变更只有一个成功', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	const expected = revision(state);
	const results = await Promise.allSettled([
		store.mutate(expected, draft => {
			draft.accounts[0].label = '并发一';
			return draft;
		}),
		store.mutate(expected, draft => {
			draft.accounts[0].label = '并发二';
			return draft;
		})
	]);
	const fulfilled = results.filter(r => r.status === 'fulfilled');
	const rejected = results.filter(r => r.status === 'rejected');
	assert.equal(fulfilled.length, 1);
	assert.equal(rejected.length, 1);
	assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /设置已改变，请刷新后重试/);
	const reloaded = await new StateStore(path).load();
	assert.equal(reloaded.accounts[0].label, fulfilled[0].value.accounts[0].label);
});

test('串行变更按顺序落盘，后一个基于前一个的 revision', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	const first = await store.mutate(revision(state), draft => {
		draft.accounts[0].label = '第一步';
		return draft;
	});
	const second = await store.mutate(revision(first), draft => {
		draft.accounts[0].label = '第二步';
		return draft;
	});
	assert.equal(second.accounts[0].label, '第二步');
	const reloaded = await new StateStore(path).load();
	assert.equal(reloaded.accounts[0].label, '第二步');
});

test('mutate 写入的是合法 JSON 且不残留临时文件', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	await store.mutate(revision(state), draft => draft);
	const raw = await readFile(path, 'utf8');
	assert.ok(JSON.parse(raw));
	const { readdir } = await import('node:fs/promises');
	const entries = await readdir(dir);
	assert.deepEqual(entries.filter(name => name.endsWith('.tmp')), []);
});

test('mutate 丢弃闭包以外的意外改动并落盘', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	await assert.rejects(
		() => store.mutate(revision(state), draft => {
			draft.accounts[0].label = '坏的';
			throw new Error('变更过程失败');
		}),
		/变更过程失败/
	);
	assert.equal(existsSync(path), false);
	assert.equal(store.current.accounts[0].label, '现有方舟账号');
});

// ── revision 本身的性质 ─────────────────────────────────────────────────────────

test('revision 对相同内容稳定、对内容变化敏感', () => {
	const a = initialState();
	const b = initialState();
	assert.equal(revision(a), revision(b));
	b.accounts[0].label = '别的名称';
	assert.notEqual(revision(a), revision(b));
	assert.match(revision(a), /^[0-9a-f]{64}$/);
});

test('两个订阅类型的 active 变更各自产生新的 revision', () => {
	const state = initialState();
	const before = revision(state);
	const changed = structuredClone(state);
	changed.active['agent-plan'] = null;
	assert.notEqual(revision(state), revision(changed));
	assert.equal(changed.active['coding-plan'], 'default');
});
