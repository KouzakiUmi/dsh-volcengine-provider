import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export const STATE_VERSION = 2;
export const PLANS = ['agent-plan', 'coding-plan'];
export const ROUTES = { 'agent-plan': 'volcengine-agent-plan', 'coding-plan': 'volcengine-coding-plan' };
export const LABELS = { 'agent-plan': '火山方舟 · Agent 套餐', 'coding-plan': '火山方舟 · 编程套餐' };
// Core（pi-ai）已声明的思考档位，模型设置只接受这些键。
export const CORE_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// 逐模型覆盖允许出现的字段；其余字段一律拒绝（含任何凭据字段）。
export const MODEL_SETTING_FIELDS = ['enabled', 'contextWindow', 'maxTokens', 'temperature', 'reasoningEfforts', 'defaultReasoning', 'forceAdaptiveThinking'];
// 预算模式（未开启自适应思考）下 Core 只消费档位键：xhigh/max 会被折叠为 high，映射值也不再上线。
export const BUDGET_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const refPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const reservedNames = ['constructor', 'prototype', '__proto__'];

// 动态键一律走 defineProperty，避免 `__proto__` 之类的键污染原型链。
function setKey(target, key, value) {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
	return target;
}
export function assertPlan(plan) {
	if (!PLANS.includes(plan)) throw new Error('未知订阅类型');
	return plan;
}
export function assertModelId(modelId) {
	if (typeof modelId !== 'string' || !modelIdPattern.test(modelId) || reservedNames.includes(modelId)) throw new Error('模型 ID 不合法');
	return modelId;
}
export function account(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('账号格式错误');
	const allowed = ['id', 'label', 'apiKeyRefs', 'accessKeyRef', 'secretKeyRef', 'cliProfile'];
	if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('只接受凭据引用，不接受密钥');
	if (typeof input.id !== 'string' || !idPattern.test(input.id) || ['constructor', 'prototype', '__proto__'].includes(input.id)) throw new Error('账号 ID 须为小写字母、数字或连字符，且不能使用保留名称');
	if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80) throw new Error('账号名称不合法');
	const apiKeyRefs = {};
	for (const plan of PLANS) {
		const ref = input.apiKeyRefs?.[plan];
		if (ref !== undefined && (!refPattern.test(ref) || typeof ref !== 'string')) throw new Error('推理凭据引用不合法');
		if (ref) apiKeyRefs[plan] = ref;
	}
	for (const k of ['accessKeyRef', 'secretKeyRef']) if (input[k] !== undefined && (typeof input[k] !== 'string' || (input[k] !== '' && !refPattern.test(input[k])))) throw new Error('AK/SK 凭据引用不合法');
	if (input.cliProfile !== undefined && (typeof input.cliProfile !== 'string' || !/^[\w.-]{1,80}$/.test(input.cliProfile))) throw new Error('ArkCli profile 名称不合法');
	return { id: input.id, label: input.label.trim(), apiKeyRefs, accessKeyRef: input.accessKeyRef ?? '', secretKeyRef: input.secretKeyRef ?? '', ...(input.cliProfile ? { cliProfile: input.cliProfile } : {}) };
}

// ── 逐模型覆盖 ──────────────────────────────────────────────────────────────────

/** 规范化思考档位映射：false 或 { 档位: 上线拼写 }，只有 off 可以为空。 */
export function normalizeReasoningEfforts(value) {
	if (value === false) return false;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('思考档位格式错误');
	const efforts = {};
	for (const [level, wire] of Object.entries(value)) {
		if (!CORE_THINKING_LEVELS.includes(level)) throw new Error(`思考档位 ${level} 不受支持`);
		if (wire === null) {
			if (level !== 'off') throw new Error('思考档位中只有 off 允许为空值');
			setKey(efforts, level, null);
			continue;
		}
		if (typeof wire !== 'string' || !wire.trim()) throw new Error('思考档位映射必须是非空字符串');
		setKey(efforts, level, wire);
	}
	const levels = Object.keys(efforts);
	if (!levels.length) throw new Error('思考档位不能为空');
	if (!levels.some(level => level !== 'off')) throw new Error('至少需要声明一个非 off 的思考档位');
	return efforts;
}

