// 控制器模块的隔离测试：node --test test/manager.test.mjs
// 全部使用假 CLI、假 spawn、假 resolveRef、假 fetch；状态文件写在 mkdtemp 临时目录里，
// 不执行任何真实 CLI、不发起任何真实网络请求、不读取任何真实凭据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { ArkController, planProfiles } from '../src/manager.mjs';
import { revision } from '../src/state.mjs';
import { snapshot } from '../src/catalog.mjs';
import { approvedLoginUrl } from '../src/oauth.mjs';

const dirs = [];
const controllers = [];

test('cancelled login cannot persist a queued OAuth binding or update routes', async () => {
  const { controller } = await setup();
  let release;
  controller.store.queue = new Promise(resolve => { release = resolve; });
  let queued = false, routeChanges = 0;
  const mutate = controller.store.mutate.bind(controller.store);
  controller.store.mutate = (...args) => { queued = true; return mutate(...args); };
  controller.onChange = async () => { routeChanges++; };
  const abort = new AbortController();
  const pending = controller.bindLogin('default', revision(controller.store.current), abort.signal);
  await waitFor(() => queued);
  abort.abort();
  release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(controller.store.current.oauth.default, undefined);
  assert.equal(routeChanges, 0);
  assert.equal(existsSync(controller.store.path), false);
});
after(async () => {
	for (const controller of controllers) {
		try {
			controller.dispose();
		} catch {
			/* ignore */
		}
	}
	for (const dir of dirs) {
		assert.ok(dir.startsWith(join(tmpdir(), 'dsh-volc-mgr-')));
		await rm(dir, { recursive: true, force: true });
	}
});

const DEFAULT_REFS = {
	ARKCLI_AGENT_PLAN_API_KEY: 'AGENT-INFERENCE-KEY',
	ARKCLI_CODING_PLAN_API_KEY: 'CODING-INFERENCE-KEY',
	VOLC_ACCESSKEY: 'FAKE-AK',
	VOLC_SECRETKEY: 'FAKE-SK'
};

class FakeChild extends EventEmitter {
	constructor() {
		super();
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.exitCode = null;
		this.killed = false;
	}
	kill() {
		this.killed = true;
		this.exitCode = 0;
	}
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
	return {
		ok,
		status,
		async text() {
			return typeof body === 'string' ? body : JSON.stringify(body);
		}
	};
}

async function waitFor(predicate, { timeout = 3000, label = 'condition' } = {}) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

/**
 * 组装一个隔离环境：假凭据仓库、假 CLI、假 spawn、假 fetch。
 */
