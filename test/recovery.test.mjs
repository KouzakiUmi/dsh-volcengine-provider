// 恢复路径的回归测试：node --test test/recovery.test.mjs
// 覆盖边界：坏目录缓存下 read() 仍可读、OAuth 推理 Key 的并发共享与账号隔离、
// clearCaches() 之后重新取、dispose() 清空缓存。
// 全部使用假 CLI / 假 resolveRef / 假 fetch；状态文件写在 mkdtemp 临时目录里，
// 不执行真实 CLI、不发起真实网络请求、不读取任何真实凭据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArkController } from '../src/manager.mjs';
import { revision } from '../src/state.mjs';
import { snapshot } from '../src/catalog.mjs';

const dirs = [];
const controllers = [];
after(async () => {
	for (const controller of controllers) {
		try {
			controller.dispose();
		} catch {
			/* ignore */
		}
	}
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * 组装一个隔离环境：假 CLI（记录 apikey 调用）、假 resolveRef、假 fetch。
 * @param {{accounts?: object[], oauth?: Record<string, {profiles: Record<string, string>}>}} options
 */
async function setup({ accounts = [], oauth = {} } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-volc-recovery-'));
	dirs.push(dir);
	const statePath = join(dir, 'state.json');
	const apiKeyCalls = [];
	const fetchCalls = [];

	const cliFactory = (owner, home) => ({
		executable: 'fake-arkcli',
		home,
		async whoami() {
			return { logged_in: true };
		},
		async status() {
			return { profiles_summary: [] };
		},
		async apiKey(profile) {
			apiKeyCalls.push({ accountId: owner.id, profile });
			// 模拟 CLI 的往返延迟，让并发共享路径真的重叠。
			await new Promise(resolve => setTimeout(resolve, 5));
			return `KEY-${owner.id}-${profile}`;
		},
		async models(plan, profile) {
			return { plan, models: [{ model_id: `${plan}-model` }] };
		},
		async run(args) {
			if (args[1] === 'usage.get_coding_plan_usage') {
				return { Result: { QuotaUsage: [{ Level: 'session', Percent: 0.39 }] } };
			}
			if (args[1] === 'usage.get_afp_usage') {
				return { Result: { AFPFiveHour: { Quota: 1000, Used: 250, ResetTime: 1704070800000 } } };
			}
			throw new Error(`意外的 CLI 调用: ${args.join(' ')}`);
		}
	});

	const controller = new ArkController({
		statePath,
		arkCliPath: '',
		resolveRef: async ref => ({ VOLC_ACCESSKEY: 'FAKE-AK', VOLC_SECRETKEY: 'FAKE-SK' }[ref]),
		cliFactory,
		fetchImpl: async (url, init) => {
			fetchCalls.push({ url, init });
			const action = new URL(url).searchParams.get('Action');
			return {
				ok: true,
				status: 200,
				async text() {
					return JSON.stringify(
						action === 'GetAFPUsage'
							? { Result: { AFPFiveHour: { Quota: 1000, Used: 250, ResetTime: 1704070800000 } } }
							: { Result: { QuotaUsage: [{ Level: 'session', Percent: 0.39 }] } }
					);
				}
			};
		}
	});
	controllers.push(controller);
	await controller.store.load();

	// 账号与 OAuth 绑定必须在同一次变更里落盘：validateState 只保留已存在账号的绑定。
	if (accounts.length || Object.keys(oauth).length) {
		await controller.store.mutate(revision(controller.store.current), draft => {
			for (const extra of accounts) {
				const index = draft.accounts.findIndex(a => a.id === extra.id);
				if (index < 0) draft.accounts.push(extra); else draft.accounts[index] = extra;
			}
			draft.oauth = { ...draft.oauth, ...structuredClone(oauth) };
			return draft;
		});
	}
	return { dir, statePath, controller, apiKeyCalls, fetchCalls };
}

/** 从目录条目里取出错误说明；键名可能是 error / invalid / reason 之一。 */
function errorText(entry) {
	for (const key of ['error', 'invalid', 'reason', 'message']) {
		const value = entry?.[key];
		if (typeof value === 'string' && value.trim()) return value;
	}
	return '';
}

// ── 坏目录缓存：read() 仍要可读 ────────────────────────────────────────────────

test('read 在目录缓存损坏时仍返回可读结果，不抛异常', async () => {
	const { controller } = await setup();
	await controller.store.mutate(revision(controller.store.current), draft => {
		draft.catalogs['default:agent-plan'] = { models: 'not-an-array' };
		return draft;
	});

	const view = await controller.read();
	assert.ok(view.accounts.length === 1, '账号信息仍应可读');
	assert.equal(view.active['agent-plan'], 'default');
	const agent = view.catalogs.find(row => row.accountId === 'default' && row.plan === 'agent-plan');
	assert.ok(agent, '损坏项也要出现在目录列表里');
	assert.equal(agent.count, 0, '损坏缓存不得报出模型数量');
	assert.equal(agent.source, 'invalid-cache');
	assert.ok(errorText(agent), '损坏项必须带上错误说明，而不是静默当成正常数据');
});

test('read 在目录缓存缺少 models 字段时同样可读', async () => {
	const { controller } = await setup();
	await controller.store.mutate(revision(controller.store.current), draft => {
		draft.catalogs['default:coding-plan'] = {};
		return draft;
	});
	const view = await controller.read();
	const coding = view.catalogs.find(row => row.accountId === 'default' && row.plan === 'coding-plan');
	assert.equal(coding.count, 0);
	assert.equal(coding.source, 'invalid-cache');
	assert.ok(errorText(coding));
});

test('read 中损坏的目录项不影响其它订阅的目录计数', async () => {
	const { controller } = await setup();
	await controller.store.mutate(revision(controller.store.current), draft => {
		draft.catalogs['default:agent-plan'] = { models: 'not-an-array' };
		return draft;
	});
	const view = await controller.read();
	const coding = view.catalogs.find(row => row.accountId === 'default' && row.plan === 'coding-plan');
	assert.equal(coding.count, snapshot['coding-plan'].models.length);
	assert.equal(coding.source, 'local-snapshot');
});

// ── OAuth 推理 Key 的并发共享 ───────────────────────────────────────────────────

test('同一账号同一 profile 的并发推理 Key 解析只调用一次 CLI', async () => {
	const { controller, apiKeyCalls } = await setup({
		oauth: { default: { profiles: { 'agent-plan': 'agent-profile' } } }
	});
	const owner = controller.store.current.accounts[0];
	const values = await Promise.all(Array.from({ length: 5 }, () => controller.inferenceKey(owner, 'agent-plan')));
	assert.deepEqual(values, Array(5).fill('KEY-default-agent-profile'));
	assert.equal(apiKeyCalls.length, 1, '并发请求应共享同一次 CLI 调用');
});

test('不同账号的推理 Key 互不串用', async () => {
	const { controller, apiKeyCalls } = await setup({
		accounts: [{ id: 'second', label: '第二账号', apiKeyRefs: {}, accessKeyRef: '', secretKeyRef: '' }],
		oauth: {
			default: { profiles: { 'agent-plan': 'agent-profile' } },
			second: { profiles: { 'agent-plan': 'agent-profile-2' } }
		}
	});
	const first = controller.store.current.accounts.find(a => a.id === 'default');
	const second = controller.store.current.accounts.find(a => a.id === 'second');

	const [a, b] = await Promise.all([
		controller.inferenceKey(first, 'agent-plan'),
		controller.inferenceKey(second, 'agent-plan')
	]);
	assert.equal(a, 'KEY-default-agent-profile');
	assert.equal(b, 'KEY-second-agent-profile-2');
	assert.notEqual(a, b);
	assert.deepEqual(
		apiKeyCalls.map(call => call.accountId).sort(),
		['default', 'second']
	);
});

test('不同订阅的推理 Key 互不串用', async () => {
	const { controller, apiKeyCalls } = await setup({
		oauth: {
			default: {
				profiles: { 'agent-plan': 'agent-profile', 'coding-plan': 'coding-profile' }
			}
		}
	});
	const owner = controller.store.current.accounts[0];
	const agent = await controller.inferenceKey(owner, 'agent-plan');
	const coding = await controller.inferenceKey(owner, 'coding-plan');
	assert.equal(agent, 'KEY-default-agent-profile');
	assert.equal(coding, 'KEY-default-coding-profile');
	assert.notEqual(agent, coding);
	assert.deepEqual(
		apiKeyCalls.map(call => call.profile).sort(),
		['agent-profile', 'coding-profile']
	);
});

// ── 缓存失效 ────────────────────────────────────────────────────────────────────

test('clearCaches 之后推理 Key 会重新向 CLI 取值', async () => {
	const { controller, apiKeyCalls } = await setup({
		oauth: { default: { profiles: { 'agent-plan': 'agent-profile' } } }
	});
	const owner = controller.store.current.accounts[0];
	await controller.inferenceKey(owner, 'agent-plan');
	assert.equal(apiKeyCalls.length, 1);
	await controller.inferenceKey(owner, 'agent-plan');
	assert.equal(apiKeyCalls.length, 1, 'TTL 内应命中缓存');

	controller.clearCaches();
	await controller.inferenceKey(owner, 'agent-plan');
	assert.equal(apiKeyCalls.length, 2, 'clearCaches 之后应重新取值');
});

test('clearCaches 同时让额度缓存失效', async () => {
	const { controller, fetchCalls } = await setup();
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(fetchCalls.length, 1, '额度结果应命中缓存');

	controller.clearCaches();
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(fetchCalls.length, 2, 'clearCaches 之后额度应重新请求');
});

// ── dispose ─────────────────────────────────────────────────────────────────────

test('dispose 会清空额度缓存与推理 Key 缓存', async () => {
	const { controller, apiKeyCalls } = await setup({
		oauth: { default: { profiles: { 'agent-plan': 'agent-profile' } } }
	});
	const owner = controller.store.current.accounts[0];
	await controller.inferenceKey(owner, 'agent-plan');
	await controller.invoke({ op: 'quota', plan: 'coding-plan', accountId: 'default' });
	assert.equal(apiKeyCalls.length, 1);

	controller.dispose();
	assert.equal(controller.cache.size, 0, '额度缓存应被清空');
	if (controller.inferenceCache) {
		assert.equal(controller.inferenceCache.size, 0, '推理 Key 缓存应被清空');
	}
	if (controller.inferenceInflight) {
		assert.equal(controller.inferenceInflight.size, 0, '推理 Key 的并发请求表应被清空');
	}
});
