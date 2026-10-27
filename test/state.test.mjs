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

test('取消排队中的状态修改不写入文件，后续修改仍能执行', async () => {
	const dir = await tempDir();
	const file = join(dir, 'state.json');
	const store = new StateStore(file);
	await store.load();
	let release;
	store.queue = new Promise(resolve => { release = resolve; });
	const abort = new AbortController();
	const pending = store.mutate(revision(store.current), next => {
		next.accounts[0].label = '不应保存';
		return next;
	}, { signal: abort.signal });
	abort.abort();
	release();
	await assert.rejects(pending, { name: 'AbortError' });
	assert.equal(existsSync(file), false);
	assert.notEqual(store.current.accounts[0].label, '不应保存');
	await store.mutate(revision(store.current), next => { next.accounts[0].label = '后续保存'; return next; });
	assert.equal(JSON.parse(await readFile(file, 'utf8')).accounts[0].label, '后续保存');
});
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

// ── 版本迁移与启用状态 ──────────────────────────────────────────────────────────

test('版本 1 状态迁移为版本 2：有所选账号的套餐启用，未选择的停用', () => {
	const legacy = {
		version: 1,
		accounts: [account({ id: 'default', label: '旧账号' })],
		active: { 'agent-plan': 'default', 'coding-plan': null },
		catalogs: {},
		oauth: {}
	};
	const migrated = validateState(legacy);
	assert.equal(migrated.version, 2);
	assert.equal(migrated.enabled['agent-plan'], true);
	assert.equal(migrated.enabled['coding-plan'], false);
	assert.deepEqual(migrated.modelSettings, {});
	assert.equal(migrated.active['agent-plan'], 'default');
	assert.equal(migrated.active['coding-plan'], null);
});

test('StateStore.load 只在内存中迁移版本 1，下一次有效修改才写回版本 2', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const legacy = { version: 1, accounts: [account({ id: 'default', label: '旧账号' })], active: { 'agent-plan': 'default', 'coding-plan': null }, catalogs: {}, oauth: {} };
	await writeFile(path, JSON.stringify(legacy), 'utf8');
	const store = new StateStore(path);
	const loaded = await store.load();
	assert.equal(loaded.version, 2);
	assert.equal(loaded.enabled['agent-plan'], true);
	assert.equal(loaded.enabled['coding-plan'], false);
	assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1, '读取迁移不应写回文件');
	await store.mutate(revision(loaded), draft => {
		draft.accounts[0].label = '改名后的账号';
		return draft;
	});
	assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2, '下一次有效修改应写回版本 2');
});

test('版本 2 的 enabled 独立于 active：关闭套餐保留所选账号', () => {
	const state = initialState();
	state.enabled['agent-plan'] = false;
	const result = validateState(state);
	assert.equal(result.enabled['agent-plan'], false);
	assert.equal(result.enabled['coding-plan'], true);
	assert.equal(result.active['agent-plan'], 'default');
});

test('版本 2 不把非法启用值默认为已开启', () => {
	for (const invalid of ['false', 0, null, {}]) {
		const state = initialState();
		state.enabled['agent-plan'] = invalid;
		assert.throws(() => validateState(state), /套餐启用状态必须是布尔值/);
	}
});

test('validateState 仍拒绝版本 3 与缺失的版本号', () => {
	const state = initialState();
	state.version = 3;
	assert.throws(() => validateState(state), /账号状态格式不兼容/);
	const missing = initialState();
	delete missing.version;
	assert.throws(() => validateState(missing), /账号状态格式不兼容/);
});

// ── 逐模型覆盖的校验 ────────────────────────────────────────────────────────────

test('modelSettings 按账号与套餐隔离，互不影响', () => {
	const state = initialState();
	state.modelSettings = {
		'default:agent-plan': { 'ark-code-latest': { temperature: 0.4, contextWindow: 65536 } },
		'default:coding-plan': { 'ark-code-latest': { maxTokens: 4096 } }
	};
	const result = validateState(state);
	assert.equal(result.modelSettings['default:agent-plan']['ark-code-latest'].temperature, 0.4);
	assert.equal(result.modelSettings['default:coding-plan']['ark-code-latest'].maxTokens, 4096);
	assert.equal(result.modelSettings['default:agent-plan']['ark-code-latest'].maxTokens, undefined);
});

test('validateState 丢弃不存在账号与未知套餐的模型设置', () => {
	const state = initialState();
	state.modelSettings = {
		'ghost:agent-plan': { 'ark-code-latest': { temperature: 0.4 } },
		'default:enterprise-plan': { 'ark-code-latest': { temperature: 0.4 } }
	};
	const result = validateState(state);
	assert.deepEqual(Object.keys(result.modelSettings), []);
});