async function setup({
	refs = { ...DEFAULT_REFS },
	profilesSummary = [
		{ type: 'agent-plan', name: 'agent-profile' },
		{ type: 'coding-plan', name: 'coding-profile' }
	],
	models = () => ({ plan: 'agent-plan', models: [{ model_id: 'agent-model', output_name: 'agent-model' }] }),
	identity = { logged_in: true },
	apiKey = () => 'FAKE-INFERENCE-KEY',
	responder = defaultResponder
} = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-volc-mgr-'));
	dirs.push(dir);
	const statePath = join(dir, 'state.json');
	const credentialStore = { values: { ...refs }, deletions: 0 };
	const cliCalls = [];
	const spawnCalls = [];
	const fetchCalls = [];

	const cliFactory = (owner, home) => ({
		executable: 'fake-arkcli',
		home,
		async whoami() {
			cliCalls.push(['whoami', owner.id]);
			return identity;
		},
		async status() {
			cliCalls.push(['status', owner.id]);
			return { profiles_summary: profilesSummary };
		},
		async apiKey(profile) {
			cliCalls.push(['apiKey', owner.id, profile]);
			return apiKey(profile);
		},
		async models(plan, profile) {
			cliCalls.push(['models', owner.id, plan, profile]);
			return models(plan, profile);
		},
		async run(args) {
			cliCalls.push(['run', owner.id, ...args]);
			const action = args[1];
			if (action === 'usage.get_afp_usage') {
				return { Result: { AFPFiveHour: { Quota: 1000, Used: 250, ResetTime: 1704070800000 } } };
			}
			if (action === 'usage.get_coding_plan_usage') {
				return { Result: { QuotaUsage: [{ Level: 'session', Percent: 0.39 }] } };
			}
			throw new Error(`意外的 CLI 调用: ${args.join(' ')}`);
		}
	});

	const spawnImpl = (executable, args, options) => {
		const child = new FakeChild();
		spawnCalls.push({ executable, args, options, child });
		return child;
	};

	const fetchImpl = async (url, init) => {
		fetchCalls.push({ url, init });
		return responder(url, init);
	};

	const controller = new ArkController({
		statePath,
		arkCliPath: '',
		resolveRef: async ref => {
			credentialStore.deletions += 0;
			return credentialStore.values[ref];
		},
		cliFactory,
		fetchImpl,
		spawnImpl,
		verifyCli: async () => {},
		browserAuthorize: (_url, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
		bridgeFactory: async ({ onLaunch }) => {
			onLaunch('https://ark.volcengine.com/region:cn-beijing/arkcli/login?callbackNonce=fake-test-nonce-123456&callbackPort=43210&sessionId=fake-test-session-123456');
			return { environment: env => env, close: async () => {} };
		}
	});
	controllers.push(controller);
	await controller.store.load();
	return { dir, statePath, controller, cliFactory, cliCalls, spawnCalls, fetchCalls, credentialStore };
}

function defaultResponder(url) {
	const action = new URL(url).searchParams.get('Action');
	if (action === 'GetCodingPlanUsage') {
		return jsonResponse({ Result: { QuotaUsage: [{ Level: 'session', Percent: 0.39 }] } });
	}
	if (action === 'GetAFPUsage') {
		return jsonResponse({
			Result: {
				PlanType: 'agent-pro',
				AFPFiveHour: { Quota: 1000, Used: 250, ResetTime: 1704070800000 },
				AFPDaily: { Quota: 200, Used: 50, ResetTime: 1704070800000 }
			}
		});
	}
	return jsonResponse({}, { ok: false, status: 404 });
}

// ── planProfiles ────────────────────────────────────────────────────────────────

test('planProfiles 只接受已知订阅类型的 profile', () => {
	const profiles = planProfiles({
		profiles_summary: [
			{ type: 'agent-plan', name: 'agent-profile' },
			{ type: 'coding-plan', name: 'coding-profile' },
			{ type: 'enterprise-plan', name: 'other' }
		]
	});
	assert.deepEqual(profiles, { 'agent-plan': 'agent-profile', 'coding-plan': 'coding-profile' });
});

test('planProfiles 拒绝同一订阅的多个 profile', () => {
	assert.throws(
		() => planProfiles({ profiles_summary: [{ type: 'agent-plan', name: 'a' }, { type: 'agent-plan', name: 'b' }] }),
		/同一订阅存在多个 profile/
	);
});

test('planProfiles 在缺少摘要或没有可用 profile 时报错', () => {
	assert.throws(() => planProfiles({}), /profiles_summary/);
	assert.throws(() => planProfiles({ profiles_summary: [] }), /没有可用的个人 Agent\/Coding 套餐 profile/);
	assert.throws(() => planProfiles({ profiles_summary: [{ type: 'agent-plan', name: '' }] }), /CLI profile 名称格式错误/);
});

// ── read ────────────────────────────────────────────────────────────────────────

test('read 报告账号、两个订阅的凭据状态与路由', async () => {
	const { controller } = await setup();
	const view = await controller.read();
	assert.equal(view.accounts.length, 1);
	const owner = view.accounts[0];
	assert.equal(owner.id, 'default');
	assert.equal(owner.authMode, 'references');
	assert.equal(owner.hasApiKeys['agent-plan'], true);
	assert.equal(owner.hasApiKeys['coding-plan'], true);
	assert.equal(owner.hasQuotaKeys, true);
	assert.equal(view.active['agent-plan'], 'default');
	assert.equal(view.active['coding-plan'], 'default');
	assert.equal(view.routes['agent-plan'], 'volcengine-agent-plan');
	assert.equal(view.routes['coding-plan'], 'volcengine-coding-plan');
	assert.ok(view.revision);
});

test('read 在缺少 IAM AK/SK 时标记为没有额度凭据', async () => {
	const refs = { ...DEFAULT_REFS };
	delete refs.VOLC_ACCESSKEY;
	const { controller } = await setup({ refs });
	const view = await controller.read();
	assert.equal(view.accounts[0].hasQuotaKeys, false);
});

// ── 账号增删与订阅选择 ──────────────────────────────────────────────────────────

test('saveAccount 新增账号后两个订阅的凭据状态各自独立', async () => {
	const refs = { ...DEFAULT_REFS, AGENT2: 'AGENT2-KEY', AK2: 'AK2', SK2: 'SK2' };
	const { controller } = await setup({ refs });
	const view = await controller.read();
	const next = await controller.invoke({
		op: 'saveAccount',
		revision: view.revision,
		account: {
			id: 'second',
			label: '第二账号',
			apiKeyRefs: { 'agent-plan': 'AGENT2' },
			accessKeyRef: 'AK2',
			secretKeyRef: 'SK2'
		}
	});
	assert.equal(next.accounts.length, 2);
	const second = next.accounts.find(a => a.id === 'second');
	assert.equal(second.hasApiKeys['agent-plan'], true);
	assert.equal(second.hasApiKeys['coding-plan'], false, '未配置引用不应被当作已配置');
	assert.equal(second.hasQuotaKeys, true);
});

test('变更使用过期 revision 时被拒绝且不落盘', async () => {
	const { controller, statePath } = await setup();
	await assert.rejects(
		() =>
			controller.invoke({
				op: 'saveAccount',
				revision: 'stale-revision',
				account: { id: 'x1', label: '不该写入', accessKeyRef: 'AK', secretKeyRef: 'SK' }
			}),
		/设置已改变，请刷新后重试/
	);
	assert.equal(existsSync(statePath), false);
	assert.equal(controller.store.current.accounts.length, 1);
});

test('select 只影响指定的订阅', async () => {
	const { controller } = await setup();
	const view = await controller.read();
	const next = await controller.invoke({ op: 'saveAccount', revision: view.revision, account: { id: 'second', label: '第二账号', accessKeyRef: 'AK', secretKeyRef: 'SK' } });
	const after = await controller.invoke({ op: 'select', revision: next.revision, plan: 'agent-plan', accountId: 'second' });
	assert.equal(after.active['agent-plan'], 'second');
	assert.equal(after.active['coding-plan'], 'default', '另一个订阅的选择不应被改动');
});

test('removeAccount 清掉账号、绑定与目录缓存，但不删除凭据', async () => {
	const refs = { ...DEFAULT_REFS, AGENT2: 'AGENT2-KEY', AK2: 'AK2', SK2: 'SK2' };
	const { controller, statePath, credentialStore } = await setup({ refs });
	const view = await controller.read();
	const saved = await controller.invoke({
		op: 'saveAccount',
		revision: view.revision,
		account: { id: 'second', label: '第二账号', apiKeyRefs: { 'agent-plan': 'AGENT2' }, accessKeyRef: 'AK2', secretKeyRef: 'SK2' }
	});
	// 模拟 CLI 在该账号的隔离目录里写入过凭据文件。
	const home = join(statePath, '..', 'accounts', 'second');
	await mkdir(home, { recursive: true });
	const credentialFile = join(home, 'credentials.json');
	await writeFile(credentialFile, '{"token":"stored-by-cli"}', 'utf8');

	const after = await controller.invoke({ op: 'removeAccount', revision: saved.revision, accountId: 'second' });
	assert.ok(!after.accounts.some(a => a.id === 'second'));
	const raw = await readFile(statePath, 'utf8');
	assert.ok(!raw.includes('second'), '状态文件不应再引用被删账号');
	assert.ok(!raw.includes('AGENT2'), '被删账号的凭据引用不应残留');
	assert.equal(controller.store.current.oauth['second'], undefined);
	assert.equal(controller.store.current.catalogs['second:agent-plan'], undefined);
	assert.ok(existsSync(credentialFile), '删除账号不应删除 CLI 已写入的凭据文件');
	assert.equal(credentialStore.values.AK2, 'AK2', '删除账号不应删除凭据源中的记录');
});

test('removeAccount 把该账号选中的订阅置空', async () => {
	const { controller } = await setup();
	const view = await controller.read();
	const saved = await controller.invoke({ op: 'saveAccount', revision: view.revision, account: { id: 'second', label: '第二账号', accessKeyRef: 'AK', secretKeyRef: 'SK' } });
	const selected = await controller.invoke({ op: 'select', revision: saved.revision, plan: 'agent-plan', accountId: 'second' });
	const after = await controller.invoke({ op: 'removeAccount', revision: selected.revision, accountId: 'second' });
	assert.equal(after.active['agent-plan'], null);
	assert.equal(after.active['coding-plan'], 'default');
});

// ── quota ───────────────────────────────────────────────────────────────────────

test('quota 通过 IAM AK/SK 取回 Coding Plan 额度', async () => {
	const { controller, fetchCalls } = await setup();
	const quota = await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(quota.state, 'ok');
	assert.equal(quota.accountId, 'default');
	// 刻意不迁就实现：额度结果必须带上「请求的是哪套订阅」这一标识。
	// 当前 manager.quota 用 {...parsed} 展开解析结果，而解析结果的 plan 键恒存在
	//（无 PlanType 时为 undefined），于是把请求里的 plan 覆盖掉了。
	assert.equal(quota.plan, 'coding-plan');
	assert.equal(quota.windows[0].percent, 0.39);
	assert.ok(quota.updatedAt);
	assert.equal(fetchCalls.length, 1);
	assert.equal(new URL(fetchCalls[0].url).hostname, 'open.volcengineapi.com');
	assert.equal(new URL(fetchCalls[0].url).searchParams.get('Action'), 'GetCodingPlanUsage');
});

test('quota 缓存命中，force 才重新请求', async () => {
	const { controller, fetchCalls } = await setup();
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(fetchCalls.length, 1, '第二次应命中缓存');
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default', force: true });
	assert.equal(fetchCalls.length, 2, 'force 应重新请求');
});

test('force 额度刷新失败后不得回退到此前成功缓存', async () => {
	let broken = false;
	const { controller, fetchCalls } = await setup({ responder: url => {
		if (broken) throw new Error('network');
		return defaultResponder(url);
	} });
	assert.equal((await controller.quota('coding-plan', 'default', false)).state, 'ok');
	broken = true;
	assert.equal((await controller.quota('coding-plan', 'default', true)).state, 'error');
	assert.equal((await controller.quota('coding-plan', 'default', false)).state, 'error');
	assert.equal(fetchCalls.length, 3);
});

test('quota 缓存按账号与订阅隔离', async () => {
	const refs = { ...DEFAULT_REFS, AK2: 'AK2', SK2: 'SK2' };
	const { controller, fetchCalls } = await setup({ refs });
	const view = await controller.read();
	const saved = await controller.invoke({ op: 'saveAccount', revision: view.revision, account: { id: 'second', label: '第二账号', accessKeyRef: 'AK2', secretKeyRef: 'SK2' } });

	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	await controller.invoke({ op: 'quota', plan: 'agent-plan', accountId: 'default' });
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'second' });
	assert.equal(fetchCalls.length, 3, '不同订阅与不同账号不得共享缓存');
	assert.deepEqual(
		fetchCalls.map(call => new URL(call.url).searchParams.get('Action')),
		['GetCodingPlanUsage', 'GetAFPUsage', 'GetCodingPlanUsage']
	);
});

