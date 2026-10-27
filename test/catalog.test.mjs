// 模型目录模块的隔离测试：node --test test/catalog.test.mjs
// 只读取仓库内的本地快照（src/catalog-snapshot.json），不访问网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCatalog, usableModels, providerProfile, profilesFor, snapshot, getModelRows, modelDefaults, effectiveModel, defaultReasoningFor, catalogStatus } from '../src/catalog.mjs';
import { ROUTES, LABELS, initialState } from '../src/state.mjs';

const known = snapshot['agent-plan'].models.find(model => !model.capabilityUnverified);

test('损坏目录行保持设置可读，同时阻止启用损坏的路由', () => {
	for (const models of [[null], [{}], [{ id: 123 }], [{ id: 'bad id' }], [{ id: 'constructor' }], [{ id: 'same' }, { id: 'same' }]]) {
		const state = initialState();
		state.catalogs['default:agent-plan'] = { models };
		assert.equal(catalogStatus(state, 'default', 'agent-plan').source, 'invalid-cache');
		assert.deepEqual(getModelRows(state, 'default', 'agent-plan'), []);
		assert.equal(catalogStatus(state, 'default', 'coding-plan').source, 'local-snapshot');
		assert.throws(() => profilesFor(state), /本地模型缓存/);
	}
});

test('远端目录拒绝空行和保留名称，避免保存不可用模型', () => {
	for (const row of [null, [], { model_id: 'constructor' }, { model_id: 'prototype' }]) {
		assert.throws(() => normalizeCatalog('agent-plan', { plan: 'agent-plan', models: [row] }), /模型目录包含非法或重复 ID/);
	}
});

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

// ── 图片输入与工具开关 ──────────────────────────────────────────────────────────

test('modelDefaults 给出图片输入与工具开关的目录默认', () => {
	const vision = modelDefaults('agent-plan', { id: 'vision', input: ['text', 'image'] });
	assert.equal(vision.imageInput, true);
	assert.equal(vision.toolsEnabled, true, '工具默认开启，保持既有工具行为');
	const text = modelDefaults('agent-plan', { id: 'text', input: ['text'] });
	assert.equal(text.imageInput, false);
	assert.equal(text.toolsEnabled, true);
	const unknown = modelDefaults('agent-plan', { id: 'unknown' });
	assert.equal(unknown.imageInput, false, '没有模态声明时按纯文本处理');
	assert.equal(unknown.toolsEnabled, true);
	const media = modelDefaults('agent-plan', { id: 'media', input: ['text', 'audio', 'video'] });
	assert.equal(media.imageInput, false, '音视频不算图片输入');
});

test('effectiveModel 合并图片与工具覆盖，未覆盖时继承目录默认', () => {
	const defaults = modelDefaults('agent-plan', { id: 'vision', input: ['text', 'image'] });
	assert.equal(effectiveModel(defaults, {}).imageInput, true);
	assert.equal(effectiveModel(defaults, {}).toolsEnabled, true);
	assert.equal(effectiveModel(defaults, { imageInput: false }).imageInput, false);
	assert.equal(effectiveModel(defaults, { toolsEnabled: false }).toolsEnabled, false);
	const textDefaults = modelDefaults('agent-plan', { id: 'text', input: ['text'] });
	assert.equal(effectiveModel(textDefaults, {}).imageInput, false);
	assert.equal(effectiveModel(textDefaults, { toolsEnabled: false }).toolsEnabled, false);
	assert.equal(effectiveModel(textDefaults, { temperature: 0.2 }).imageInput, false, '其它参数不影响图片与工具默认');
});