test('validateState 拒绝模型设置里的未知字段、数组与凭据字段', () => {
	const base = initialState();
	const bad = [
		{ apiKey: 'sk-plaintext' },
		{ secretKeyRef: 'VOLC_SECRETKEY' },
		{ unknown: 1 },
		{ temperature: [0.5] },
		{ contextWindow: '1024' },
		{ contextWindow: 0 },
		{ maxTokens: 1.5 },
		{ temperature: 1.5 },
		{ temperature: Number.NaN },
		{ forceAdaptiveThinking: 'yes' },
		{ enabled: 'yes' }
	];
	for (const settings of bad) {
		const draft = structuredClone(base);
		draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': settings } };
		assert.throws(() => validateState(draft), /未知字段|必须是|格式错误|不受支持/, `应当拒绝 ${JSON.stringify(settings)}`);
	}
	const array = structuredClone(base);
	array.modelSettings = { 'default:agent-plan': { 'ark-code-latest': [1, 2] } };
	assert.throws(() => validateState(array), /模型设置格式错误/);
});

test('validateState 拒绝非法模型 ID 与保留名称', () => {
	const base = initialState();
	for (const modelId of ['bad id', '', '__proto__', 'constructor', 'prototype']) {
		const draft = structuredClone(base);
		draft.modelSettings = { 'default:agent-plan': { [modelId]: { temperature: 0.4 } } };
		assert.throws(() => validateState(draft), /模型 ID/, `应当拒绝模型 ID ${modelId}`);
	}
});

test('模型设置不会污染原型链', () => {
	const draft = initialState();
	draft.modelSettings = JSON.parse('{"__proto__":{"polluted":true},"default:agent-plan":{"__proto__":{"polluted":true}}}');
	try {
		validateState(draft);
	} catch (error) {
		assert.match(error.message, /模型 ID|模型设置/);
	}
	assert.equal({}.polluted, undefined);
	assert.equal(Object.prototype.polluted, undefined);
});

test('思考档位只接受 Core 已有档位，且只有 off 可以为空', () => {
	const base = initialState();
	const accept = [{ off: null, low: 'low' }, { low: 'low', medium: 'medium', high: 'high' }, false];
	for (const reasoningEfforts of accept) {
		const draft = structuredClone(base);
		draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { reasoningEfforts } } };
		assert.doesNotThrow(() => validateState(draft), `应当接受 ${JSON.stringify(reasoningEfforts)}`);
	}
	const reject = [{ low: null }, { ultra: 'ultra' }, {}, { off: null }, { off: 'off' }];
	for (const reasoningEfforts of reject) {
		const draft = structuredClone(base);
		draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { reasoningEfforts } } };
		assert.throws(() => validateState(draft), /思考档位/, `应当拒绝 ${JSON.stringify(reasoningEfforts)}`);
	}
});

test('显式默认思考档位必须被同对象的思考档位映射支持', () => {
	const base = initialState();
	const ok = structuredClone(base);
	ok.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { reasoningEfforts: { low: 'low', high: 'high' }, defaultReasoning: 'high' } } };
	assert.doesNotThrow(() => validateState(ok));
	const nulled = structuredClone(base);
	nulled.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { reasoningEfforts: { low: 'low' }, defaultReasoning: null } } };
	assert.doesNotThrow(() => validateState(nulled));
	const unsupported = structuredClone(base);
	unsupported.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { reasoningEfforts: { low: 'low' }, defaultReasoning: 'medium' } } };
	assert.throws(() => validateState(unsupported), /默认思考档位/);
	const bogus = structuredClone(base);
	bogus.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { defaultReasoning: 'bogus' } } };
	assert.throws(() => validateState(bogus), /默认思考档位/);
	const disabled = structuredClone(base);
	disabled.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { reasoningEfforts: false, defaultReasoning: 'low' } } };
	assert.throws(() => validateState(disabled), /默认思考档位/);
});

test('同一份设置里的 maxTokens 不得超过 contextWindow', () => {
	const draft = initialState();
	draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { contextWindow: 1000, maxTokens: 2000 } } };
	assert.throws(() => validateState(draft), /maxTokens 不得超过 contextWindow/);
});

test('预算模式下的思考档位必须与 Core 消费端一致', () => {
	const base = initialState();
	const ok = structuredClone(base);
	ok.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { forceAdaptiveThinking: false, reasoningEfforts: { off: null, low: 'low', high: 'high' } } } };
	assert.doesNotThrow(() => validateState(ok));
	const disabled = structuredClone(base);
	disabled.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { forceAdaptiveThinking: false, reasoningEfforts: false } } };
	assert.doesNotThrow(() => validateState(disabled));
	const folded = structuredClone(base);
	folded.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { forceAdaptiveThinking: false, reasoningEfforts: { low: 'low', max: 'max' } } } };
	assert.throws(() => validateState(folded), /折叠为 high/);
	const renamed = structuredClone(base);
	renamed.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { forceAdaptiveThinking: false, reasoningEfforts: { low: 'ultra' } } } };
	assert.throws(() => validateState(renamed), /必须与档位同名/);
});