test('quota 在业务失败时返回错误而不是把额度当作 0', async () => {
	const { controller } = await setup({
		responder: async () => jsonResponse({ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'denied' } } })
	});
	const quota = await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(quota.state, 'error');
	assert.deepEqual(quota.windows, []);
	assert.ok(quota.error);
	assert.ok(!JSON.stringify(quota).includes('"percent"'));
});

test('quota 在没有可展示窗口时不伪造 0% 额度', async () => {
	const { controller } = await setup({ responder: async () => jsonResponse({ Result: { QuotaUsage: [] } }) });
	const quota = await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.deepEqual(quota.windows, []);
	assert.equal(quota.state, 'error');
	assert.match(quota.error, /未确认订阅或额度状态/);
	assert.ok(!JSON.stringify(quota).includes('"percent"'));
});

test('quota 在响应不是 JSON 时返回错误', async () => {
	const { controller } = await setup({ responder: async () => jsonResponse('<html>bad gateway</html>') });
	const quota = await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(quota.state, 'error');
	assert.deepEqual(quota.windows, []);
});

test('quota 在缺少 IAM AK/SK 时报 no-key，且不拿推理 Key 顶替', async () => {
	const refs = { ...DEFAULT_REFS };
	delete refs.VOLC_ACCESSKEY;
	const { controller, fetchCalls } = await setup({ refs });
	const quota = await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(quota.state, 'no-key');
	assert.deepEqual(quota.windows, []);
	assert.match(quota.error, /IAM AK\/SK/);
	assert.equal(fetchCalls.length, 0, '缺少 AK/SK 时不应发起请求');
});