/**
 * 预算模式下的档位校验：Core 的 simple-options 按档位键取思考预算，xhigh/max 一律折叠为 high，
 * 映射值不参与上线。因此该模式下只接受 off/minimal/low/medium/high，非 off 映射必须与键同名。
 * 与 Core 已核实消费端一致，不做静默折叠。
 */
export function assertBudgetCompatibleEfforts(efforts, forceAdaptiveThinking) {
	if (forceAdaptiveThinking !== false) return;
	if (!efforts || efforts === false) return;
	for (const [level, wire] of Object.entries(efforts)) {
		if (!BUDGET_THINKING_LEVELS.includes(level)) throw new Error(`预算模式下思考档位 ${level} 会被折叠为 high，请改用 ${BUDGET_THINKING_LEVELS.join('/')}`);
		if (level === 'off') { if (wire !== null) throw new Error('预算模式下 off 档位只能为空值'); continue; }
		if (wire !== level) throw new Error(`预算模式下思考档位 ${level} 的映射值必须与档位同名，否则不会上线`);
	}
}

/**
 * 规范化一份逐模型覆盖值。字段级规则与同对象内的相互约束在这里裁决；
 * 依赖目录默认值的关系（例如 maxTokens 与有效 contextWindow 的比较）由上层用目录解析后校验。
 */
