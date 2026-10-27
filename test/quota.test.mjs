// 火山方舟双订阅额度模块的单元测试：node --test test/quota.test.mjs
// 全部用例使用假 fetch 与假凭据，不访问任何真实接口、不读取任何凭据文件。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	VolcUsageError,
	signRequest,
	parseCodingUsage,
	parseAgentUsage,
	fetchUsage,
	CODING_ACTION,
	AGENT_ACTION,
	VOLC_HOST
} from "../src/quota.mjs";

const AK = "AKLTtestaccesskeyid";
const SK = "testsecretaccesskey0123456789";
const CREDS = { accessKeyId: AK, secretAccessKey: SK };
/** 固定时间：2024-01-01T00:00:00Z。 */
const DATE = Date.UTC(2024, 0, 1, 0, 0, 0);

// 下面的期望值由 OpenSSL（openssl dgst -mac HMAC + hexkey）逐层独立推导，
// 与 src/quota.mjs 的 Node crypto 路径不同，用于锁定签名算法本身。
const VECTOR = {
	url: "https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01",
	payloadHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
	credentialScope: "20240101/cn-beijing/ark/request",
	signature: "1c33b4cfded95bd478edd0055396b856137f8456000c8daf2b3a15a0b13ce3d4"
};

/** 构造一个最小可用的假 Response。 */
function fakeResponse(body, { ok = true, status = 200 } = {}) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		ok,
		status,
		async text() {
			return text;
		}
	};
}

/** 记录调用参数的假 fetch。 */
function recordingFetch(response, calls = []) {
	return async (url, init) => {
		calls.push({ url, init });
		return typeof response === "function" ? response(url, init) : response;
	};
}

// ── 签名 ───────────────────────────────────────────────────────────────────────

test("signRequest 命中固定签名向量（OpenSSL 独立推导）", () => {
	const { url, headers } = signRequest({
		accessKeyId: AK,
		secretAccessKey: SK,
		action: "GetCodingPlanUsage",
		body: "{}",
		date: DATE
	});
	assert.equal(url, VECTOR.url);
	assert.equal(headers["x-date"], "20240101T000000Z");
	assert.equal(headers["x-content-sha256"], VECTOR.payloadHash);
	assert.equal(headers["content-type"], "application/json");
	assert.equal(
		headers.authorization,
		`HMAC-SHA256 Credential=${AK}/${VECTOR.credentialScope}, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=${VECTOR.signature}`
	);
});

test("signRequest 默认 body 为 {} 且默认时间为当前时刻", () => {
	const { headers } = signRequest({ accessKeyId: AK, secretAccessKey: SK, action: "GetAFPUsage" });
	assert.equal(headers["x-content-sha256"], VECTOR.payloadHash);
	assert.match(headers["x-date"], /^\d{8}T\d{6}Z$/);
});

test("signRequest 的 URL 固定官方主机与 Action/Version 查询串", () => {
	const { url, headers } = signRequest({ accessKeyId: AK, secretAccessKey: SK, action: "GetAFPUsage", date: DATE });
	assert.equal(url, "https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01");
	assert.equal(new URL(url).host, VOLC_HOST);
	assert.equal(new URL(url).protocol, "https:");
	assert.match(headers.authorization, /SignedHeaders=content-type;host;x-content-sha256;x-date/);
	assert.ok(headers.authorization.includes(`Credential=${AK}/${VECTOR.credentialScope}`));
});

test("signRequest 不接受调用方覆盖 host", () => {
	const { url, headers } = signRequest({
		accessKeyId: AK,
		secretAccessKey: SK,
		action: "GetCodingPlanUsage",
		host: "evil.example.com",
		date: DATE
	});
	assert.equal(new URL(url).host, VOLC_HOST);
	assert.ok(!headers.authorization.includes("evil.example.com"));
});

test("signRequest 随 action / body / 时间变化", () => {
	const base = { accessKeyId: AK, secretAccessKey: SK, date: DATE };
	const coding = signRequest({ ...base, action: "GetCodingPlanUsage" });
	const agent = signRequest({ ...base, action: "GetAFPUsage" });
	assert.notEqual(coding.headers.authorization, agent.headers.authorization);
	assert.notEqual(coding.url, agent.url);

	const other = signRequest({ ...base, action: "GetCodingPlanUsage", body: JSON.stringify({ a: 1 }) });
	assert.notEqual(other.headers["x-content-sha256"], coding.headers["x-content-sha256"]);
	assert.notEqual(other.headers.authorization, coding.headers.authorization);

	const later = signRequest({ ...base, action: "GetCodingPlanUsage", date: DATE + 3600_000 });
	assert.equal(later.headers["x-date"], "20240101T010000Z");
	assert.notEqual(later.headers.authorization, coding.headers.authorization);
});