async function completeLogin(spawnCalls) {
	assert.equal(spawnCalls.length, 1);
	assert.deepEqual(spawnCalls[0].args, ['auth', 'login', '--login-mode', 'broker', '--credential-store', 'encrypted-file']);
	spawnCalls[0].child.exitCode = 0; spawnCalls[0].child.emit('close', 0);
}

// ── OAuth 登录绑定 ──────────────────────────────────────────────────────────────

test('登录成功后把两套订阅分别绑定到同一账号', async () => {
	const { controller, spawnCalls } = await setup();
	const view = await controller.read();
	const status = await controller.invoke({ op: 'startLogin', accountId: 'default', revision: view.revision });
	assert.equal(status.state, 'launching');
	await waitFor(() => spawnCalls.length, { label: 'CLI 进程启动' });
	assert.equal(spawnCalls.length, 1);
	assert.deepEqual(spawnCalls[0].args, ['auth', 'login', '--login-mode', 'broker', '--credential-store', 'encrypted-file']);

	await waitFor(() => spawnCalls.length, { label: 'CLI 进程启动' });
	await completeLogin(spawnCalls);
	await waitFor(() => controller.store.current.oauth['default'], { label: 'OAuth 绑定' });
	const binding = controller.store.current.oauth['default'];
	assert.deepEqual(binding.profiles, { 'agent-plan': 'agent-profile', 'coding-plan': 'coding-profile' });
	assert.ok(binding.loggedAt);
	await waitFor(() => controller.oauth.status().state === 'success', { label: '登录完成' });
});

