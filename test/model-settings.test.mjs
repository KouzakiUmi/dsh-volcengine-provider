// 模型设置（逐模型覆盖）的隔离测试：node --test test/model-settings.test.mjs
// 只使用内存状态与仓库内快照，不触碰真实用户目录、不读取任何真实凭据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	StateStore,
	account,
	initialState,
	normalizeModelSettings,
	normalizeReasoningEfforts,
	assertBudgetCompatibleEfforts,
	revision,
	PLANS
} from '../src/state.mjs';
import { getModelRows, profilesFor, snapshot, modelDefaults } from '../src/catalog.mjs';

const dirs = [];
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-volc-settings-'));
	dirs.push(dir);
	return dir;
}
after(async () => {
	for (const dir of dirs) {
		assert.ok(dir.startsWith(join(tmpdir(), 'dsh-volc-settings-')));
		await rm(dir, { recursive: true, force: true });
	}
});

const stateWith = (overrides = {}) => {
	const state = initialState();
	state.accounts.push(account({ id: 'second', label: '第二账号' }));
	state.modelSettings = {};
	return Object.assign(state, overrides);
};

// ── 覆盖值的规范化 ──────────────────────────────────────────────────────────────

test('normalizeModelSettings 只保留已知字段并逐项校验', () => {
	const settings = normalizeModelSettings({
		enabled: true,
		contextWindow: 65536,
		maxTokens: 8192,
		temperature: 0,
		reasoningEfforts: { off: null, low: 'low' },
		defaultReasoning: 'low',
		forceAdaptiveThinking: false
	});
	assert.deepEqual(settings, {
		enabled: true,
		contextWindow: 65536,
		maxTokens: 8192,
		temperature: 0,
		reasoningEfforts: { off: null, low: 'low' },
		defaultReasoning: 'low',
		forceAdaptiveThinking: false
	});
	assert.deepEqual(normalizeModelSettings({}), {});
});

test('normalizeModelSettings 拒绝未知字段、数组与凭据字段', () => {
	for (const input of [{ apiKey: 'sk-plaintext' }, { token: 'x' }, { unknown: 1 }]) {
		assert.throws(() => normalizeModelSettings(input), /未知字段/);
	}
	assert.throws(() => normalizeModelSettings([1, 2]), /模型设置格式错误/);
	assert.throws(() => normalizeModelSettings('nope'), /模型设置格式错误/);
});

test('normalizeModelSettings 校验取值范围与相互约束', () => {
	assert.throws(() => normalizeModelSettings({ temperature: -0.1 }), /temperature/);
	assert.throws(() => normalizeModelSettings({ temperature: 1.1 }), /temperature/);
	assert.throws(() => normalizeModelSettings({ temperature: Number.POSITIVE_INFINITY }), /temperature/);
	assert.throws(() => normalizeModelSettings({ contextWindow: 1024.5 }), /contextWindow/);
	assert.throws(() => normalizeModelSettings({ maxTokens: -1 }), /maxTokens/);
	assert.throws(() => normalizeModelSettings({ contextWindow: 1000, maxTokens: 2000 }), /maxTokens 不得超过 contextWindow/);
	assert.throws(() => normalizeModelSettings({ forceAdaptiveThinking: 1 }), /forceAdaptiveThinking/);
});

test('normalizeReasoningEfforts 只接受 Core 已有档位，只有 off 可以为空', () => {
	assert.equal(normalizeReasoningEfforts(false), false);
	assert.deepEqual(normalizeReasoningEfforts({ off: null, low: 'low' }), { off: null, low: 'low' });
	assert.throws(() => normalizeReasoningEfforts({ low: null }), /思考档位/);
	assert.throws(() => normalizeReasoningEfforts({ ultra: 'ultra' }), /思考档位/);
	assert.throws(() => normalizeReasoningEfforts({}), /思考档位/);
	assert.throws(() => normalizeReasoningEfforts({ off: null }), /思考档位/);
});

test('assertBudgetCompatibleEfforts 与 Core 的预算模式消费端一致', () => {
	assert.doesNotThrow(() => assertBudgetCompatibleEfforts({ off: null, low: 'low', high: 'high' }, false));
	assert.doesNotThrow(() => assertBudgetCompatibleEfforts(false, false));
	assert.doesNotThrow(() => assertBudgetCompatibleEfforts({ low: 'low', max: 'max' }, true), '自适应模式不受预算模式限制');
	assert.throws(() => assertBudgetCompatibleEfforts({ low: 'low', max: 'max' }, false), /折叠为 high/);
	assert.throws(() => assertBudgetCompatibleEfforts({ low: 'ultra' }, false), /必须与档位同名/);
	assert.throws(() => assertBudgetCompatibleEfforts({ off: 'off' }, false), /只能为空值/);
});

// ── 隔离性 ──────────────────────────────────────────────────────────────────────