test("signRequest 拒绝缺失或空的凭据", () => {
	assert.throws(() => signRequest({ accessKeyId: "", secretAccessKey: SK, action: "GetCodingPlanUsage" }), VolcUsageError);
	assert.throws(() => signRequest({ accessKeyId: AK, secretAccessKey: "   ", action: "GetCodingPlanUsage" }), VolcUsageError);
	assert.throws(() => signRequest({ accessKeyId: AK, secretAccessKey: SK, action: "" }), VolcUsageError);
});

// ── Coding Plan 解析 ───────────────────────────────────────────────────────────

test("parseCodingUsage 保留已用百分比，小数值不放大", () => {
	const result = parseCodingUsage({
		ResponseMetadata: { RequestId: "r-1" },
		Result: {
			QuotaUsage: [
				{ Level: "session", Percent: 0.39, ResetTimestamp: 1704070800 },
				{ Level: "weekly", Percent: "12.5", ResetTimestamp: 1704495600 },
				{ Level: "monthly", Percent: "77", ResetTimestamp: 1706661600 }
			]
		}
	});
	assert.equal(result.subscribed, true);
	assert.equal(result.windows.length, 3);
	assert.deepEqual(result.windows.map(w => w.kind), ["5h", "week", "month"]);
	assert.equal(result.windows[0].percent, 0.39);
	assert.equal(result.windows[1].percent, 12.5);
	assert.equal(result.windows[2].percent, 77);
	assert.equal(result.windows[0].resetsAt, new Date(1704070800 * 1000).toISOString());
});

test("编程套餐重置哨兵或缺失不会伪造时间，字符串秒值正常解析", () => {
	const result = parseCodingUsage({ QuotaUsage: [
		{ Level: "session", Percent: 0, ResetTimestamp: -1 },
		{ Level: "weekly", Percent: 10 },
		{ Level: "monthly", Percent: 20, ResetTimestamp: "1791734400" }
	] });
	assert.equal(result.windows.length, 3);
	assert.equal(result.windows[0].resetsAt, undefined);
	assert.equal(result.windows[1].resetsAt, undefined);
	assert.equal(result.windows[2].resetsAt, new Date(1791734400 * 1000).toISOString());
});

test("parseCodingUsage 只接受有限非负的百分比，非法值不当作 0", () => {
	for (const bad of ["abc", null, -1, NaN, {}]) {
		assert.throws(
			() => parseCodingUsage({ Result: { QuotaUsage: [{ Level: "session", Percent: bad }] } }),
			VolcUsageError,
			`Percent=${String(bad)} 应当报错而不是返回 0`
		);
	}
	// 合法的 0 是「已用 0%」，不是非法值。
	const zero = parseCodingUsage({ Result: { QuotaUsage: [{ Level: "session", Percent: 0 }] } });
	assert.equal(zero.windows[0].percent, 0);
});

test("parseCodingUsage 忽略未知 Level，且空响应视为未订阅", () => {
	// 服务端返回了 QuotaUsage 行即说明该套餐已生效；未登记的 Level 不产出窗口，也不猜语义。
	const unknown = parseCodingUsage({ Result: { QuotaUsage: [{ Level: "fortnightly", Percent: 10 }] } });
	assert.equal(unknown.subscribed, true);
	assert.deepEqual(unknown.windows, []);
	assert.deepEqual(parseCodingUsage({}), { subscribed: false, windows: [], plan: undefined });
	assert.deepEqual(parseCodingUsage(null), { subscribed: false, windows: [], plan: undefined });
	assert.deepEqual(parseCodingUsage(undefined), { subscribed: false, windows: [], plan: undefined });
	assert.deepEqual(parseCodingUsage({ Result: { QuotaUsage: "nope" } }).windows, []);
});

test("parseCodingUsage 接受字段位于顶层的形态并保留 plan", () => {
	const result = parseCodingUsage({ QuotaUsage: [{ Level: "session", Percent: 1.5 }], PlanType: "coding-pro" });
	assert.equal(result.subscribed, true);
	assert.equal(result.windows[0].percent, 1.5);
	assert.equal(result.plan, "coding-pro");
});

// ── Agent Plan 解析 ────────────────────────────────────────────────────────────