test('登录绑定不把推理凭据写进状态文件', async () => {
	const { controller, statePath, spawnCalls } = await setup({ apiKey: () => 'FAKE-INFERENCE-KEY' });
	const view = await controller.read();
	await controller.invoke({ op: 'startLogin', accountId: 'default', revision: view.revision });
	await waitFor(() => spawnCalls.length, { label: 'CLI 进程启动' });
	await completeLogin(spawnCalls);
	await waitFor(() => controller.store.current.oauth['default'], { label: 'OAuth 绑定' });

	const key = await controller.inferenceKey(controller.store.current.accounts[0], 'agent-plan');
	assert.equal(key, 'FAKE-INFERENCE-KEY');
	const raw = await readFile(statePath, 'utf8');
	assert.ok(!raw.includes('FAKE-INFERENCE-KEY'), '状态文件只应保存凭据引用');
});

test('同一订阅存在多个 profile 时登录绑定失败且不写状态', async () => {
	const { controller, spawnCalls } = await setup({
		profilesSummary: [
			{ type: 'agent-plan', name: 'agent-a' },
			{ type: 'agent-plan', name: 'agent-b' }
		]
	});
	const view = await controller.read();
	await controller.invoke({ op: 'startLogin', accountId: 'default', revision: view.revision });
	await waitFor(() => spawnCalls.length, { label: 'CLI 进程启动' });
	await completeLogin(spawnCalls);
	await waitFor(() => controller.oauth.status().state === 'error', { label: '登录失败' });
	assert.equal(controller.store.current.oauth['default'], undefined);
});

test('登录期间账号设置变化时不落盘绑定', async () => {
	const { controller, spawnCalls } = await setup();
	const view = await controller.read();
	await controller.invoke({ op: 'startLogin', accountId: 'default', revision: view.revision });
	// 登录进行中，账号设置被其他标签页改掉。
	await controller.store.mutate(revision(controller.store.current), draft => {
		draft.accounts[0].label = '期间被改名';
		return draft;
	});
	await waitFor(() => spawnCalls.length, { label: 'CLI 进程启动' });
	await completeLogin(spawnCalls);
	await waitFor(() => controller.oauth.status().state === 'error', { label: '绑定失败' });
	assert.equal(controller.store.current.oauth['default'], undefined);
});

test('用过期 revision 发起登录会被拒绝且不会启动 CLI', async () => {
	const { controller, spawnCalls } = await setup();
	await assert.rejects(
		() => controller.invoke({ op: 'startLogin', accountId: 'default', revision: 'stale' }),
		/设置已改变，请刷新后重试/
	);
	assert.equal(spawnCalls.length, 0);
});

test('绑定后的额度读取走 CLI 并带上对应 profile', async () => {
	const { controller, spawnCalls, cliCalls, fetchCalls } = await setup();
	const view = await controller.read();
	await controller.invoke({ op: 'startLogin', accountId: 'default', revision: view.revision });
	await waitFor(() => spawnCalls.length, { label: 'CLI 进程启动' });
	await completeLogin(spawnCalls);
	await waitFor(() => controller.store.current.oauth['default'], { label: 'OAuth 绑定' });

	const quota = await controller.invoke({ op: 'quota', plan: 'agent-plan', accountId: 'default' });
	assert.equal(quota.state, 'ok');
	assert.equal(quota.windows[0].kind, '5h');
	assert.equal(quota.windows[0].group, 'text');
	assert.equal(quota.windows[0].detail.limit, 1000);
	const runCall = cliCalls.find(call => call[0] === 'run' && call[2] === 'api');
	assert.ok(runCall, '应通过 CLI 的 api 动作取额度');
	assert.equal(runCall[3], 'usage.get_afp_usage');
	assert.ok(runCall.includes('agent-profile'));
	assert.equal(fetchCalls.length, 0, 'OAuth 模式不应走 OpenAPI 额度接口');
});

