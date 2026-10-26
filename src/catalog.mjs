import { readFile } from 'node:fs/promises';
import { assertPlan, LABELS, ROUTES } from './state.mjs';
export const snapshot = JSON.parse(await readFile(new URL('./catalog-snapshot.json', import.meta.url), 'utf8'));
const modelId = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
export function normalizeCatalog(plan, response) {
	assertPlan(plan);
	if (response?.plan !== plan || !Array.isArray(response.models)) throw new Error('模型目录响应与所选订阅不匹配');
	if (response.models.length > 1000) throw new Error('模型目录过大');
	const seen = new Set();
	const models = response.models.map(row => {
		const id = row.output_name || row.model_id;
		if (typeof id !== 'string' || !modelId.test(id) || seen.has(id)) throw new Error('模型目录包含非法或重复 ID');
		seen.add(id);
		const known = snapshot[plan].models.find(m => m.id === id || m.id === row.model_id);
		return {
			...(known ? structuredClone(known) : { contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: false, compat: { forceAdaptiveThinking: false } }),
			id, name: typeof row.model_name === 'string' && row.model_name.length <= 200 ? row.model_name : id,
			...(known ? {} : { capabilityUnverified: true })
		};
	});
	return { models, source: 'arkcli', updatedAt: new Date().toISOString() };
}
export function usableModels(catalog, plan) {
	const rows = catalog === undefined || catalog === null ? snapshot[plan].models : catalog.models;
	if (!Array.isArray(rows)) throw new Error('本地模型缓存格式错误');
	return rows.map(row => {
		if (!modelId.test(row.id)) throw new Error('本地模型缓存包含非法 ID');
		const { capabilityUnverified: _unverified, ...model } = row;
		return model;
	});
}

// ── 目录默认值与用户覆盖 ────────────────────────────────────────────────────────

const positiveInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/**
 * 兼容默认档位：有效思考档位里支持 low 时采用 low，否则不强制任何档位。
 * 未知模型与非思考模型因此不会被塞进不支持的档位。
 */
export function defaultReasoningFor(efforts) {
	if (!efforts || efforts === false || typeof efforts !== 'object' || Array.isArray(efforts)) return null;
	const low = efforts.low;
	return typeof low === 'string' && low.trim() ? 'low' : null;
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
	return { contextWindow, maxTokens, reasoningEfforts: efforts, defaultReasoning: defaultReasoningFor(efforts), forceAdaptiveThinking };
}

/** 目录默认与用户覆盖合并后的有效参数。 */
export function effectiveModel(defaults, settings = {}) {
	const effective = { ...defaults };
	if (settings.contextWindow !== undefined) effective.contextWindow = settings.contextWindow;
	if (settings.maxTokens !== undefined) effective.maxTokens = settings.maxTokens;
	if (settings.reasoningEfforts !== undefined) effective.reasoningEfforts = settings.reasoningEfforts;
	if (settings.forceAdaptiveThinking !== undefined) effective.forceAdaptiveThinking = settings.forceAdaptiveThinking;
	if (settings.temperature !== undefined) effective.temperature = settings.temperature;
	effective.defaultReasoning = settings.defaultReasoning === undefined ? defaultReasoningFor(effective.reasoningEfforts) : settings.defaultReasoning;
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
	if (!Array.isArray(cached.models)) return { rows: [], count: 0, source: 'invalid-cache', broken: true };
	return { rows: cached.models.map(model => structuredClone(model)), count: cached.models.length, source: cached.source ?? 'arkcli', ...(cached.updatedAt ? { updatedAt: cached.updatedAt } : {}) };
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
		return {
			id: model.id,
			name: typeof model.name === 'string' && model.name ? model.name : model.id,
			enabled: settings.enabled !== false,
			capabilityUnverified: model.capabilityUnverified === true,
			settings: structuredClone(settings),
			defaults,
			effective: effectiveModel(defaults, settings)
		};
	});
}

export function providerProfile(plan, models) {
	const base = snapshot[assertPlan(plan)];
	// 不再下发 provider 级 reasoning：未知与非思考模型不得被强制送入 low 档位。
	const { reasoning: _globalReasoning, ...rest } = base;
	return { ...rest, models, displayName: LABELS[plan] };
}

/** 把有效参数写回 Core 的模型描述；只写 Core 认识的字段。 */
function coreModel(model, row) {
	if (!row) return { ...model };
	const compat = { ...(model.compat ?? {}) };
	if (typeof row.effective.forceAdaptiveThinking === 'boolean') compat.forceAdaptiveThinking = row.effective.forceAdaptiveThinking;
	return { ...model, contextWindow: row.effective.contextWindow, maxTokens: row.effective.maxTokens, reasoningEfforts: row.effective.reasoningEfforts, compat };
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