test("parseAgentUsage 归一化四个 AFP 窗口并保留绝对 used/limit", () => {
	const result = parseAgentUsage({
		Result: {
			PlanType: "agent-pro",
			AFPFiveHour: { Quota: 1000, Used: 250, ResetTime: 1704070800000 },
			AFPWeekly: { Quota: 5000, Used: 1250, ResetTime: 1704495600000 },
			AFPMonthly: { Quota: 20000, Used: 10000, ResetTime: 1706661600000 },
			AFPDaily: { Quota: 200, Used: 50, ResetTime: 1704070800000 }
		}
	});
	assert.equal(result.subscribed, true);
	assert.equal(result.plan, "agent-pro");
	assert.deepEqual(result.windows.map(w => w.kind), ["5h", "week", "month", "day"]);
	assert.deepEqual(result.windows.map(w => w.group), ["text", "text", "all", "daily-capabilities"]);
	assert.deepEqual(result.windows.map(w => w.percent), [25, 25, 50, 25]);
	assert.deepEqual(result.windows[0].detail, { used: 250, limit: 1000, unit: "AFP" });
	assert.deepEqual(result.windows[2].detail, { used: 10000, limit: 20000, unit: "AFP" });
	assert.equal(result.windows[0].resetsAt, new Date(1704070800000).toISOString());
});

test("Agent 套餐缺失或无效重置时间不会删除有效额度窗口", () => {
	const result = parseAgentUsage({ Result: {
		AFPFiveHour: { Quota: 100, Used: 10, ResetTime: 0 },
		AFPWeekly: { Quota: 100, Used: 20, ResetTime: -1 },
		AFPMonthly: { Quota: 100, Used: 30 }
	} });
	assert.equal(result.windows.length, 3);
	assert.ok(result.windows.every(window => window.resetsAt === undefined));
});

test("parseAgentUsage 把 Quota 为 0 的窗口视为不适用，而不是 0% 额度", () => {
	const result = parseAgentUsage({
		Result: {
			AFPFiveHour: { Quota: 0, Used: 0, ResetTime: 1704070800000 },
			AFPDaily: { Quota: 100, Used: 20, ResetTime: 1704070800000 }
		}
	});
	assert.deepEqual(result.windows.map(w => w.kind), ["day"]);
	assert.equal(result.subscribed, true);
});

test("parseAgentUsage 对非法绝对值报错，不伪造 0 额度", () => {
	assert.throws(() => parseAgentUsage({ Result: { AFPFiveHour: { Quota: 100, Used: "many" } } }), VolcUsageError);
	assert.throws(() => parseAgentUsage({ Result: { AFPFiveHour: { Quota: -5, Used: 1 } } }), VolcUsageError);
	assert.throws(() => parseAgentUsage({ Result: { AFPFiveHour: { Used: 1 } } }), VolcUsageError);
});

test("parseAgentUsage 对空响应视为未订阅", () => {
	assert.deepEqual(parseAgentUsage(null), { subscribed: false, windows: [], plan: undefined });
	assert.deepEqual(parseAgentUsage({}), { subscribed: false, windows: [], plan: undefined });
	assert.deepEqual(parseAgentUsage({ Result: [] }), { subscribed: false, windows: [], plan: undefined });
	assert.deepEqual(parseAgentUsage({ Result: { AFPFiveHour: "weird" } }).windows, []);
});

test("parseAgentUsage 的百分比上限为 100", () => {
	const result = parseAgentUsage({ Result: { AFPFiveHour: { Quota: 100, Used: 150 } } });
	assert.equal(result.windows[0].percent, 100);
});

// ── fetchUsage ─────────────────────────────────────────────────────────────────