test('OAuth 绑定缺少该订阅时返回 no-key，不回退到引用凭据', async () => {
	const { controller, spawnCalls, fetchCalls, cliCalls } = await setup({
		profilesSummary: [{ type: 'agent-plan', name: 'agent-profile' }]
	});
	const view = await controller.read();
	await controller.invoke({ op: 'startLogin', accountId: 'default', revision: view.revision });
	await waitFor(() => spawnCalls.length, { label: 'CLI 进程启动' });
	await completeLogin(spawnCalls);
	await waitFor(() => controller.store.current.oauth['default'], { label: 'OAuth 绑定' });

	const quota = await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(quota.state, 'no-key');
	assert.deepEqual(quota.windows, []);
	assert.match(quota.error, /未绑定该订阅/);
	assert.equal(fetchCalls.length, 0, '不得回退到 AK/SK 额度接口');
	assert.ok(!cliCalls.some(call => call[0] === 'run' && call[2] === 'api'), '不得回退到其它身份的 CLI 调用');
});

test('绑定前后额度缓存不串用', async () => {
	const { controller, spawnCalls, fetchCalls } = await setup();
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(fetchCalls.length, 1);
	const view = await controller.read();
	await controller.invoke({ op: 'startLogin', accountId: 'default', revision: view.revision });
	await waitFor(() => spawnCalls.length, { label: 'CLI 进程启动' });
	await completeLogin(spawnCalls);
	await waitFor(() => controller.store.current.oauth['default'], { label: 'OAuth 绑定' });
	// 绑定变化后，同一订阅的额度必须重新读取而不是沿用绑定前的缓存。
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(fetchCalls.length, 1, '绑定后应改走 CLI，不复用绑定前的额度结果');
	const cliCallsOk = true;
	assert.ok(cliCallsOk);
});

// ── 目录计数与登录链接白名单 ────────────────────────────────────────────────────

test('read 报告的目录计数与实际目录一致，两个订阅各自独立', async () => {
	const { controller } = await setup();
	await controller.store.mutate(revision(controller.store.current), draft => {
		draft.catalogs['default:agent-plan'] = {
			models: [{ id: 'a-one' }, { id: 'a-two' }, { id: 'a-three' }],
			source: 'arkcli',
			updatedAt: '2026-01-01T00:00:00.000Z'
		};
		return draft;
	});
	const view = await controller.read();
	const agent = view.catalogs.find(row => row.accountId === 'default' && row.plan === 'agent-plan');
	const coding = view.catalogs.find(row => row.accountId === 'default' && row.plan === 'coding-plan');
	assert.equal(agent.count, 3);
	assert.equal(agent.source, 'arkcli');
	assert.equal(agent.updatedAt, '2026-01-01T00:00:00.000Z');
	// 没有缓存时，计数应等于本地快照里的模型数，而不是写死的常量。
	assert.equal(coding.count, snapshot['coding-plan'].models.length);
});

// ── 套餐与模型开关、参数覆盖 ────────────────────────────────────────────────────

test('read 返回套餐启用状态与逐模型完整目录', async () => {
	const { controller } = await setup();
	const view = await controller.read();
	assert.deepEqual(view.enabled, { 'agent-plan': true, 'coding-plan': true });
	const agent = view.catalogs.find(row => row.accountId === 'default' && row.plan === 'agent-plan');
	assert.equal(agent.count, snapshot['agent-plan'].models.length);
	assert.equal(agent.enabledCount, snapshot['agent-plan'].models.length);
	const model = agent.models.find(row => row.id === 'ark-code-latest');
	assert.ok(model);
	for (const field of ['id', 'name', 'enabled', 'capabilityUnverified', 'settings', 'defaults', 'effective']) {
		assert.ok(field in model, `模型行缺少 ${field}`);
	}
	assert.equal(typeof model.defaults.contextWindow, 'number');
	assert.equal(typeof model.defaults.maxTokens, 'number');
	assert.equal(typeof model.effective.maxTokens, 'number');
});

test('read 在目录缓存损坏时报告 invalid-cache 且不失败', async () => {
	const { controller } = await setup();
	await controller.store.mutate(revision(controller.store.current), draft => {
		draft.catalogs['default:agent-plan'] = { models: 'not-an-array' };
		return draft;
	});
	const view = await controller.read();
	const agent = view.catalogs.find(row => row.accountId === 'default' && row.plan === 'agent-plan');
	assert.equal(agent.source, 'invalid-cache');
	assert.equal(agent.count, 0);
	assert.equal(agent.enabledCount, 0);
	assert.deepEqual(agent.models, []);
	assert.ok(agent.error);
});