export function normalizeModelSettings(input) {
	if (input === undefined || input === null) return {};
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模型设置格式错误');
	for (const key of Object.keys(input)) if (!MODEL_SETTING_FIELDS.includes(key)) throw new Error(`模型设置包含未知字段：${key}`);
	const settings = {};
	if ('enabled' in input) {
		if (typeof input.enabled !== 'boolean') throw new Error('模型启用状态必须是布尔值');
		settings.enabled = input.enabled;
	}
	for (const key of ['contextWindow', 'maxTokens']) {
		if (!(key in input)) continue;
		const value = input[key];
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} 必须是正安全整数`);
		settings[key] = value;
	}
	if ('temperature' in input) {
		const value = input.temperature;
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('temperature 必须是 0 到 1 之间的数值');
		settings.temperature = value;
	}
	if ('forceAdaptiveThinking' in input) {
		if (typeof input.forceAdaptiveThinking !== 'boolean') throw new Error('forceAdaptiveThinking 必须是布尔值');
		settings.forceAdaptiveThinking = input.forceAdaptiveThinking;
	}
	if ('reasoningEfforts' in input) settings.reasoningEfforts = normalizeReasoningEfforts(input.reasoningEfforts);
	if ('defaultReasoning' in input) {
		const value = input.defaultReasoning;
		if (value !== null) {
			if (typeof value !== 'string' || !CORE_THINKING_LEVELS.includes(value)) throw new Error('默认思考档位不受支持');
			if (settings.reasoningEfforts === false) throw new Error('该模型没有可选思考档位，不能指定默认思考档位');
			if (settings.reasoningEfforts !== undefined && !(value in settings.reasoningEfforts)) throw new Error('默认思考档位未被思考档位映射支持');
		}
		settings.defaultReasoning = value;
	}
	if (settings.contextWindow !== undefined && settings.maxTokens !== undefined && settings.maxTokens > settings.contextWindow) throw new Error('maxTokens 不得超过 contextWindow');
	if (settings.forceAdaptiveThinking === false) assertBudgetCompatibleEfforts(settings.reasoningEfforts, false);
	return settings;
}

/** 归一化整份 modelSettings：丢弃不存在的账号与未知套餐，模型 ID 与字段逐项校验。 */
function normalizeModelSettingsMap(value, accounts) {
	const result = {};
	if (value === undefined || value === null) return result;
	if (typeof value !== 'object' || Array.isArray(value)) throw new Error('模型设置格式错误');
	for (const [key, bucket] of Object.entries(value)) {
		const separator = key.lastIndexOf(':');
		if (separator <= 0) continue;
		const accountId = key.slice(0, separator);
		const plan = key.slice(separator + 1);
		if (!PLANS.includes(plan)) continue;
		if (!accounts.some(a => a.id === accountId)) continue;
		if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error('模型设置格式错误');
		const models = {};
		for (const [modelId, settings] of Object.entries(bucket)) {
			assertModelId(modelId);
			const normalized = normalizeModelSettings(settings);
			if (!Object.keys(normalized).length) continue;
			setKey(models, modelId, normalized);
		}
		if (Object.keys(models).length) setKey(result, key, models);
	}
	return result;
}

export function initialState() {
	return {
		version: STATE_VERSION,
		accounts: [account({ id: 'default', label: '现有方舟账号', apiKeyRefs: { 'agent-plan': 'ARKCLI_AGENT_PLAN_API_KEY', 'coding-plan': 'ARKCLI_CODING_PLAN_API_KEY' }, accessKeyRef: 'VOLC_ACCESSKEY', secretKeyRef: 'VOLC_SECRETKEY' })],
		active: { 'agent-plan': 'default', 'coding-plan': 'default' },
		enabled: { 'agent-plan': true, 'coding-plan': true },
		catalogs: {},
		oauth: {},
		modelSettings: {}
	};
}
export function validateState(value) {
	const version = value?.version;
	if (version !== 1 && version !== STATE_VERSION) throw new Error('账号状态格式不兼容');
	if (!Array.isArray(value.accounts) || value.accounts.length > 50) throw new Error('账号状态格式不兼容');
	const accounts = value.accounts.map(account);
	if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw new Error('账号 ID 重复');
	const active = {};
	for (const plan of PLANS) {
		const id = value.active?.[plan];
		if (id !== null && id !== undefined && !accounts.some(a => a.id === id)) throw new Error('所选账号不存在');
		active[plan] = id ?? null;
	}
	// Catalogs are validated at the point of use, never executable configuration.
	const catalogs = value.catalogs && typeof value.catalogs === 'object' && !Array.isArray(value.catalogs) ? value.catalogs : {};
	const oauth = {};
	for (const owner of accounts) {
		const binding = value.oauth?.[owner.id];
		if (!binding) continue;
		const profiles = {};
		for (const plan of PLANS) {
			const profile = binding.profiles?.[plan];
			if (profile !== undefined && (typeof profile !== 'string' || profile.length > 200 || /[\x00-\x1f]/.test(profile))) throw new Error('OAuth profile 绑定格式错误');
			if (profile) profiles[plan] = profile;
		}
		oauth[owner.id] = { profiles, loggedAt: typeof binding.loggedAt === 'string' ? binding.loggedAt : '' };
	}
	// 版本 1 没有 enabled：有所选账号的套餐视为启用，原来未选择账号的套餐视为停用。
	const enabled = {};
	for (const plan of PLANS) {
		const declared = version === 1 ? undefined : value.enabled?.[plan];
		if (declared !== undefined && typeof declared !== 'boolean') throw new Error('套餐启用状态必须是布尔值');
		enabled[plan] = declared ?? Boolean(active[plan]);
	}
	const modelSettings = normalizeModelSettingsMap(value.modelSettings, accounts);
	return { version: STATE_VERSION, accounts, active, enabled, catalogs, oauth, modelSettings };
}
export const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class StateStore {
	constructor(path) { this.path = path; this.current = null; this.queue = Promise.resolve(); }
	async load() {
		try { this.current = validateState(JSON.parse(await readFile(this.path, 'utf8'))); }
		catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取方舟账号状态；原文件未被覆盖'); this.current = initialState(); }
		return this.current;
	}
	mutate(expectedRevision, change) {
		const operation = this.queue.then(async () => {
			if (expectedRevision !== revision(this.current)) throw new Error('设置已改变，请刷新后重试');
			const next = validateState(change(structuredClone(this.current)));
			await mkdir(dirname(this.path), { recursive: true });
			const temp = `${this.path}.${process.pid}.tmp`;
			await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
			await rename(temp, this.path);
			this.current = next;
			return next;
		});
		this.queue = operation.catch(() => {});
		return operation;
	}
}