test("fetchUsage 调用 Coding Plan 的 Action 并带上签名", async () => {
	const calls = [];
	const fetchImpl = recordingFetch(
		fakeResponse({ Result: { QuotaUsage: [{ Level: "session", Percent: 0.39 }] } }),
		calls
	);
	const result = await fetchUsage("coding", CREDS, { fetchImpl, timeoutMs: 1000 });
	assert.equal(calls.length, 1);
	const { url, init } = calls[0];
	assert.equal(new URL(url).host, VOLC_HOST);
	assert.equal(new URL(url).searchParams.get("Action"), CODING_ACTION);
	assert.equal(new URL(url).searchParams.get("Version"), "2024-01-01");
	assert.equal(init.method, "POST");
	assert.equal(init.body, "{}");
	assert.match(init.headers.authorization, /^HMAC-SHA256 Credential=AKLTtestaccesskeyid\//);
	assert.equal(init.headers["content-type"], "application/json");
	assert.equal(result.subscribed, true);
	assert.equal(result.windows[0].percent, 0.39);
});

test("fetchUsage 调用 Agent Plan 的 Action 并解析 AFP 窗口", async () => {
	const calls = [];
	const fetchImpl = recordingFetch(
		fakeResponse({
			Result: {
				PlanType: "agent-pro",
				AFPFiveHour: { Quota: 1000, Used: 100, ResetTime: 1704070800000 }
			}
		}),
		calls
	);
	const result = await fetchUsage("agent", CREDS, { fetchImpl, timeoutMs: 1000 });
	assert.equal(new URL(calls[0].url).searchParams.get("Action"), AGENT_ACTION);
	assert.equal(result.subscribed, true);
	assert.equal(result.windows[0].kind, "5h");
	assert.equal(result.windows[0].group, "text");
	assert.equal(result.windows[0].detail.limit, 1000);
});

test("fetchUsage 拒绝未知套餐", async () => {
	await assert.rejects(() => fetchUsage("enterprise", CREDS, { fetchImpl: async () => fakeResponse({}) }), VolcUsageError);
	await assert.rejects(() => fetchUsage("", CREDS, { fetchImpl: async () => fakeResponse({}) }), VolcUsageError);
});

test("fetchUsage 对空响应返回未订阅而不是 0 额度", async () => {
	const empty = await fetchUsage("coding", CREDS, { fetchImpl: async () => fakeResponse("", { ok: true, status: 200 }), timeoutMs: 1000 });
	assert.deepEqual(empty, { subscribed: false, windows: [], plan: undefined });
	const blank = await fetchUsage("agent", CREDS, { fetchImpl: async () => fakeResponse({}, { ok: true, status: 200 }), timeoutMs: 1000 });
	assert.equal(blank.subscribed, false);
	assert.deepEqual(blank.windows, []);
});

test("fetchUsage 把业务错误转成不含凭据的安全错误", async () => {
	const body = {
		ResponseMetadata: {
			Error: {
				Code: "AccessDenied",
				Message: `denied for ${SK} / ${AK}`
			}
		}
	};
	await assert.rejects(
		() => fetchUsage("coding", CREDS, { fetchImpl: async () => fakeResponse(body), timeoutMs: 1000 }),
		error => {
			assert.ok(error instanceof VolcUsageError);
			assert.equal(error.code, "AccessDenied");
			assert.ok(!error.message.includes(SK));
			assert.ok(!error.message.includes(AK));
			assert.ok(error.message.includes("[REDACTED]"));
			return true;
		}
	);
});

test("fetchUsage 对非 2xx 与非 JSON 响应报错", async () => {
	await assert.rejects(
		() => fetchUsage("coding", CREDS, { fetchImpl: async () => fakeResponse("<html>500</html>", { ok: false, status: 500 }), timeoutMs: 1000 }),
		error => {
			assert.ok(error instanceof VolcUsageError);
			assert.equal(error.code, "Http500");
			return true;
		}
	);
	await assert.rejects(
		() => fetchUsage("coding", CREDS, { fetchImpl: async () => fakeResponse("not json", { ok: true, status: 200 }), timeoutMs: 1000 }),
		error => {
			assert.ok(error instanceof VolcUsageError);
			assert.equal(error.code, "InvalidResponse");
			return true;
		}
	);
});

test("fetchUsage 超时后抛出可识别的超时错误", async () => {
	const fetchImpl = async (url, init) =>
		new Promise((_, reject) => {
			// AbortSignal.timeout is unref'ed. Model a pending socket with a bounded,
			// ref'ed timer so Node 22 cannot exit before the timeout signal fires.
			const requestDeadline = setTimeout(() => reject(new Error("fixture request deadline exceeded")), 1000);
			init.signal.addEventListener("abort", () => {
				clearTimeout(requestDeadline);
				reject(init.signal.reason ?? new Error("aborted"));
			}, { once: true });
		});
	await assert.rejects(
		() => fetchUsage("coding", CREDS, { fetchImpl, timeoutMs: 20 }),
		error => {
			assert.ok(error instanceof VolcUsageError);
			assert.equal(error.code, "Timeout");
			assert.match(error.message, /timed out after 20ms/);
			return true;
		}
	);
});

test("fetchUsage 在调用方取消时抛出 Aborted", async () => {
	const controller = new AbortController();
	const fetchImpl = async (url, init) =>
		new Promise((_, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
			controller.abort();
		});
	await assert.rejects(
		() => fetchUsage("coding", CREDS, { fetchImpl, signal: controller.signal, timeoutMs: 5000 }),
		error => {
			assert.ok(error instanceof VolcUsageError);
			assert.equal(error.code, "Aborted");
			return true;
		}
	);
});

test("fetchUsage 把网络异常包装成不含凭据的错误", async () => {
	await assert.rejects(
		() =>
			fetchUsage("coding", CREDS, {
				fetchImpl: async () => {
					throw new Error(`socket failure while using ${SK}`);
				},
				timeoutMs: 1000
			}),
		error => {
			assert.ok(error instanceof VolcUsageError);
			assert.equal(error.code, "NetworkError");
			assert.ok(!error.message.includes(SK));
			return true;
		}
	);
});