test('getModelRows 的默认值与有效值都带图片与工具开关', () => {
	const state = {
		active: { 'agent-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: {
			'acct-a:agent-plan': {
				models: [
					{ id: 'vision-model', input: ['text', 'image'] },
					{ id: 'text-model', input: ['text'] }
				]
			}
		},
		modelSettings: { 'acct-a:agent-plan': { 'vision-model': { toolsEnabled: false } } }
	};
	const rows = getModelRows(state, 'acct-a', 'agent-plan');
	const vision = rows.find(row => row.id === 'vision-model');
	const text = rows.find(row => row.id === 'text-model');
	assert.equal(vision.defaults.imageInput, true);
	assert.equal(vision.defaults.toolsEnabled, true);
	assert.equal(vision.effective.imageInput, true);
	assert.equal(vision.effective.toolsEnabled, false);
	assert.equal(text.defaults.imageInput, false);
	assert.equal(text.effective.imageInput, false);
	assert.equal(text.effective.toolsEnabled, true);
});

test('Core 模型描述按有效图片开关给出输入模态，且不泄漏工具开关', () => {
	const state = {
		enabled: { 'agent-plan': true },
		active: { 'agent-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: {
			'acct-a:agent-plan': {
				models: [
					{ id: 'vision-model', input: ['text', 'image'] },
					{ id: 'text-model', input: ['text'] }
				]
			}
		},
		modelSettings: {
			'acct-a:agent-plan': { 'vision-model': { imageInput: false, toolsEnabled: false }, 'text-model': { imageInput: true } }
		}
	};
	const models = profilesFor(state)[ROUTES['agent-plan']].models;
	const vision = models.find(model => model.id === 'vision-model');
	const text = models.find(model => model.id === 'text-model');
	assert.deepEqual(vision.input, ['text'], '关闭图片后只保留文本输入');
	assert.deepEqual(text.input, ['text', 'image'], '显式开启后给出图片输入');
	for (const model of models) {
		assert.ok(!('toolsEnabled' in model), '工具开关不得作为 Core 字段下发');
		assert.ok(!('imageInput' in model), '图片开关不得作为 Core 字段下发');
	}
});

test('目录声明的音视频等未支持模态时路由构建显式拒绝', () => {
	const state = {
		enabled: { 'agent-plan': true },
		active: { 'agent-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: {
			'acct-a:agent-plan': {
				models: [{ id: 'media-model', input: ['text', 'audio', 'video'], toolsEnabled: false }]
			}
		}
	};
	assert.throws(() => profilesFor(state), /输入模态不受支持/, '音视频不得被当作纯文本注册到路由');
});

test('坏目录的输入模态让设置页可读，但路由构建拒绝该目录', () => {
	const malformed = [
		{ input: 'text' },
		{ input: [] },
		{ input: null },
		{ input: ['text', 'text'] },
		{ input: ['text', 'audio'] },
		{ input: ['text', 'video'] }
	];
	for (const row of malformed) {
		const state = {
			enabled: { 'agent-plan': true },
			active: { 'agent-plan': 'acct-a' },
			accounts: [{ id: 'acct-a' }],
			catalogs: { 'acct-a:agent-plan': { models: [{ id: 'broken-model', ...row }] } },
			// 显式的图片开关不能掩盖坏目录。
			modelSettings: { 'acct-a:agent-plan': { 'broken-model': { imageInput: true } } }
		};
		const rows = getModelRows(state, 'acct-a', 'agent-plan');
		assert.equal(rows.length, 1, '设置页仍应给出该模型');
		assert.match(rows[0].settingsWarning, /输入模态.*路由更新失败.*已有可用路由/, '设置页应说明更新失败并保留已有路由');
		assert.throws(() => profilesFor(state), /输入模态/, `应当拒绝 ${JSON.stringify(row)}`);
	}
});

