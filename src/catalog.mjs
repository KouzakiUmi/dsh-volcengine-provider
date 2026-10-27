import { readFile } from 'node:fs/promises';
import { assertModelId, assertPlan, LABELS, ROUTES, BUDGET_THINKING_LEVELS } from './state.mjs';
export const snapshot = JSON.parse(await readFile(new URL('./catalog-snapshot.json', import.meta.url), 'utf8'));
const modelId = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
function validateModelRows(rows) {
	if (!Array.isArray(rows) || rows.length > 1000) throw new Error('本地模型缓存格式错误');
	const seen = new Set();
	for (const row of rows) {
		if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('本地模型缓存格式错误');
		try { assertModelId(row.id); } catch { throw new Error('本地模型缓存包含非法 ID'); }
		if (seen.has(row.id)) throw new Error('本地模型缓存包含重复 ID');
		seen.add(row.id);
	}
	return rows;
}
// Only explicit, source-audited aliases are matched. Never strip version/date
// suffixes or punctuation to guess whether two models have the same limits.
function snapshotModel(plan, id) {
	if (typeof id !== 'string') return undefined;
	return snapshot[plan].models.find(model => model.id === id || model.aliases?.includes(id));
}
function pinnedCapabilities(model) {
	const { aliases: _aliases, ...capabilities } = structuredClone(model);
	return capabilities;
}
function fallbackCapabilities(id) {
	const dynamic = id === 'auto';
	return {
		contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: false,
		compat: { forceAdaptiveThinking: false }, defaultReasoning: null,
		messagesThinkingMode: 'server-default', canDisableThinking: null,
		capabilityStatus: dynamic ? 'dynamic' : 'unknown', capabilityUnverified: true,
		capabilityNote: dynamic ? '智能调度的能力随目标模型变化，未声明统一思考档位。' : '该精确版本尚无固化能力资料，采用保守配置。'
	};
}
// Core 只支持文本与图片两种输入模态；目录声明的其它模态（含音视频）不被接受。
const CORE_INPUT_MODALITIES = ['text', 'image'];
// 目录没有声明输入模态时沿用既有 fallback：只接文本。
const FALLBACK_INPUT = ['text'];
/**
 * 检查目录声明的输入模态。
 * 缺失按既有 fallback 处理；非数组、含重复或含未支持模态一律判为无效：
 * 不能悄悄退化成纯文本，否则损坏的目录会被伪装成可用路由。
 * 调用方自行决定是报错（路由构建）还是只作提示（设置页）。
 */
