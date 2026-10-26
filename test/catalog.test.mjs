// 模型目录模块的隔离测试：node --test test/catalog.test.mjs
// 只读取仓库内的本地快照（src/catalog-snapshot.json），不访问网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCatalog, usableModels, providerProfile, profilesFor, snapshot } from '../src/catalog.mjs';
import { ROUTES, LABELS } from '../src/state.mjs';

const known = snapshot['agent-plan'].models[0];

// ── normalizeCatalog ────────────────────────────────────────────────────────────

test('normalizeCatalog 以 output_name 优先于 model_id', () => {
	const result = normalizeCatalog('agent-plan', {
		plan: 'agent-plan',
		models: [{ model_id: 'model-from-id', output_name: 'model-from-output-name' }]
	});
	assert.equal(result.models[0].id, 'model-from-output-name');
	assert.equal(result.source, 'arkcli');
});

test('normalizeCatalog 在只有 model_id 时回退到 model_id', () => {
	const result = normalizeCatalog('coding-plan', {
		plan: 'coding-plan',
		models: [{ model_id: 'only-model-id' }]
	});
	assert.equal(result.models[0].id, 'only-model-id');
});

test('normalizeCatalog 对未知模型保持保守能力并标记未核验', () => {
	const result = normalizeCatalog('agent-plan', {
		plan: 'agent-plan',
		models: [{ model_id: 'totally-unknown-model', output_name: 'totally-unknown-model' }]
	});
	const model = result.models[0];
	assert.equal(model.capabilityUnverified, true);
	assert.equal(model.contextWindow, 32768);
	assert.equal(model.maxTokens, 8192);
	assert.deepEqual(model.input, ['text']);
});

test('normalizeCatalog 对快照内已知模型保留其能力声明且不标记未核验', () => {
	const result = normalizeCatalog('agent-plan', {
		plan: 'agent-plan',
		models: [{ model_id: known.id, output_name: known.id }]
	});
	const model = result.models[0];
	assert.ok(!('capabilityUnverified' in model));
	assert.equal(model.maxTokens, known.maxTokens);
	assert.deepEqual(model.input, known.input);
});

test('normalizeCatalog 拒绝重复 ID、非法 ID 与超量目录', () => {
	assert.throws(
		() => normalizeCatalog('agent-plan', { plan: 'agent-plan', models: [{ model_id: 'dup' }, { model_id: 'dup' }] }),
		/模型目录包含非法或重复 ID/
	);
	assert.throws(
		() => normalizeCatalog('agent-plan', { plan: 'agent-plan', models: [{ model_id: 'has space' }] }),
		/模型目录包含非法或重复 ID/
	);
	assert.throws(
		() => normalizeCatalog('agent-plan', { plan: 'agent-plan', models: [{ model_id: '' }] }),
		/模型目录包含非法或重复 ID/
	);
	assert.throws(
		() => normalizeCatalog('agent-plan', { plan: 'agent-plan', models: Array.from({ length: 1001 }, (_, i) => ({ model_id: `m-${i}` })) }),
		/模型目录过大/
	);
});

test('normalizeCatalog 拒绝与所选订阅不匹配或结构错误的响应', () => {
	assert.throws(
		() => normalizeCatalog('agent-plan', { plan: 'coding-plan', models: [] }),
		/模型目录响应与所选订阅不匹配/
	);
	assert.throws(() => normalizeCatalog('agent-plan', { plan: 'agent-plan' }), /模型目录响应与所选订阅不匹配/);
	assert.throws(() => normalizeCatalog('agent-plan', { plan: 'agent-plan', models: {} }), /模型目录响应与所选订阅不匹配/);
	assert.throws(() => normalizeCatalog('enterprise', { plan: 'enterprise', models: [] }), /未知订阅类型/);
});

test('normalizeCatalog 在模型名缺失或超长时退回 ID', () => {
	const result = normalizeCatalog('agent-plan', {
		plan: 'agent-plan',
		models: [{ model_id: 'named-model' }, { model_id: 'long-name-model', model_name: 'x'.repeat(201) }]
	});
	assert.equal(result.models[0].name, 'named-model');
	assert.equal(result.models[1].name, 'long-name-model');
});

// ── usableModels ────────────────────────────────────────────────────────────────