// ── 图片输入与工具开关 ──────────────────────────────────────────────────────────

test('图片输入与工具开关只接受布尔值', () => {
	const base = initialState();
	for (const key of ['imageInput', 'toolsEnabled']) {
		for (const value of ['true', 'false', 'yes', 1, 0, null, {}, [], Number.NaN]) {
			const draft = structuredClone(base);
			draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { [key]: value } } };
			assert.throws(() => validateState(draft), new RegExp(`${key} 必须是布尔值`), `应当拒绝 ${key}=${JSON.stringify(value)}`);
		}
		for (const value of [true, false]) {
			const draft = structuredClone(base);
			draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { [key]: value } } };
			const result = validateState(draft);
			assert.equal(result.modelSettings['default:agent-plan']['ark-code-latest'][key], value);
		}
	}
});

test('未给出图片与工具设置时保持缺省，由目录默认继承', () => {
	const draft = initialState();
	draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { temperature: 0.4 } } };
	const result = validateState(draft);
	const settings = result.modelSettings['default:agent-plan']['ark-code-latest'];
	assert.equal(settings.temperature, 0.4);
	assert.equal(Object.hasOwn(settings, 'imageInput'), false, '缺省不落盘');
	assert.equal(Object.hasOwn(settings, 'toolsEnabled'), false, '缺省不落盘');
});

test('图片与工具设置按模型、账号与套餐三层隔离', () => {
	const draft = initialState();
	draft.accounts.push({ ...draft.accounts[0], id: 'second', label: '第二账号' });
	draft.modelSettings = {
		'default:agent-plan': { 'ark-code-latest': { imageInput: false, toolsEnabled: false } },
		'default:coding-plan': { 'ark-code-latest': { imageInput: false } },
		'second:agent-plan': { 'ark-code-latest': { toolsEnabled: false } },
		'default:agent-plan-other': { 'ark-code-latest': { imageInput: false } }
	};
	const result = validateState(draft);
	const agent = result.modelSettings['default:agent-plan']['ark-code-latest'];
	assert.equal(agent.imageInput, false);
	assert.equal(agent.toolsEnabled, false);
	const coding = result.modelSettings['default:coding-plan']['ark-code-latest'];
	assert.equal(coding.imageInput, false);
	assert.equal(Object.hasOwn(coding, 'toolsEnabled'), false, '另一套餐不应继承工具开关');
	const second = result.modelSettings['second:agent-plan']['ark-code-latest'];
	assert.equal(second.toolsEnabled, false);
	assert.equal(Object.hasOwn(second, 'imageInput'), false, '另一账号不应继承图片开关');
});

test('图片与工具设置随状态文件持久化并可重新加载', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	const next = await store.mutate(revision(state), draft => {
		draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { imageInput: false, toolsEnabled: false } } };
		return draft;
	});
	assert.equal(next.version, 2, '状态版本保持为 2');
	const reloaded = await new StateStore(path).load();
	const settings = reloaded.modelSettings['default:agent-plan']['ark-code-latest'];
	assert.equal(settings.imageInput, false);
	assert.equal(settings.toolsEnabled, false);
	const raw = JSON.parse(await readFile(path, 'utf8'));
	assert.equal(raw.version, 2);
	assert.equal(raw.modelSettings['default:agent-plan']['ark-code-latest'].toolsEnabled, false);
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

test('独立 Store 不能用旧磁盘快照覆盖另一实例，刷新后可继续', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const a = new StateStore(path), b = new StateStore(path);
	await a.load(); await b.load();
	await a.mutate(revision(a.current), draft => { draft.accounts[0].label = '实例 A'; return draft; });
	await assert.rejects(b.mutate(revision(b.current), draft => { draft.accounts[0].label = '过期 B'; return draft; }), /设置已改变/);
	assert.equal((await new StateStore(path).load()).accounts[0].label, '实例 A');
	assert.equal(await b.refresh(), true);
	await b.mutate(revision(b.current), draft => { draft.accounts[0].label = '已同步 B'; return draft; });
	assert.equal((await new StateStore(path).load()).accounts[0].label, '已同步 B');
});

test('独立 Store 同时写入至多一个成功且不残留锁和临时文件', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const stores = [new StateStore(path), new StateStore(path)];
	await Promise.all(stores.map(store => store.load()));
	const results = await Promise.allSettled(stores.map((store, index) => store.mutate(revision(store.current), draft => { draft.accounts[0].label = `实例 ${index}`; return draft; })));
	assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
	const { readdir } = await import('node:fs/promises');
	assert.deepEqual((await readdir(dir)).sort(), ['state.json']);
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