test('模型设置按账号、套餐、模型三层隔离', () => {
	const state = stateWith();
	state.modelSettings = {
		'default:agent-plan': { 'ark-code-latest': { temperature: 0.2 } },
		'default:coding-plan': { 'ark-code-latest': { temperature: 0.4 } },
		'second:agent-plan': { 'ark-code-latest': { temperature: 0.6 } }
	};
	const agentDefault = getModelRows(state, 'default', 'agent-plan').find(row => row.id === 'ark-code-latest');
	const codingDefault = getModelRows(state, 'default', 'coding-plan').find(row => row.id === 'ark-code-latest');
	const agentSecond = getModelRows(state, 'second', 'agent-plan').find(row => row.id === 'ark-code-latest');
	assert.equal(agentDefault.effective.temperature, 0.2);
	assert.equal(codingDefault.effective.temperature, 0.4);
	assert.equal(agentSecond.effective.temperature, 0.6);
	const other = getModelRows(state, 'second', 'coding-plan').find(row => row.id === 'ark-code-latest');
	assert.equal(other.effective.temperature, undefined);
});

test('模型开关与参数互不干扰：停用模型保留其它参数', () => {
	const state = stateWith();
	state.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { enabled: false, temperature: 0.3, contextWindow: 65536 } } };
	const row = getModelRows(state, 'default', 'agent-plan').find(item => item.id === 'ark-code-latest');
	assert.equal(row.enabled, false);
	assert.equal(row.effective.temperature, 0.3);
	assert.equal(row.effective.contextWindow, 65536);
});

test('套餐启用状态与所选账号互相独立', () => {
	const state = stateWith({ enabled: { 'agent-plan': false, 'coding-plan': true } });
	state.active['agent-plan'] = 'second';
	assert.equal(state.enabled['agent-plan'], false);
	assert.equal(state.active['agent-plan'], 'second');
	const providers = profilesFor(state);
	assert.ok(!('volcengine-agent-plan' in providers), '停用的套餐不注册路由');
	assert.ok('volcengine-coding-plan' in providers);
});

// ── 有效值解析 ──────────────────────────────────────────────────────────────────

test('未知模型保持保守能力：没有思考档位也没有默认 low', () => {
	const state = stateWith();
	state.catalogs = { 'default:agent-plan': { models: [{ id: 'totally-unknown', capabilityUnverified: true, contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] } };
	const row = getModelRows(state, 'default', 'agent-plan')[0];
	assert.equal(row.capabilityUnverified, true);
	assert.equal(row.defaults.reasoningEfforts, false);
	assert.equal(row.defaults.defaultReasoning, null);
	assert.equal(row.effective.defaultReasoning, null);
});

test('目录缺省在有效值里解析成数字，默认档位只按有效能力决定', () => {
	const defaults = modelDefaults('agent-plan', { id: 'no-size', reasoningEfforts: { high: 'high' } });
	assert.equal(typeof defaults.contextWindow, 'number');
	assert.equal(typeof defaults.maxTokens, 'number');
	assert.equal(defaults.defaultReasoning, null, '有效能力不支持 low 时不强制默认档位');
	const withLow = modelDefaults('agent-plan', { id: 'with-low', reasoningEfforts: { low: 'low', high: 'high' } });
	assert.equal(withLow.defaultReasoning, 'low');
});

test('快照里的模型都满足 Core 已核实的档位消费约定', () => {
	for (const plan of PLANS) {
		for (const model of snapshot[plan].models) {
			const defaults = modelDefaults(plan, model);
			assert.doesNotThrow(
				() => assertBudgetCompatibleEfforts(defaults.reasoningEfforts, defaults.forceAdaptiveThinking),
				`${plan}/${model.id} 与 Core 消费端不一致`
			);
		}
	}
});

// ── 持久化 ──────────────────────────────────────────────────────────────────────

test('模型设置随状态文件持久化并可重新加载', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	const store = new StateStore(path);
	const state = await store.load();
	const next = await store.mutate(revision(state), draft => {
		draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { enabled: false, temperature: 0.35 } } };
		return draft;
	});
	assert.equal(next.version, 2);
	const reloaded = await new StateStore(path).load();
	assert.equal(reloaded.modelSettings['default:agent-plan']['ark-code-latest'].temperature, 0.35);
	assert.equal(reloaded.modelSettings['default:agent-plan']['ark-code-latest'].enabled, false);
	const raw = JSON.parse(await readFile(path, 'utf8'));
	assert.equal(raw.version, 2);
});

test('版本 1 的旧文件迁移后仍能保存新的模型设置', async () => {
	const dir = await tempDir();
	const path = join(dir, 'state.json');
	await writeFile(path, JSON.stringify({ version: 1, accounts: [account({ id: 'default', label: '旧账号' })], active: { 'agent-plan': 'default', 'coding-plan': null }, catalogs: {}, oauth: {} }), 'utf8');
	const store = new StateStore(path);
	const loaded = await store.load();
	assert.equal(loaded.version, 2);
	assert.equal(loaded.enabled['agent-plan'], true);
	assert.equal(loaded.enabled['coding-plan'], false);
	const next = await store.mutate(revision(loaded), draft => {
		draft.modelSettings = { 'default:agent-plan': { 'ark-code-latest': { temperature: 0.5 } } };
		return draft;
	});
	assert.equal(next.modelSettings['default:agent-plan']['ark-code-latest'].temperature, 0.5);
	assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
});