test('usableModels 在没有缓存时回退到本地快照', () => {
	const models = usableModels(undefined, 'agent-plan');
	assert.deepEqual(models.map(m => m.id), snapshot['agent-plan'].models.map(m => m.id));
});

test('usableModels 对空目录不回退快照，而是给出空列表', () => {
	const models = usableModels({ models: [] }, 'coding-plan');
	assert.deepEqual(models, []);
});

test('usableModels 剥离未核验标记', () => {
	const models = usableModels({ models: [{ id: 'x-model', capabilityUnverified: true, contextWindow: 1 }] }, 'agent-plan');
	assert.ok(!('capabilityUnverified' in models[0]));
	assert.equal(models[0].contextWindow, 1);
});

test('usableModels 拒绝非法 ID 与非数组的缓存', () => {
	assert.throws(() => usableModels({ models: [{ id: 'bad id' }] }, 'agent-plan'), /本地模型缓存包含非法 ID/);
	assert.throws(() => usableModels({ models: 'not-an-array' }, 'agent-plan'), /本地模型缓存格式错误/);
	assert.throws(() => usableModels({ models: {} }, 'agent-plan'), /本地模型缓存格式错误/);
});

test('usableModels 对 models 为 null 的损坏缓存应报错而不是回退快照', () => {
	// 缓存存在却损坏时，回退到快照会把「未知能力」伪装成「已核验能力」；
	// 这里要求显式报错，让上层知道缓存不可用。
	assert.throws(() => usableModels({ models: null }, 'agent-plan'), /本地模型缓存格式错误/);
});

// ── providerProfile / profilesFor ───────────────────────────────────────────────

test('providerProfile 叠加快照基线与展示名', () => {
	const models = usableModels(undefined, 'agent-plan');
	const profile = providerProfile('agent-plan', models);
	assert.equal(profile.displayName, LABELS['agent-plan']);
	assert.deepEqual(profile.models, models);
	assert.equal(profile.api, snapshot['agent-plan'].api);
});

test('profilesFor 按账号与订阅生成互相独立的路由', () => {
	const state = {
		active: { 'agent-plan': 'acct-a', 'coding-plan': 'acct-b' },
		accounts: [
			{ id: 'acct-a' },
			{ id: 'acct-b' }
		],
		catalogs: {
			'acct-a:agent-plan': { models: [{ id: 'a-agent-model' }] },
			'acct-b:coding-plan': { models: [{ id: 'b-coding-model' }] }
		}
	};
	const providers = profilesFor(state);
	assert.deepEqual(Object.keys(providers).sort(), [ROUTES['agent-plan'], ROUTES['coding-plan']].sort());
	assert.deepEqual(providers[ROUTES['agent-plan']].models.map(m => m.id), ['a-agent-model']);
	assert.deepEqual(providers[ROUTES['coding-plan']].models.map(m => m.id), ['b-coding-model']);
});

test('profilesFor 同一账号的两个订阅各自取自己的目录缓存', () => {
	const state = {
		active: { 'agent-plan': 'acct-a', 'coding-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: {
			'acct-a:agent-plan': { models: [{ id: 'agent-only' }] },
			'acct-a:coding-plan': { models: [{ id: 'coding-only' }] }
		}
	};
	const providers = profilesFor(state);
	assert.deepEqual(providers[ROUTES['agent-plan']].models.map(m => m.id), ['agent-only']);
	assert.deepEqual(providers[ROUTES['coding-plan']].models.map(m => m.id), ['coding-only']);
});

test('profilesFor 跳过没有激活账号的订阅', () => {
	const state = {
		active: { 'agent-plan': null, 'coding-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: {}
	};
	const providers = profilesFor(state);
	assert.ok(!(ROUTES['agent-plan'] in providers));
	assert.ok(ROUTES['coding-plan'] in providers);
});

test('profilesFor 在目录缓存损坏时抛错，不静默换用快照', () => {
	const state = {
		active: { 'agent-plan': 'acct-a', 'coding-plan': null },
		accounts: [{ id: 'acct-a' }],
		catalogs: { 'acct-a:agent-plan': { models: [{ id: 'not valid id' }] } }
	};
	assert.throws(() => profilesFor(state), /本地模型缓存包含非法 ID/);
});