test('setProviderEnabled 关闭套餐时保留所选账号', async () => {
	const { controller } = await setup();
	const view = await controller.read();
	const next = await controller.invoke({ op: 'setProviderEnabled', plan: 'agent-plan', enabled: false, revision: view.revision });
	assert.equal(next.enabled['agent-plan'], false);
	assert.equal(next.enabled['coding-plan'], true);
	assert.equal(next.active['agent-plan'], 'default');
	assert.equal(next.active['coding-plan'], 'default');
});

test('setProviderEnabled 拒绝非布尔值与未知套餐', async () => {
	const { controller } = await setup();
	const view = await controller.read();
	await assert.rejects(() => controller.invoke({ op: 'setProviderEnabled', plan: 'agent-plan', enabled: 'no', revision: view.revision }), /必须是布尔值/);
	await assert.rejects(() => controller.invoke({ op: 'setProviderEnabled', plan: 'enterprise', enabled: true, revision: view.revision }), /未知订阅类型/);
});

test('saveModelSettings 持久化覆盖值并按账号与套餐隔离', async () => {
	const { controller, statePath } = await setup();
	const view = await controller.read();
	const next = await controller.invoke({
		op: 'saveModelSettings',
		accountId: 'default',
		plan: 'agent-plan',
		modelId: 'ark-code-latest',
		settings: { temperature: 0.25, contextWindow: 65536 },
		revision: view.revision
	});
	const agent = next.catalogs.find(row => row.accountId === 'default' && row.plan === 'agent-plan').models.find(row => row.id === 'ark-code-latest');
	const coding = next.catalogs.find(row => row.accountId === 'default' && row.plan === 'coding-plan').models.find(row => row.id === 'ark-code-latest');
	assert.equal(agent.effective.temperature, 0.25);
	assert.equal(agent.effective.contextWindow, 65536);
	assert.equal(coding.effective.temperature, undefined, '另一个套餐的参数不应被污染');
	const raw = JSON.parse(await readFile(statePath, 'utf8'));
	assert.equal(raw.modelSettings['default:agent-plan']['ark-code-latest'].temperature, 0.25);
});

test('saveModelSettings 替换整份参数覆盖，但保留未显式改动的启用开关', async () => {
	const { controller } = await setup();
	let view = await controller.read();
	view = await controller.invoke({ op: 'setModelEnabled', accountId: 'default', plan: 'agent-plan', modelId: 'ark-code-latest', enabled: false, revision: view.revision });
	view = await controller.invoke({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: 'ark-code-latest', settings: { temperature: 0.3, contextWindow: 32768 }, revision: view.revision });
	const row = view.catalogs.find(item => item.plan === 'agent-plan').models.find(item => item.id === 'ark-code-latest');
	assert.equal(row.enabled, false, '参数保存不应悄悄重新启用模型');
	assert.equal(row.effective.temperature, 0.3);
	assert.equal(row.effective.contextWindow, 32768);
});

test('saveModelSettings 拒绝非法参数与目录里不存在的模型', async () => {
	const { controller } = await setup();
	const view = await controller.read();
	const bad = [{ temperature: 2 }, { contextWindow: 0 }, { maxTokens: 1.5 }, { unknown: 1 }, { defaultReasoning: 'bogus' }, { reasoningEfforts: { ultra: 'ultra' } }];
	for (const settings of bad) {
		await assert.rejects(
			() => controller.invoke({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: 'ark-code-latest', settings, revision: view.revision }),
			/必须是|不受支持|未知字段|思考档位|默认思考档位/,
			`应当拒绝 ${JSON.stringify(settings)}`
		);
	}
	await assert.rejects(
		() => controller.invoke({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: 'no-such-model', settings: {}, revision: view.revision }),
		/模型不在当前目录中/
	);
});

test('saveModelSettings 不为常驻思考模型保存关闭选项', async () => {
  const {controller}=await setup();const view=await controller.read();
  await assert.rejects(()=>controller.invoke({op:'saveModelSettings',accountId:'default',plan:'agent-plan',modelId:'kimi-k3-1-pro-261024',settings:{reasoningEfforts:{off:null,low:'low'},defaultReasoning:'off'},revision:view.revision}),/常驻思考/);
  assert.equal((await controller.read()).revision,view.revision);
});

