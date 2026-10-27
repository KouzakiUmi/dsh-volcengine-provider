import { readFile } from 'node:fs/promises';
import { assertModelId, assertPlan, LABELS, ROUTES } from './state.mjs';
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
	if (!pinned) return { ...structuredClone(row), name: displayName(row.id, row.name) };
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
			...(known ? pinnedCapabilities(known) : { contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: false, compat: { forceAdaptiveThinking: false } }),
			id, name: displayName(id, row.model_name, known),
			...(known ? {} : { capabilityUnverified: true })
		};
	});
	return { models, source: 'arkcli', updatedAt: new Date().toISOString() };
}
export function usableModels(catalog, plan) {
	assertPlan(plan);
	const rows = catalog === undefined || catalog === null ? snapshot[plan].models : catalog.models;
	return validateModelRows(rows).map(row => {
		const { capabilityUnverified: _unverified, aliases: _aliases, ...model } = reconcileModel(plan, row);
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
	else if (effective.maxTokens > effective.contextWindow) effective.maxTokens = effective.contextWindow;
	if (settings.reasoningEfforts !== undefined) effective.reasoningEfforts = settings.reasoningEfforts;
	if (settings.forceAdaptiveThinking !== undefined) effective.forceAdaptiveThinking = settings.forceAdaptiveThinking;
	if (settings.temperature !== undefined) effective.temperature = settings.temperature;
	effective.defaultReasoning = settings.defaultReasoning === undefined ? defaultReasoningFor(effective.reasoningEfforts) : settings.defaultReasoning;
	if (typeof effective.defaultReasoning === 'string' && (!effective.reasoningEfforts || !Object.hasOwn(effective.reasoningEfforts, effective.defaultReasoning))) effective.defaultReasoning = null;
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
		const settingsWarning = typeof settings.defaultReasoning === 'string' && settings.defaultReasoning !== effective.defaultReasoning
			? `已保存的默认思考档位 ${settings.defaultReasoning} 不在当前目录中；暂不强制该档位，请重新选择。` : undefined;
		return {
			id: model.id,
			name: typeof model.name === 'string' && model.name ? model.name : model.id,
			enabled: settings.enabled !== false,
			capabilityUnverified: model.capabilityUnverified === true,
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
