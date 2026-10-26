// 火山方舟（Volcengine Ark）双订阅额度查询：管控面 OpenAPI 的 AK/SK 签名与套餐窗口归一化。
//
// 鉴权使用 IAM Access Key（AK/SK）的 HMAC-SHA256 签名，与推理用的方舟 API Key（Bearer /
// UUID 形态）是两套不同的凭据；本模块只接受 AK/SK。
//
// 签名流程与本机 dsh-subusage 的同名适配（MIT License, Copyright (c) 2026 KouzakiUmi）
// 的协议行为一致，但此处为独立实现：host / region / service / version 全部固定为常量，
// 不接受外部覆盖，避免把一份有效签名发往非官方主机；注释只陈述本模块实际实现的行为。
import { createHash, createHmac } from "node:crypto";

/** 官方管控面主机（固定，不接受调用方覆盖）。 */
export const VOLC_HOST = "open.volcengineapi.com";
export const VOLC_REGION = "cn-beijing";
export const VOLC_SERVICE = "ark";
export const VOLC_VERSION = "2024-01-01";
export const VOLC_PATH = "/";

/** 个人版 Coding Plan 的 Action。 */
export const CODING_ACTION = "GetCodingPlanUsage";
/** 个人版 Agent Plan 的 Action。 */
export const AGENT_ACTION = "GetAFPUsage";

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_ERROR_MESSAGE_LENGTH = 300;

/** 对外统一的安全错误类型：消息里不拼接任何凭据、签名或完整请求体。 */
export class VolcUsageError extends Error {
	constructor(message, { code = "VolcUsageError", cause } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "VolcUsageError";
		this.code = code;
	}
}

const sha256Hex = value => createHash("sha256").update(value ?? "").digest("hex");
const hmac = (key, value, encoding) => createHmac("sha256", key).update(value).digest(encoding);

/**
 * RFC3986 严格转义。encodeURIComponent 会放过 ! ' ( ) * ，签名要求把它们也转成 %XX。
 */
export function volcEscape(value) {
	return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** X-Date 格式：yyyyMMdd'T'HHmmss'Z'（UTC，无分隔符、无毫秒）。 */
export function volcDateFormat(ms) {
	return new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "");
}

/** 查询串按参数名升序拼接（Action 与 Version 走 query，不在 body 里）。 */
export function volcCanonicalQuery(params) {
	return Object.keys(params).sort().map(key => `${volcEscape(key)}=${volcEscape(params[key])}`).join("&");
}

function requireText(value, field) {
	if (typeof value !== "string" || !value.trim()) {
		throw new VolcUsageError(`${field} is required`, { code: "InvalidCredential" });
	}
	return value.trim();
}

/**
 * 生成一次调用的 URL 与签名头。
 *
 * 签名密钥派生链：
 *   kDate = HMAC(SK, yyyyMMdd) → kRegion = HMAC(kDate, region)
 *   → kService = HMAC(kRegion, service) → kSigning = HMAC(kService, "request")
 * 待签串与 AWS SigV4 同形，算法名写 HMAC-SHA256，scope 末段固定为 request。
 *
 * @param {object} input
 * @param {string} input.accessKeyId
 * @param {string} input.secretAccessKey
 * @param {string} input.action
 * @param {string} [input.body] 请求体，默认 "{}"
 * @param {number} [input.date] 毫秒时间戳，默认 Date.now()
 * @returns {{url: string, headers: Record<string, string>}}
 */
export function signRequest({ accessKeyId, secretAccessKey, action, body = "{}", date = Date.now() } = {}) {
	const ak = requireText(accessKeyId, "accessKeyId");
	const sk = requireText(secretAccessKey, "secretAccessKey");
	const act = requireText(action, "action");
	if (typeof body !== "string") {
		throw new VolcUsageError("body must be a string", { code: "InvalidRequest" });
	}
	const when = Number(date);
	if (!Number.isFinite(when)) {
		throw new VolcUsageError("date must be a finite timestamp", { code: "InvalidRequest" });
	}

	const xDate = volcDateFormat(when);
	const shortDate = xDate.slice(0, 8);
	const payloadHash = sha256Hex(body);
	const query = volcCanonicalQuery({ Action: act, Version: VOLC_VERSION });
	const signedHeaders = "content-type;host;x-content-sha256;x-date";
	const canonicalHeaders = [
		"content-type:application/json",
		`host:${VOLC_HOST}`,
		`x-content-sha256:${payloadHash}`,
		`x-date:${xDate}`
	].join("\n") + "\n";
	const credentialScope = `${shortDate}/${VOLC_REGION}/${VOLC_SERVICE}/request`;
	const canonicalRequest = ["POST", VOLC_PATH, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
	const signingKey = hmac(hmac(hmac(hmac(sk, shortDate), VOLC_REGION), VOLC_SERVICE), "request");
	return {
		url: `https://${VOLC_HOST}${VOLC_PATH}?${query}`,
		headers: {
			"content-type": "application/json",
			"x-content-sha256": payloadHash,
			"x-date": xDate,
			authorization: `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign, "hex")}`
		}
	};
}

// ── 解析辅助 ────────────────────────────────────────────────────────────────────

/** 额度字段是字符串数字（"50.0"）；只接受有限非负数，非法值返回 undefined（绝不当作 0）。 */
function amount(value) {
	if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
	}
	return undefined;
}