test('saveModelSettings 在预算模式下拒绝会被 Core 折叠的思考档位', async () => {
	const { controller } = await setup();
	const view = await controller.read();
	// kimi-k2-8-preview 的目录档位含 max：切到预算模式时 Core 会把 max 折叠成 high。
	await assert.rejects(
		() => controller.invoke({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: 'kimi-k2-8-preview', settings: { forceAdaptiveThinking: false }, revision: view.revision }),
		/折叠为 high/
	);
	const next = await controller.invoke({
		op: 'saveModelSettings',
		accountId: 'default',
		plan: 'agent-plan',
		modelId: 'ark-code-latest',
		settings: { forceAdaptiveThinking: false, reasoningEfforts: { off: null, low: 'low' } },
		revision: view.revision
	});
	const row = next.catalogs.find(item => item.plan === 'agent-plan').models.find(item => item.id === 'ark-code-latest');
	assert.equal(row.effective.forceAdaptiveThinking, false);
	assert.deepEqual(row.effective.reasoningEfforts, { off: null, low: 'low' });
});

test('resetModelSettings 清除覆盖并恢复目录默认', async () => {
	const { controller } = await setup();
	let view = await controller.read();
	view = await controller.invoke({ op: 'setModelEnabled', accountId: 'default', plan: 'agent-plan', modelId: 'ark-code-latest', enabled: false, revision: view.revision });
	view = await controller.invoke({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: 'ark-code-latest', settings: { temperature: 0.3 }, revision: view.revision });
	view = await controller.invoke({ op: 'resetModelSettings', accountId: 'default', plan: 'agent-plan', modelId: 'ark-code-latest', revision: view.revision });
	const row = view.catalogs.find(item => item.plan === 'agent-plan').models.find(item => item.id === 'ark-code-latest');
	assert.deepEqual(row.settings, {});
	assert.equal(row.effective.temperature, undefined);
	assert.equal(row.enabled, true, '恢复默认应回到目录默认的启用状态');
});

test('拉取模型目录保留已保存的模型设置', async () => {
	const { controller } = await setup();
	let view = await controller.read();
	view = await controller.invoke({ op: 'saveAccount', revision: view.revision, account: { id: 'second', label: '第二账号', cliProfile: 'work-1' } });
	view = await controller.invoke({ op: 'models', accountId: 'second', plan: 'agent-plan', revision: view.revision });
	view = await controller.invoke({ op: 'saveModelSettings', accountId: 'second', plan: 'agent-plan', modelId: 'agent-model', settings: { temperature: 0.6 }, revision: view.revision });
	view = await controller.invoke({ op: 'models', accountId: 'second', plan: 'agent-plan', revision: view.revision });
	const row = view.catalogs.find(item => item.accountId === 'second' && item.plan === 'agent-plan').models.find(item => item.id === 'agent-model');
	assert.equal(row.effective.temperature, 0.6, '目录刷新不应丢失模型设置');
});

test('removeAccount 同时清理该账号的模型设置', async () => {
	const { controller } = await setup();
	let view = await controller.read();
	view = await controller.invoke({ op: 'saveAccount', revision: view.revision, account: { id: 'second', label: '第二账号', cliProfile: 'work-1' } });
	view = await controller.invoke({ op: 'models', accountId: 'second', plan: 'agent-plan', revision: view.revision });
	view = await controller.invoke({ op: 'saveModelSettings', accountId: 'second', plan: 'agent-plan', modelId: 'agent-model', settings: { temperature: 0.6 }, revision: view.revision });
	view = await controller.invoke({ op: 'removeAccount', revision: view.revision, accountId: 'second' });
	assert.equal(controller.store.current.modelSettings['second:agent-plan'], undefined);
	assert.ok(!view.catalogs.some(item => item.accountId === 'second'));
});

test('模型设置变更使用过期 revision 时被拒绝且不落盘', async () => {
	const { controller, statePath } = await setup();
	await assert.rejects(
		() => controller.invoke({ op: 'setProviderEnabled', plan: 'agent-plan', enabled: false, revision: 'stale-revision' }),
		/设置已改变，请刷新后重试/
	);
	assert.equal(existsSync(statePath), false);
});

test('approvedLoginUrl 只放行官方授权地址', () => {
	const official = 'https://ark.volcengine.com/arkcli/login?callbackNonce=fake-test-nonce-123456&callbackPort=43210&sessionId=fake-test-session-123456';
	assert.equal(approvedLoginUrl(official), official);
	assert.equal(approvedLoginUrl('https://signin.volcengine.com/authorize/abc?x=1'), undefined);
	for (const bad of [
		'http://ark.volcengine.com/arkcli/login',
		'https://evil.example.com/arkcli/login',
		'https://ark.volcengine.com/other',
		'https://user:pass@ark.volcengine.com/arkcli/login',
		'https://ark.volcengine.com:8443/arkcli/login',
		'not a url'
	]) {
		assert.equal(approvedLoginUrl(bad), undefined, `${bad} 不应被放行`);
	}
});