function inspectInput(modalities) {
	if (modalities === undefined) return { input: [...FALLBACK_INPUT] };
	if (!Array.isArray(modalities) || !modalities.length) return { error: '模型目录的输入模态格式错误' };
	const seen = new Set();
	for (const value of modalities) {
		if (typeof value !== 'string' || !CORE_INPUT_MODALITIES.includes(value)) return { error: '模型目录的输入模态不受支持' };
		if (seen.has(value)) return { error: '模型目录的输入模态包含重复项' };
		seen.add(value);
	}
	return { input: [...modalities] };
}
function coreCapabilities(model) {
	const {
		aliases: _aliases, capabilityUnverified: _unverified, defaultReasoning: _default,
		messagesThinkingMode: _mode, canDisableThinking: _disable,
		capabilityStatus: _status, capabilityNote: _note,
		toolsEnabled: _tools, imageInput: _image, ...capabilities
	} = model;
	if ('input' in capabilities) {
		const checked = inspectInput(capabilities.input);
		// 路由构建阶段直接拒绝：坏目录不得被当成纯文本模型注册。
		if (checked.error) throw new Error(`${checked.error}：${model.id ?? '未知模型'}`);
		capabilities.input = checked.input;
	}
	return capabilities;
}
function displayName(id, candidate, pinned) {
	const fallback = id === 'auto' ? 'Auto（智能调度）' : pinned?.name || id;
	if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 200 || /[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
	const name = candidate.trim();
	// Readable server labels remain valid; IDs and punctuation-separated code
	// labels use the pinned presentation name instead of a second machine ID.
	const codes = [id, pinned?.id, ...(pinned?.aliases ?? [])].filter(Boolean);
	const codeLabel = codes.some(code => code.toLowerCase() === name.toLowerCase()) || /^[A-Za-z0-9]+(?:[_.:/-][A-Za-z0-9]+)+$/.test(name);
	if ((pinned || id === 'auto') && codeLabel) return fallback;
	return name;
}
function reconcileModel(plan, row) {
	const pinned = snapshotModel(plan, row.id);
	if (!pinned) {
		const fallback = fallbackCapabilities(row.id);
		const reconciled = { ...fallback, ...structuredClone(row), name: displayName(row.id, row.name) };
		// Auto is a routing policy, not the reasoning declaration of a stale target.
		if (row.id === 'auto') Object.assign(reconciled, fallback, { contextWindow: row.contextWindow ?? fallback.contextWindow, maxTokens: row.maxTokens ?? fallback.maxTokens, name: displayName(row.id, row.name) });
		return reconciled;
	}
	return { ...pinnedCapabilities(pinned), id: row.id, name: displayName(row.id, row.name, pinned) };
}
export function normalizeCatalog(plan, response) {
	assertPlan(plan);
	if (response?.plan !== plan || !Array.isArray(response.models)) throw new Error('模型目录响应与所选订阅不匹配');
	if (response.models.length > 1000) throw new Error('模型目录过大');
	const seen = new Set();
	const models = response.models.map(row => {
		if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('模型目录包含非法或重复 ID');
		const id = row.output_name || row.model_id;
		if (typeof id !== 'string' || !modelId.test(id) || seen.has(id)) throw new Error('模型目录包含非法或重复 ID');
		try { assertModelId(id); } catch { throw new Error('模型目录包含非法或重复 ID'); }
		seen.add(id);
		const known = snapshotModel(plan, id) ?? snapshotModel(plan, row.model_id);
		return {
			...(known ? pinnedCapabilities(known) : fallbackCapabilities(id)),
			id, name: displayName(id, row.model_name, known)
		};
	});
	return { models, source: 'arkcli', updatedAt: new Date().toISOString() };
}
export function usableModels(catalog, plan) {
	assertPlan(plan);
	const rows = catalog === undefined || catalog === null ? snapshot[plan].models : catalog.models;
	return validateModelRows(rows).map(row => coreCapabilities(reconcileModel(plan, row)));
}

// ── 目录默认值与用户覆盖 ────────────────────────────────────────────────────────

const positiveInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Only an explicitly documented and currently supported default is applied. */
export function defaultReasoningFor(efforts, declared = null) {
	if (!efforts || efforts === false || typeof efforts !== 'object' || Array.isArray(efforts)) return null;
	return typeof declared === 'string' && Object.hasOwn(efforts, declared) ? declared : null;
}

const budgetCompatible = ([level, wire]) => BUDGET_THINKING_LEVELS.includes(level) && (level === 'off' ? wire === null : wire === level);
function inheritedBudgetMap(efforts) {
	if (!efforts || typeof efforts !== 'object') return efforts;
	const entries = Object.entries(efforts).filter(budgetCompatible);
	return entries.some(([level]) => level !== 'off') ? Object.fromEntries(entries) : false;
}

/** 目录自身的默认能力；provider 级缺省在这里解析成具体数字。 */
export function modelDefaults(plan, model) {
	const base = snapshot[assertPlan(plan)];
	const contextWindow = positiveInteger(model?.contextWindow) ?? positiveInteger(base.defaultContextWindow) ?? 32768;
	const maxTokens = positiveInteger(model?.maxTokens) ?? positiveInteger(base.defaultMaxTokens) ?? 8192;
	const efforts = model && model.reasoningEfforts !== undefined ? model.reasoningEfforts : false;
	const forceAdaptiveThinking = typeof model?.compat?.forceAdaptiveThinking === 'boolean'
		? model.compat.forceAdaptiveThinking
		: typeof base.compat?.forceAdaptiveThinking === 'boolean' ? base.compat.forceAdaptiveThinking : false;
	// 图片输入取模型实际声明的模态；工具开关默认开启，保持既有工具行为不变。
	const imageInput = Array.isArray(model?.input) && model.input.includes('image');
	return { contextWindow, maxTokens, reasoningEfforts: efforts, defaultReasoning: defaultReasoningFor(efforts, model?.defaultReasoning), forceAdaptiveThinking, imageInput, toolsEnabled: true };
}

/** 目录默认与用户覆盖合并后的有效参数。 */
export function effectiveModel(defaults, settings = {}) {
	const effective = { ...defaults };
	if (settings.contextWindow !== undefined) effective.contextWindow = settings.contextWindow;
	if (settings.maxTokens !== undefined) effective.maxTokens = settings.maxTokens;
	else if (effective.maxTokens > effective.contextWindow) effective.maxTokens = effective.contextWindow;
	if (settings.reasoningEfforts !== undefined) effective.reasoningEfforts = settings.reasoningEfforts;
	if (settings.forceAdaptiveThinking !== undefined) effective.forceAdaptiveThinking = settings.forceAdaptiveThinking;
	if (settings.forceAdaptiveThinking === false && settings.reasoningEfforts === undefined) effective.reasoningEfforts = inheritedBudgetMap(effective.reasoningEfforts);
	if (settings.temperature !== undefined) effective.temperature = settings.temperature;
	if (settings.imageInput !== undefined) effective.imageInput = settings.imageInput;
	if (settings.toolsEnabled !== undefined) effective.toolsEnabled = settings.toolsEnabled;
	effective.defaultReasoning = defaultReasoningFor(effective.reasoningEfforts, settings.defaultReasoning === undefined ? defaults.defaultReasoning : settings.defaultReasoning);
	return effective;
}

function bucketOf(state, key) {
	const source = state?.modelSettings;
	if (!source || typeof source !== 'object') return undefined;
	return Object.hasOwn(source, key) ? source[key] : undefined;
}

/** 某个账号套餐的目录现状：缓存缺失时回退本地快照，缓存损坏时标记 invalid-cache。 */
export function catalogStatus(state, accountId, plan) {
	assertPlan(plan);
	const key = `${accountId}:${plan}`;
	const source = state?.catalogs;
	const cached = source && typeof source === 'object' && Object.hasOwn(source, key) ? source[key] : undefined;
	if (cached === undefined || cached === null) {
		return { rows: snapshot[plan].models.map(model => structuredClone(model)), count: snapshot[plan].models.length, source: 'local-snapshot' };
	}
	try { validateModelRows(cached.models); }
	catch { return { rows: [], count: 0, source: 'invalid-cache', broken: true }; }
	return { rows: cached.models.map(model => reconcileModel(plan, model)), count: cached.models.length, source: cached.source ?? 'arkcli', ...(cached.updatedAt ? { updatedAt: cached.updatedAt } : {}) };
}

/**
 * 某个账号套餐的完整模型目录：默认能力、用户覆盖与有效参数一次给出。
 * 目录损坏时不抛错，交由调用方按 invalid-cache 处理。
 */
export function getModelRows(state, accountId, plan) {
	const status = catalogStatus(state, accountId, plan);
	const bucket = bucketOf(state, `${accountId}:${plan}`);
	const overrides = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket : {};
	return status.rows.map(model => {
		const override = Object.hasOwn(overrides, model.id) ? overrides[model.id] : {};
		const settings = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
		const defaults = modelDefaults(plan, model);
		const effective = effectiveModel(defaults, settings);
		const warnings = [];
		// 目录声明的输入模态无效时设置页仍可读，但路由构建会拒绝该目录。
		const declaredInput = inspectInput(model.input);
		if (declaredInput.error) warnings.push(`${declaredInput.error}：该目录会导致路由更新失败；若已有可用路由会予以保留，请重新拉取模型目录。`);
		if (settings.imageInput === true && defaults.imageInput === false) warnings.push('已强制开启图片输入：目录未声明该模型支持图片，请先确认服务端能力。');
		if (model.canDisableThinking === false && effective.reasoningEfforts?.off === null) {
			const { off: _off, ...levels } = effective.reasoningEfforts;
			effective.reasoningEfforts = Object.keys(levels).length ? levels : false;
			effective.defaultReasoning = defaultReasoningFor(effective.reasoningEfforts, effective.defaultReasoning);
			warnings.push('该模型为常驻思考，已保存的关闭选项不生效；原设置保留，请调整档位映射。');
		}
		if (settings.forceAdaptiveThinking === false && settings.reasoningEfforts === undefined && defaults.reasoningEfforts) {
			const omitted = Object.entries(defaults.reasoningEfforts).filter(entry => !budgetCompatible(entry)).map(([level]) => level);
			if (omitted.length) warnings.push(`已保存的固定预算模式无法表达继承档位 ${omitted.join('/')}；暂不提供这些档位，原设置保留，请调整思考模式或显式映射。`);
		}
		if (typeof settings.defaultReasoning === 'string' && settings.defaultReasoning !== effective.defaultReasoning) warnings.push(`已保存的默认思考档位 ${settings.defaultReasoning} 不在当前目录中；暂不强制该档位，请重新选择。`);
		const settingsWarning = warnings.join(' ');
		return {
			id: model.id,
			name: typeof model.name === 'string' && model.name ? model.name : model.id,
			enabled: settings.enabled !== false,
			capabilityUnverified: model.capabilityUnverified === true,
			messagesThinkingMode: model.messagesThinkingMode ?? 'server-default',
			canDisableThinking: model.canDisableThinking ?? null,
			capabilityStatus: model.capabilityStatus ?? 'unknown',
			...(model.capabilityNote ? { capabilityNote: model.capabilityNote } : {}),
			settings: structuredClone(settings),
			...(settingsWarning ? { settingsWarning } : {}),
			defaults,
			effective
		};
	});
}

export function providerProfile(plan, models) {
	const base = snapshot[assertPlan(plan)];
	// 不再下发 provider 级 reasoning：未知与非思考模型不得被强制送入 low 档位。
	const { reasoning: _globalReasoning, ...rest } = base;
	return { ...rest, models: models.map(coreCapabilities), displayName: LABELS[plan] };
}

/** 把有效参数写回 Core 的模型描述；只写 Core 认识的字段。 */
function coreModel(model, row) {
	// 目录声明的输入模态在此之前已被校验；畸形目录不会走到这里。
	if (!row) return coreCapabilities(model);
	const compat = { ...(model.compat ?? {}) };
	if (typeof row.effective.forceAdaptiveThinking === 'boolean') compat.forceAdaptiveThinking = row.effective.forceAdaptiveThinking;
	// 目录声明有效时，Core 的输入模态由图片开关决定：text 或 text+image。
	const input = row.effective.imageInput ? ['text', 'image'] : ['text'];
	// 工具开关只经 factsByProvider 的行传给适配器，不作为 Core 字段下发。
	return { ...coreCapabilities(model), input, contextWindow: row.effective.contextWindow, maxTokens: row.effective.maxTokens, reasoningEfforts: row.effective.reasoningEfforts, compat };
}

export function profilesFor(state) {
	const providers = {};
	for (const plan of Object.keys(ROUTES)) {
		if (state.enabled?.[plan] === false) continue;
		const id = state.active?.[plan];
		const owner = state.accounts?.find(a => a.id === id);
		if (!owner) continue;
		const models = usableModels(state.catalogs[`${id}:${plan}`], plan);
		const rows = new Map(getModelRows(state, id, plan).map(row => [row.id, row]));
		const overrides = bucketOf(state, `${id}:${plan}`) ?? {};
		const prepared = models
			.filter(model => overrides?.[model.id]?.enabled !== false)
			.map(model => coreModel(model, rows.get(model.id)));
		// Credentials are resolved by a host-owned adapter closure, never in this document.
		providers[ROUTES[plan]] = providerProfile(plan, prepared);
	}
	return providers;
}