/** 重置时间戳：Coding Plan 是秒，Agent Plan 是毫秒。 */
function fromEpoch(value, unit) {
	const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
	if (typeof numeric !== "number" || !Number.isFinite(numeric)) return undefined;
	const ms = unit === "seconds" ? numeric * 1000 : numeric;
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	const time = new Date(ms).getTime();
	return Number.isFinite(time) ? new Date(ms).toISOString() : undefined;
}

function isPlainObject(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 把文本里出现的凭据替换掉；空值不参与，避免误伤正常内容。 */
function redact(text, secrets) {
	if (!text) return text;
	let output = text;
	for (const secret of secrets) {
		if (typeof secret !== "string") continue;
		const value = secret.trim();
		if (!value) continue;
		output = output.split(value).join("[REDACTED]");
	}
	return output;
}

/**
 * 业务信封错误：ResponseMetadata.Error 比 HTTP 状态码更能说明拒绝原因。
 * 只取 code 与 message；脱敏与长度限制由调用方在抛出前完成。
 */
export function volcError(body) {
	const error = body?.ResponseMetadata?.Error;
	if (!isPlainObject(error)) return undefined;
	const code = typeof error.Code === "string" && error.Code.trim() ? error.Code.trim() : "UnknownError";
	const message = typeof error.Message === "string" ? error.Message.trim() : "";
	return { code, message };
}

// ── 个人版 Coding Plan ──────────────────────────────────────────────────────────

// Level 是后端下发的窗口名；未登记的取值不产出窗口，也不猜语义。
const CODING_LEVELS = {
	session: "5h", "5h": "5h", five_hour: "5h", fivehour: "5h",
	weekly: "week", week: "week", "7d": "week", seven_day: "week",
	monthly: "month", month: "month", thirty_day: "month"
};

/**
 * 个人版 Coding Plan：Result.QuotaUsage[] 每项一个窗口。
 * Percent 是**已用百分数**（0–100），例如 0.39 就是已用 0.39%，不按「≤1 即小数」放大。
 * 接口只给百分比、不返回绝对量，因此不产出 detail。
 *
 * @param {object} body OpenAPI 响应体
 * @returns {{subscribed: boolean, windows: Array<{kind: string, percent: number, resetsAt?: string}>, plan?: string}}
 */
export function parseCodingUsage(body) {
	// 正常走 ResponseMetadata + Result 信封；个别抓包形态把字段放在顶层，两者都接受。
	const result = isPlainObject(body?.Result) ? body.Result : body;
	const rows = Array.isArray(result?.QuotaUsage) ? result.QuotaUsage : [];
	const windows = [];
	for (const row of rows) {
		const level = String(row?.Level ?? "").trim().toLowerCase();
		const kind = Object.hasOwn(CODING_LEVELS, level) ? CODING_LEVELS[level] : undefined;
		if (!kind) continue;
		const percent = amount(row?.Percent);
		if (percent === undefined) {
			throw new VolcUsageError("Volcengine Coding Plan percent is invalid", { code: "InvalidUsagePayload" });
		}
		windows.push({ kind, percent, resetsAt: fromEpoch(row?.ResetTimestamp, "seconds") });
	}
	const plan = typeof result?.PlanType === "string" && result.PlanType.trim() ? result.PlanType.trim() : undefined;
	return { subscribed: rows.length > 0, windows, plan };
}

// ── 个人版 Agent Plan ───────────────────────────────────────────────────────────

// AFP 窗口：Quota / Used 是绝对值，比例由两者算出。顺序即展示顺序。
// 分组（group）区分三条额度线：
//   - "text"：文本 / 向量模型走的 5 小时与周窗口；
//   - "all"：全能力月窗口；
//   - "daily-capabilities"：日窗口（面向日能力限额，与上面两条不是同一条线）。
// 分组必须保留，否则不同额度线并排展示时会被误读为同一账本。
const AFP_WINDOWS = [
	["AFPFiveHour", "5h", "text"],
	["AFPWeekly", "week", "text"],
	["AFPMonthly", "month", "all"],
	["AFPDaily", "day", "daily-capabilities"]
];

/**
 * 个人版 Agent Plan：Result 下四个滚动窗口。
 * Quota 为 0 / 缺失表示该窗口不适用（例如视觉模型不占 5 小时额度），不产出行、更不当成 0%。
 *
 * @param {object} body OpenAPI 响应体
 * @returns {{subscribed: boolean, windows: Array<{kind: string, percent: number, resetsAt?: string, group: string, detail: {used: number, limit: number, unit: string}}>, plan?: string}}
 */
export function parseAgentUsage(body) {
	const result = body?.Result;
	if (!isPlainObject(result)) return { subscribed: false, windows: [], plan: undefined };
	const windows = [];
	let reported = false;
	for (const [field, kind, group] of AFP_WINDOWS) {
		const row = result[field];
		if (!isPlainObject(row)) continue;
		reported = true;
		const quota = amount(row.Quota), used = amount(row.Used);
		if (quota === undefined || used === undefined) {
			throw new VolcUsageError("Volcengine AFP window is invalid", { code: "InvalidUsagePayload" });
		}
		if (quota <= 0) continue;
		windows.push({
			kind,
			percent: Math.min(100, used / quota * 100),
			resetsAt: fromEpoch(row.ResetTime, "milliseconds"),
			group,
			detail: { used, limit: quota, unit: "AFP" }
		});
	}
	const plan = typeof result.PlanType === "string" && result.PlanType.trim() ? result.PlanType.trim() : undefined;
	return { subscribed: windows.length > 0 || reported, windows, plan };
}

// ── 发起请求 ────────────────────────────────────────────────────────────────────

function parsePlan(plan) {
	const key = typeof plan === "string" ? plan.trim().toLowerCase() : "";
	if (key === "coding" || key === "codingplan" || key === "coding-plan") {
		return { key: "coding", action: CODING_ACTION, parse: parseCodingUsage };
	}
	if (key === "agent" || key === "agentplan" || key === "agent-plan") {
		return { key: "agent", action: AGENT_ACTION, parse: parseAgentUsage };
	}
	throw new VolcUsageError(`Unsupported Volcengine plan: ${key || "(empty)"}`, { code: "UnsupportedPlan" });
}

/**
 * 调用对应 Action 并返回归一化后的额度。
 *
 * @param {"coding"|"agent"} plan
 * @param {{accessKeyId: string, secretAccessKey: string}} credentials
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<{subscribed: boolean, windows: Array<object>, plan?: string}>}
 */
export async function fetchUsage(plan, { accessKeyId, secretAccessKey } = {}, { fetchImpl = fetch, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const target = parsePlan(plan);
	const { url, headers } = signRequest({ accessKeyId, secretAccessKey, action: target.action });

	if (typeof fetchImpl !== "function") {
		throw new VolcUsageError("fetchImpl must be a function", { code: "InvalidRequest" });
	}
	const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

	const timeoutSignal = AbortSignal.timeout(limit);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: "{}",
			redirect: "error",
			signal: requestSignal
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new VolcUsageError("Volcengine usage request was aborted by the caller", { code: "Aborted", cause: error });
		}
		if (timeoutSignal.aborted) {
			throw new VolcUsageError(`Volcengine usage request timed out after ${limit}ms`, { code: "Timeout", cause: error });
		}
		throw new VolcUsageError(`Volcengine usage request failed: ${error instanceof Error ? error.name : "network error"}`, { code: "NetworkError", cause: error });
	}

	let text;
	try {
		text = await response.text();
	} catch (error) {
		throw new VolcUsageError("Volcengine usage response body could not be read", { code: "InvalidResponse", cause: error });
	}

	let body;
	let parseFailed = false;
	if (text && text.trim()) {
		try {
			body = JSON.parse(text);
		} catch {
			parseFailed = true;
		}
	}

	const failure = volcError(body);
	if (failure) {
		// 服务端消息可能回显请求上下文：先洗掉凭据本身，再截断长度。
		const cleaned = redact(failure.message, [accessKeyId, secretAccessKey]);
		const message = cleaned.length > MAX_ERROR_MESSAGE_LENGTH ? `${cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : cleaned;
		const detail = message ? `${failure.code}: ${message}` : failure.code;
		throw new VolcUsageError(`Volcengine ${target.action} failed — ${detail}`, { code: failure.code });
	}
	if (!response.ok) {
		throw new VolcUsageError(`Volcengine ${target.action} failed with HTTP ${response.status}`, { code: `Http${response.status}` });
	}
	if (parseFailed) {
		throw new VolcUsageError(`Volcengine ${target.action} returned a response that is not valid JSON`, { code: "InvalidResponse" });
	}
	if (body === undefined) {
		return { subscribed: false, windows: [], plan: undefined };
	}
	return target.parse(body);
}