test('目录没有声明输入模态时沿用既有 fallback，路由照常构建', () => {
	const state = {
		enabled: { 'agent-plan': true },
		active: { 'agent-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: { 'acct-a:agent-plan': { models: [{ id: 'plain-model' }] } }
	};
	const models = profilesFor(state)[ROUTES['agent-plan']].models;
	assert.deepEqual(models[0].input, ['text']);
	const rows = getModelRows(state, 'acct-a', 'agent-plan');
	assert.equal(rows[0].settingsWarning, undefined, '没有声明不算坏目录');
	assert.equal(rows[0].defaults.imageInput, false);
});

test('强制开启图片会提醒目录未声明该能力', () => {
	const state = {
		active: { 'agent-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: { 'acct-a:agent-plan': { models: [{ id: 'text-model', input: ['text'] }] } },
		modelSettings: { 'acct-a:agent-plan': { 'text-model': { imageInput: true } } }
	};
	const row = getModelRows(state, 'acct-a', 'agent-plan')[0];
	assert.equal(row.effective.imageInput, true, '用户确认的能力覆写仍然生效');
	assert.match(row.settingsWarning, /强制开启图片/);
});

// ── providerProfile / profilesFor ───────────────────────────────────────────────

test('providerProfile 叠加快照基线与展示名', () => {
	const models = usableModels(undefined, 'agent-plan');
	const profile = providerProfile('agent-plan', models);
	assert.equal(profile.displayName, LABELS['agent-plan']);
	assert.deepEqual(profile.models, models);
	assert.equal(profile.api, snapshot['agent-plan'].api);
});

test('providerProfile 不再下发 provider 级 reasoning，避免强制 low 档位', () => {
	const profile = providerProfile('agent-plan', usableModels(undefined, 'agent-plan'));
	assert.ok(!('reasoning' in profile), 'provider 级 reasoning 必须移除');
	assert.ok(!('reasoning' in snapshot['agent-plan']), '快照不再保存 provider 级默认档位');
	assert.ok(!('reasoning' in profile.models[0]), '模型条目也不得带 provider 级 reasoning');
});

// ── 目录默认值与用户覆盖 ────────────────────────────────────────────────────────

test('modelDefaults 把 provider 级缺省解析成具体数字', () => {
	const defaults = modelDefaults('agent-plan', { id: 'no-size-model' });
	assert.equal(typeof defaults.contextWindow, 'number');
	assert.equal(typeof defaults.maxTokens, 'number');
	assert.equal(defaults.contextWindow, snapshot['agent-plan'].defaultContextWindow);
	assert.equal(defaults.maxTokens, snapshot['agent-plan'].defaultMaxTokens);
	assert.equal(defaults.reasoningEfforts, false);
	assert.equal(defaults.defaultReasoning, null);
});

test('defaultReasoningFor 只采用已声明且被支持的默认档位', () => {
	assert.equal(defaultReasoningFor({ low: 'low', high: 'high' }), null);
	assert.equal(defaultReasoningFor({ low: 'low', high: 'high' }, 'high'), 'high');
	assert.equal(defaultReasoningFor({ off: null, high: 'high' }, 'low'), null);
	assert.equal(defaultReasoningFor({ off: null, low: 'low' }, 'off'), 'off');
	assert.equal(defaultReasoningFor(false), null);
	assert.equal(defaultReasoningFor(undefined), null);
});

test('effectiveModel 合并覆盖值，默认档位跟随有效思考能力', () => {
	const defaults = modelDefaults('agent-plan', { id: 'm', reasoningEfforts: { low: 'low', high: 'high' }, defaultReasoning: 'high' });
	const effective = effectiveModel(defaults, { temperature: 0.3 });
	assert.equal(effective.temperature, 0.3);
	assert.equal(effective.defaultReasoning, 'high');
	const forced = effectiveModel(defaults, { defaultReasoning: null });
	assert.equal(forced.defaultReasoning, null);
	const withoutHigh = effectiveModel(defaults, { reasoningEfforts: { low: 'low' } });
	assert.equal(withoutHigh.defaultReasoning, null, '有效能力不支持声明默认时不强制该档位');
});

test('getModelRows 给出完整目录：开关、原始覆盖、默认值与有效值', () => {
	const state = {
		active: { 'agent-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: {
			'acct-a:agent-plan': {
				source: 'arkcli',
				models: [
					{ id: 'known-model', name: '已知模型', maxTokens: 8192, input: ['text'], reasoningEfforts: { low: 'low', high: 'high' }, defaultReasoning: 'high', capabilityStatus: 'documented', capabilityUnverified: false },
					{ id: 'unknown-model', capabilityUnverified: true, contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: false }
				]
			}
		},
		modelSettings: { 'acct-a:agent-plan': { 'unknown-model': { enabled: false, temperature: 0.3 } } }
	};
	const rows = getModelRows(state, 'acct-a', 'agent-plan');
	assert.equal(rows.length, 2);
	const known = rows[0];
	assert.equal(known.id, 'known-model');
	assert.equal(known.name, '已知模型');
	assert.equal(known.enabled, true);
	assert.equal(known.capabilityUnverified, false);
	assert.deepEqual(known.settings, {});
	assert.equal(typeof known.defaults.contextWindow, 'number');
	assert.equal(typeof known.defaults.maxTokens, 'number');
	assert.equal(known.defaults.defaultReasoning, 'high');
	assert.equal(known.effective.defaultReasoning, 'high');
	const unknown = rows[1];
	assert.equal(unknown.enabled, false);
	assert.equal(unknown.capabilityUnverified, true);
	assert.equal(unknown.defaults.defaultReasoning, null, '非思考模型不强制默认档位');
	assert.equal(unknown.effective.temperature, 0.3);
});

test('getModelRows 在没有缓存时回退本地快照，在缓存损坏时给出空目录而不抛错', () => {
	const state = { active: { 'agent-plan': 'acct-a' }, accounts: [{ id: 'acct-a' }], catalogs: {}, modelSettings: {} };
	const rows = getModelRows(state, 'acct-a', 'agent-plan');
	assert.deepEqual(rows.map(row => row.id), snapshot['agent-plan'].models.map(model => model.id));
	const broken = { active: { 'agent-plan': 'acct-a' }, accounts: [{ id: 'acct-a' }], catalogs: { 'acct-a:agent-plan': { models: 'not-an-array' } }, modelSettings: {} };
	assert.deepEqual(getModelRows(broken, 'acct-a', 'agent-plan'), []);
});

test('profilesFor 只注册启用的套餐并过滤停用的模型', () => {
	const state = {
		enabled: { 'agent-plan': true, 'coding-plan': false },
		active: { 'agent-plan': 'acct-a', 'coding-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: {
			'acct-a:agent-plan': { models: [{ id: 'a-one' }, { id: 'a-two' }] },
			'acct-a:coding-plan': { models: [{ id: 'c-one' }] }
		},
		modelSettings: { 'acct-a:agent-plan': { 'a-two': { enabled: false } } }
	};
	const providers = profilesFor(state);
	assert.ok(ROUTES['agent-plan'] in providers);
	assert.ok(!(ROUTES['coding-plan'] in providers), '停用的套餐不应注册路由');
	assert.deepEqual(providers[ROUTES['agent-plan']].models.map(m => m.id), ['a-one']);
});

test('profilesFor 把有效参数写进 Core 模型描述，且不塞入 Core 不认识的字段', () => {
	const state = {
		enabled: { 'agent-plan': true },
		active: { 'agent-plan': 'acct-a' },
		accounts: [{ id: 'acct-a' }],
		catalogs: {
			'acct-a:agent-plan': {
				models: [{ id: 'a-one', contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: { low: 'low', high: 'high' } }]
			}
		},
		modelSettings: {
			'acct-a:agent-plan': { 'a-one': { temperature: 0.2, contextWindow: 65536, maxTokens: 4096, defaultReasoning: 'high', forceAdaptiveThinking: true } }
		}
	};
	const providers = profilesFor(state);
	const model = providers[ROUTES['agent-plan']].models[0];
	assert.equal(model.contextWindow, 65536);
	assert.equal(model.maxTokens, 4096);
	assert.deepEqual(model.reasoningEfforts, { low: 'low', high: 'high' });
	assert.equal(model.compat.forceAdaptiveThinking, true);
	for (const field of ['enabled', 'settings', 'temperature', 'defaultReasoning']) {
		assert.ok(!(field in model), `Core 模型描述不应含 ${field}`);
	}
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
