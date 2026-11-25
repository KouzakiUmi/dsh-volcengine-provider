// test/client.test.mjs —— src/client.js 的隔离冒烟测试。
//
// ⚠️ 这不是浏览器测试。本机没有可用的 React DOM 运行时，所以测试用一个最小的
// React 替身（createElement + useState/useRef/useCallback/useEffect）驱动**真实的**
// 组件源码，验证的是「组件逻辑 + 与 remote 的交互契约」，不涉及真实渲染、样式、
// 以及 React 调度语义（并发渲染、批处理等）。真实浏览器验证仍需在 DSH Web 里人工确认。
//
// 组件源码不能被直接 import：构建产物是一个 CommonJS 工厂（工厂参数提供 require，
// 且与 src/remote.mjs 内联在同一作用域，`arkRemote` 因此可直接使用）。测试复刻
// scripts/build.mjs 的同一段文本变换后再加载，保证测到的就是构建时的那份代码。
//
// 依赖：无第三方包，无网络，无 GUI。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildClientBundleSyncFromDisk } from '../scripts/client-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 迷你 React 替身 ────────────────────────────────────────────────────────────

function createMiniReact() {
  const instances = new Map();
  const pendingEffects = [];
  let current = null;
  let dirty = false;

  const instanceOf = (path) => {
    let instance = instances.get(path);
    if (!instance) {
      instance = { state: [], refs: [], deps: [], callbacks: [], cleanups: [], index: 0 };
      instances.set(path, instance);
    }
    return instance;
  };

  const depsChanged = (instance, index, deps) => {
    const previous = instance.deps[index];
    if (!previous || !deps) return true;
    if (previous.length !== deps.length) return true;
    return deps.some((dep, i) => !Object.is(dep, previous[i]));
  };

  function useState(initial) {
    const instance = current;
    const index = instance.index++;
    if (!(index in instance.state)) instance.state[index] = typeof initial === 'function' ? initial() : initial;
    const setState = (value) => {
      const next = typeof value === 'function' ? value(instance.state[index]) : value;
      if (Object.is(next, instance.state[index])) return;
      instance.state[index] = next;
      dirty = true;
    };
    return [instance.state[index], setState];
  }

  function useRef(initial) {
    const instance = current;
    const index = instance.index++;
    if (!(index in instance.refs)) instance.refs[index] = { current: initial };
    return instance.refs[index];
  }

  function useCallback(fn, deps) {
    const instance = current;
    const index = instance.index++;
    if (depsChanged(instance, index, deps)) instance.callbacks[index] = fn;
    instance.deps[index] = deps ? [...deps] : undefined;
    return instance.callbacks[index];
  }

  function useEffect(fn, deps) {
    const instance = current;
    const index = instance.index++;
    if (!depsChanged(instance, index, deps)) return;
    instance.deps[index] = deps ? [...deps] : undefined;
    const previous = instance.cleanups[index];
    if (typeof previous === 'function') previous();
    pendingEffects.push(() => { instance.cleanups[index] = fn(); });
  }

  function createElement(type, props, ...children) {
    const next = props ? { ...props } : {};
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    return { type, props: next };
  }

  // 按路径复用实例：同一路径在多次渲染之间保持同一份 hook 状态。
  function render(element, path = '') {
    if (element === null || element === undefined || typeof element === 'boolean') return null;
    if (typeof element === 'string' || typeof element === 'number') return element;
    if (Array.isArray(element)) return element.map((child, index) => render(child, `${path}.${index}`));
    if (typeof element.type === 'function') {
      const instance = instanceOf(path);
      instance.index = 0;
      const previous = current;
      current = instance;
      let output;
      try {
        output = element.type(element.props);
      } finally {
        current = previous;
      }
      return render(output, `${path}>`);
    }
    return { type: element.type, props: element.props, children: render(element.props.children, `${path}.c`) };
  }

  function flushEffects() {
    let guard = 0;
    while (pendingEffects.length > 0 && guard < 200) {
      guard++;
      pendingEffects.shift()();
    }
  }

  /** 卸载：跑掉所有 effect 的清理函数（真实 React 卸载组件时会做同样的事）。 */
  function unmount() {
    for (const instance of instances.values()) {
      for (const cleanup of instance.cleanups) {
        if (typeof cleanup === 'function') cleanup();
      }
      instance.cleanups.length = 0;
    }
    instances.clear();
    pendingEffects.length = 0;
  }

  return {
    createElement, useState, useRef, useCallback, useEffect, render, flushEffects, unmount,
    isDirty: () => dirty,
    clearDirty: () => { dirty = false; }
  };
}

// ── 构建产物装载 ──────────────────────────────────────────────────────────────

/** 拼接顺序由 scripts/client-bundle.mjs 统一维护，与真实构建产物保持一致。 */
function buildBundleSource() {
  return buildClientBundleSyncFromDisk(ROOT);
}

/** 按宿主的单参数 factory(require) 契约取回插件导出。 */
function loadBundle(bundleSource, react) {
  let loaded = null;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec; } } };
  try {
    new Function(bundleSource)();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.ok(loaded, 'ModuleLoader 未被调用');
  assert.equal(loaded.id, 'dsh-volcengine-provider');
  return loaded.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`未预期的 require: ${id}`);
  });
}

// ── 假后端 ────────────────────────────────────────────────────────────────────

/** 默认额度值：模拟 Host 中间层已经采集过一次的结果。 */
function defaultQuotaValue(accountId, plan) {
  return {
    accountId, plan, state: 'ok', updatedAt: new Date().toISOString(),
    windows: [
      { kind: '5h', percent: 12.5, resetsAt: new Date().toISOString(), group: 'text', detail: { used: 3, limit: 24, unit: 'AFP', scope: '文本' } },
      { kind: 'week', percent: 40, group: 'text', detail: { used: 8, limit: 20, unit: 'AFP' } },
      { kind: 'day', percent: 95, group: 'daily-capabilities' }
    ]
  };
}

class FakeBackend {
  constructor() {
    this.calls = [];
    this.revision = 'rev-1';
    this.accounts = [{
      id: 'default', label: '现有方舟账号', cliProfile: 'fixture-profile',
      apiKeyRefs: { 'agent-plan': 'ARKCLI_AGENT_PLAN_API_KEY', 'coding-plan': 'ARKCLI_CODING_PLAN_API_KEY' },
      accessKeyRef: 'VOLC_ACCESSKEY', secretKeyRef: 'VOLC_SECRETKEY',
      hasApiKeys: { 'agent-plan': true, 'coding-plan': true }, hasQuotaKeys: true, authMode: 'references'
    }];
    this.active = { 'agent-plan': 'default', 'coding-plan': 'default' };
    this.enabled = { 'agent-plan': true, 'coding-plan': true };
    this.catalogs = [];
    this.media = { riskAcknowledged: false, imageTool: false, imageModel: 'doubao-seedream-5-0-pro' };
    this.login = { jobId: null, state: 'idle', message: '' };
    this.quotaMode = 'ok';
    this.quotaError = '';
    this.quotaWindows = null;
    // Host 中间层：read/snapshots 下发的额度快照（accountId:plan -> { at, value }）。
    this.quotas = {
      'default:agent-plan': { at: Date.now(), value: defaultQuotaValue('default', 'agent-plan') },
      'default:coding-plan': { at: Date.now(), value: defaultQuotaValue('default', 'coding-plan') }
    };
    this.conflictOnce = false;
    this.routingError = null;
  }

  bump() { this.revision = `rev-${this.calls.length}-${Math.random().toString(16).slice(2, 8)}`; }

  /** 模拟 Host 的一次额度采集结果（手动刷新与首次无快照时用）。 */
  nextQuotaValue(accountId, plan) {
    if (this.quotaMode === 'no-key') {
      return { accountId, plan, state: 'no-key', windows: [], error: this.quotaError, updatedAt: new Date().toISOString() };
    }
    const value = defaultQuotaValue(accountId, plan);
    const custom = typeof this.quotaWindows === 'function' ? this.quotaWindows(plan) : this.quotaWindows;
    if (Array.isArray(custom)) value.windows = custom;
    return value;
  }

  readShape() {
    return {
      revision: this.revision,
      accounts: this.accounts.map((account) => ({ ...account })),
      active: { ...this.active },
      enabled: { ...this.enabled },
      ...(this.routingError ? { routingError: this.routingError } : {}),
      catalogs: this.accounts.flatMap((account) => ['agent-plan', 'coding-plan'].map((plan) => {
        const cached = this.catalogs.find((entry) => entry.accountId === account.id && entry.plan === plan);
        return {
          accountId: account.id, plan,
          count: cached ? cached.count : 7,
          source: cached ? cached.source : 'local-snapshot',
          ...(Array.isArray(cached?.models) ? { models: cached.models, enabledCount: cached.enabledCount ?? cached.models.filter(model => model.enabled !== false).length } : {}),
          ...(cached?.updatedAt ? { updatedAt: cached.updatedAt } : {})
        };
      })),
      login: { ...this.login },
      routes: { 'agent-plan': 'volcengine-agent-plan', 'coding-plan': 'volcengine-coding-plan' },
      media: { ...this.media },
      quotas: structuredClone(this.quotas)
    };
  }

  handle(request) {
    this.calls.push(request);
    switch (request.op) {
      case 'read':
        return { ok: true, value: this.readShape() };
      case 'snapshots':
        return { ok: true, value: { revision: this.revision, quotas: structuredClone(this.quotas) } };
      case 'loginStatus':
        return { ok: true, value: { ...this.login } };
      case 'cancelLogin':
        this.login = { ...this.login, state: 'cancelled', message: '登录已取消' };
        return { ok: true, value: { ...this.login } };
      case 'submitLoginCode':
        this.login = { ...this.login, state: 'verifying', message: '正在核验登录结果' };
        return { ok: true, value: { ...this.login } };
      case 'quota': {
        const value = this.nextQuotaValue(request.accountId, request.plan);
        this.quotas[`${request.accountId}:${request.plan}`] = { at: Date.now(), value: structuredClone(value) };
        return { ok: true, value };
      }
      case 'startLogin':
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        this.login = { jobId: 'job-1', accountId: request.accountId, state: 'launching', message: '正在启动 ArkCli 官方 OAuth 登录窗口' };
        return { ok: true, value: { ...this.login } };
      case 'models':
        this.catalogs = [...this.catalogs.filter((entry) => !(entry.plan === request.plan && entry.accountId === request.accountId)),
          { plan: request.plan, accountId: request.accountId, count: 12, source: 'remote', updatedAt: new Date().toISOString() }];
        return { ok: true, value: this.readShape() };
      case 'saveAccount': {
        if (this.conflictOnce) { this.conflictOnce = false; return { ok: false, error: new Error('设置已改变，请刷新后重试') }; }
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        const owner = request.account;
        this.accounts = [...this.accounts.filter((account) => account.id !== owner.id), {
          ...owner,
          hasApiKeys: { 'agent-plan': !!owner.apiKeyRefs['agent-plan'], 'coding-plan': !!owner.apiKeyRefs['coding-plan'] },
          hasQuotaKeys: Boolean(owner.accessKeyRef && owner.secretKeyRef), authMode: 'references'
        }];
        this.bump();
        return { ok: true, value: this.readShape() };
      }
      case 'removeAccount':
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        this.accounts = this.accounts.filter((account) => account.id !== request.accountId);
        this.bump();
        return { ok: true, value: this.readShape() };
      case 'setProviderEnabled':
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        this.enabled[request.plan] = request.enabled;
        this.bump();
        return { ok: true, value: this.readShape() };
      case 'select':
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后 re试') };
        this.active = { ...this.active, [request.plan]: request.accountId };
        this.bump();
        return { ok: true, value: this.readShape() };
      case 'setMedia':
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        this.media = {
          ...this.media,
          ...(request.riskAcknowledged === undefined ? {} : { riskAcknowledged: request.riskAcknowledged }),
          ...(request.imageTool === undefined ? {} : { imageTool: request.imageTool }),
          ...(request.imageModel === undefined ? {} : { imageModel: request.imageModel })
        };
        if (!this.media.riskAcknowledged) this.media.imageTool = false;
        this.bump();
        return { ok: true, value: this.readShape() };
      default:
        return { ok: false, error: new Error(`未知 op: ${request.op}`) };
    }
  }
}

// ── 测试夹具 ──────────────────────────────────────────────────────────────────

/**
 * 搭一套「Host + Client」的隔离环境：假后端、假 ctx、假 React。
 *
 * @param {object} [options]
 * @param {FakeBackend} [options.backend] 假后端
 * @param {boolean} [options.provideService] ctx.inject 是否立刻交出远端服务
 * @param {number} [options.serviceAfterPolls] ctx.get 前 N 次返回空（模拟服务迟到）
 * @returns {object} 夹具
 */
function createHarness(options = {}) {
  const backend = options.backend ?? new FakeBackend();
  const mini = createMiniReact();
  const exported = loadBundle(buildBundleSource(), mini);

  let registered = null;
  let mountedRemote = null;
  let unmounted = false;
  const disposers = [];
  let polls = 0;

  const service = { invoke: async (request) => backend.handle(request) };
  const ctx = {
    slots: {
      inject(name, fn) { fn(); },
      register(slotOptions, Component) {
        if (slotOptions.name === 'settings.section') registered = { options: slotOptions, Component, props: slotOptions.inject ? slotOptions.inject() : {} };
      }
    },
    remote: {
      $mount(remote) {
        mountedRemote = remote;
        return Promise.resolve(() => { unmounted = true; });
      }
    },
    inject(deps, callback) {
      if (options.provideService !== false) callback({ remote: { volcengineProvider: service } });
      return { dispose() {} };
    },
    effect(fn) { disposers.push(fn()); },
    get(name) {
      if (name !== 'remote.volcengineProvider') return undefined;
      polls += 1;
      const hidden = options.serviceAfterPolls ?? 0;
      return hidden > 0 && polls <= hidden ? undefined : service;
    }
  };

  exported.apply(ctx);
  assert.ok(registered, '设置页分区未注册');

  let tree = null;
  const render = () => { tree = mini.render({ type: registered.Component, props: registered.props }, 'root'); };
  const flush = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) {
      mini.clearDirty();
      render();
      mini.flushEffects();
      await tick(0);
      if (!mini.isDirty()) break;
    }
  };
  const find = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((child) => find(child, predicate, out)); return out; }
    if (node.type) {
      if (predicate(node)) out.push(node);
      find('children' in node ? node.children : node.props?.children, predicate, out);
    }
    return out;
  };
  const buttons = () => find(tree, (node) => node.type === 'button');
  const buttonByText = (text) => buttons().find((node) => String(node.props.children).includes(text));
  const click = async (text) => {
    const button = buttonByText(text);
    assert.ok(button, `找不到按钮：${text}`);
    assert.ok(!button.props.disabled, `按钮已禁用，真实用户不能点击：${text}`);
    button.props.onClick();
    await flush();
  };
  const texts = () => {
    const out = [];
    const walk = (node) => {
      if (node === null || node === undefined) return;
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type) walk('children' in node ? node.children : node.props?.children);
    };
    walk(tree);
    return out;
  };
  const joined = () => texts().join(' | ');
  const inputs = () => find(tree, (node) => node.type === 'input');
  // 复选框也是 input：表单用例只关心文本框，按类型过滤避免被开关挤位。
  const textInputs = () => inputs().filter((node) => node.props.type !== 'checkbox');
  const accountSelect = (plan) => find(tree, node => node.type === 'select' && node.props?.['aria-label'] === (plan === 'coding-plan' ? '火山方舟 · 编程套餐使用账号' : '火山方舟 · Agent 套餐使用账号'))[0];
  const selects = () => find(tree, (node) => node.type === 'select');
  const quotaBars = () => find(tree, (node) => node.props?.role === 'progressbar');
  const anchors = () => find(tree, (node) => node.type === 'a');
  const dispose = () => {
    // 组件卸载（清掉组件内的轮询定时器）+ 插件级清理（远端挂载、兜底等待）
    mini.unmount();
    for (const disposer of disposers) disposer();
  };

  return {
    backend, ctx, exported, mini, flush, render, find, buttons, buttonByText, click, texts, joined,
    inputs, textInputs, selects, accountSelect, quotaBars, anchors, dispose,
    get tree() { return tree; },
    get mountedRemote() { return mountedRemote; },
    get unmounted() { return unmounted; },
    get registered() { return registered; }
  };
}

// ── 用例 ──────────────────────────────────────────────────────────────────────

test('模块装载：导出契约与内联远端定义可见', async () => {
  const harness = createHarness();
  assert.equal(harness.exported.name, 'dsh-volcengine-provider');
  const manifest = JSON.parse(readSource('package.json'));
  assert.equal(manifest.name, 'dsh-volcengine-provider');
  assert.equal(manifest.displayName, '火山方舟 Provider');
  assert.deepEqual(harness.exported.inject, ['slots', 'remote']);
  assert.equal(typeof harness.exported.apply, 'function');
  assert.ok(harness.mountedRemote, '远端定义未挂载');
  assert.equal(harness.mountedRemote.descriptors.length, 1);
  assert.equal(harness.mountedRemote.descriptors[0].namespace, 'volcengineProvider');
  assert.equal(harness.mountedRemote.descriptors[0].method, 'invoke');
  harness.dispose();
});

test('设置页分区注册到 settings.section 槽', async () => {
  const harness = createHarness();
  const options = harness.registered.options;
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'volcengine-provider');
  assert.equal(options.label(), '火山方舟 Provider');
  assert.equal(typeof harness.registered.props.client.invoke, 'function');
  harness.dispose();
});

test('首次读取渲染：标题、双套餐卡片、账号、路由与 authMode', async () => {
  const harness = createHarness();
  await harness.flush();
  const text = harness.joined();
  assert.match(text, /火山方舟 Provider/);
  assert.doesNotMatch(text, /dsh-volcengine-provider/);
  assert.match(text, /Agent 套餐/);
  assert.match(text, /编程套餐/);
  assert.match(text, /现有方舟账号/);
  assert.match(text, /模型路由：volcengine-agent-plan/);
  assert.match(text, /凭据来源：凭据引用名/);
  assert.match(text, /额度鉴权：AK\/SK 已配置/);
  assert.ok(harness.backend.calls.some((call) => call.op === 'read'));
  harness.dispose();
});

test('拉取模型与刷新额度：目录来源、剩余百分比、AFP 绝对值、重置与分组', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.click('拉取模型');
  assert.ok(harness.backend.calls.some((call) => call.op === 'models' && call.plan === 'agent-plan'));
  assert.match(harness.joined(), /模型目录：12 个模型（来源 官方接口/);

  await harness.click('刷新额度');
  assert.ok(harness.backend.calls.some((call) => call.op === 'quota' && call.plan === 'agent-plan' && call.force === true));
  const text = harness.joined();
  assert.ok(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'));
  assert.match(text, /已用 3 \/ 24 AFP/);
  assert.match(text, /重置于/);
  assert.match(text, /每日能力限额/);
  harness.dispose();
});

test('额度 no-key：保留上次窗口并说明原因（不把页面闪成错误块）', async () => {
  // Host 中间层的失败合并规则：保留上次成功窗口，只附加失败原因。
  const backend = new FakeBackend();
  const previous = backend.quotas['default:agent-plan'].value;
  backend.quotas['default:agent-plan'] = { at: Date.now(), value: { ...previous,
    refreshError: '额度查询需要 IAM AK/SK，不是推理 API Key；也可使用网页登录',
    errorKind: 'auth', refreshFailedAt: new Date().toISOString() } };
  const harness = createHarness({ backend });
  await harness.flush();
  const text = harness.joined();
  assert.match(text, /额度更新失败：额度查询需要 IAM AK\/SK/);
  assert.ok(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'), '失败不应清掉上次可用窗口');
  assert.ok(harness.buttonByText('去重新登录'), '登录类失败应给出重新登录入口');
  harness.dispose();
});

test('额度首次查询就 no-key：显示不可用原因与网页登录出路', async () => {
  const backend = new FakeBackend();
  backend.quotas['default:agent-plan'] = { at: Date.now(), value: {
    accountId: 'default', plan: 'agent-plan', state: 'no-key', windows: [],
    error: '额度查询需要 IAM AK/SK，不是推理 API Key；也可使用网页登录', updatedAt: new Date().toISOString()
  } };
  const harness = createHarness({ backend });
  await harness.flush();
  const text = harness.joined();
  assert.match(text, /额度查询不可用/);
  assert.match(text, /IAM AK\/SK/);
  harness.dispose();
});

test('网页登录：确认前不发起、确认后发起、轮询进度、成功后刷新', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.click('刷新额度');
  assert.ok(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'));
  await harness.click('网页登录');
  const text = harness.joined();
  assert.match(text, /本插件为该账号准备的隔离目录/);
  assert.match(text, /不会改变你原有 CLI 的默认身份/);
  assert.match(text, /不会删除已经保存的凭据/);
  assert.match(text, /无需另外填写 AK\/SK/);
  assert.ok(!harness.backend.calls.some((call) => call.op === 'startLogin'), '确认前不应发起 startLogin');

  await harness.click('确认并生成登录链接');
  assert.ok(harness.backend.calls.some((call) => call.op === 'startLogin'));
  assert.match(harness.joined(), /正在生成官方登录链接/);
  assert.match(harness.joined(), /登录期间暂不能修改账号与套餐/);
  assert.equal(harness.buttonByText('编辑').props.disabled, true);
  assert.equal(harness.buttonByText('删除').props.disabled, true);
  assert.equal(harness.accountSelect().props.disabled, true);
  assert.equal(harness.buttonByText('取消登录').props.disabled, false, '取消入口必须保持可用');

  harness.backend.login = { jobId: 'job-1', accountId: 'default', state: 'waiting', message: '请在 ArkCli 打开的官方网页完成授权' };
  await tick(1200);
  await harness.flush();
  assert.ok(harness.backend.calls.filter((call) => call.op === 'loginStatus').length >= 1, '登录期间未轮询状态');
  assert.match(harness.joined(), /请在 ArkCli 打开的官方网页完成授权/);
  assert.match(harness.joined(), /当前登录账号：现有方舟账号/);

  const readsBefore = harness.backend.calls.filter((call) => call.op === 'read').length;
  harness.backend.login = { jobId: 'job-1', accountId: 'default', state: 'success', message: 'OAuth 登录已完成' };
  harness.backend.accounts[0] = { ...harness.backend.accounts[0], displayName: '刚登录的官方账号', authMode: 'oauth',
    identity: { name: '刚登录的官方账号', accountId: 'official-new' },
    oauthProfiles: { 'agent-plan': 'agent-new' }, hasQuotaAccess: { 'agent-plan': true, 'coding-plan': false } };
  // 身份变了，Host 侧旧快照指纹失效：read 不再下发旧账号的额度。
  harness.backend.quotas = {};
  await tick(1200);
  await harness.flush();
  assert.match(harness.joined(), /登录成功，凭据已保存。/);
  assert.equal(harness.backend.calls.filter((call) => call.op === 'read').length, readsBefore + 1, '登录成功后应刷新一次 read');
  assert.equal(harness.accountSelect().props.value, 'default');
  assert.match(String(harness.accountSelect().props.children[1][0].props.children), /刚登录的官方账号/);
  assert.equal(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'), false, '同账号重新登录必须清理旧身份的额度');
  assert.match(harness.joined(), /后台正在采集额度/, '新身份下等待 Host 采集，不再展示旧身份数据');
  await harness.flush();
  assert.equal(harness.backend.calls.filter((call) => call.op === 'read').length, readsBefore + 1, '成功后的普通渲染不能反复 read');
  harness.dispose();
});

test('授权链接安全：白名单原样透传，其余一律不渲染，消息中的授权码被脱敏', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.click('网页登录');
  await harness.click('确认并生成登录链接');

  const official = 'https://signin.volcengine.com/authorize/volc?state=abc&redirect=ark';
  harness.backend.login = { jobId: 'job-1', accountId: 'default', state: 'waiting', message: '授权码 code=SECRET-CODE-123 已收到', url: official };
  await tick(1200);
  await harness.flush();
  const anchor = harness.anchors()[0];
  assert.ok(anchor, '白名单链接应渲染');
  assert.equal(anchor.props.href, official, '授权链接必须原样转交');
  assert.match(String(anchor.props.children), /打开官方登录链接/);
  assert.match(harness.joined(), /\[REDACTED\]/);
  assert.ok(!harness.joined().includes('SECRET-CODE-123'), '授权码不得回显');

  for (const bad of [
    'https://signin.volcengine.com/other/path',
    'http://signin.volcengine.com/authorize/x',
    'https://signin.volcengine.com:8443/authorize/x',
    'https://user:pw@signin.volcengine.com/authorize/x',
    'https://ark.volcengine.com/evil',
    'https://evil.example.com/authorize/x'
  ]) {
    harness.backend.login = { jobId: 'job-1', accountId: 'default', state: 'waiting', message: '', url: bad };
    await tick(1200);
    await harness.flush();
    assert.equal(harness.anchors().length, 0, `不合规链接不应渲染：${bad}`);
  }
  harness.dispose();
});

test('官方登录地址允许精确北京 region 前缀，拒绝其他区域或附加路径', async () => {
  for (const [url, allowed] of [
    ['https://ark.volcengine.com/arkcli/login?state=abc', true],
    ['https://ark.volcengine.com/region:cn-beijing/arkcli/login?state=abc', true],
    ['https://ark.volcengine.com/region:other/arkcli/login', false],
    ['https://ark.volcengine.com/region:cn-beijing/arkcli/login/other', false],
    ['https://ark.volcengine.com/region:cn-beijing/evil', false]
  ]) {
    const backend = new FakeBackend();
    backend.login = { jobId: null, accountId: 'default', state: 'idle', url };
    const harness = createHarness({ backend });
    await harness.flush();
    assert.equal(harness.anchors().length, allowed ? 1 : 0, url);
    if (allowed) assert.equal(harness.anchors()[0].props.href, url, '放行的地址必须原样透传');
    harness.dispose();
  }
});

test('账号新增：AK/SK 可留空；删除需要二次确认', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.click('新增账号');
  const fields = harness.textInputs();
  assert.ok(fields.length >= 6, `表单字段数不足：${fields.length}`);
  fields[0].props.onChange({ target: { value: 'team-a' } });
  fields[1].props.onChange({ target: { value: '团队账号' } });
  fields[2].props.onChange({ target: { value: 'TEAM_AGENT_KEY' } });
  await harness.flush();
  await harness.click('保存');
  const saved = harness.backend.calls.find((call) => call.op === 'saveAccount' && call.account.id === 'team-a');
  assert.ok(saved, '未发起 saveAccount');
  assert.equal(saved.account.accessKeyRef, '');
  assert.equal(saved.account.secretKeyRef, '');
  assert.match(harness.joined(), /账号已保存。/);

  await harness.click('删除');
  assert.ok(!harness.backend.calls.some((call) => call.op === 'removeAccount'), '确认前不应删除');
  assert.ok(harness.buttonByText('确认删除'), '缺少二次确认按钮');
  await harness.click('确认删除');
  assert.ok(harness.backend.calls.some((call) => call.op === 'removeAccount'));
  harness.dispose();
});

test('保存冲突：提示刷新并给出刷新入口', async () => {
  const harness = createHarness();
  await harness.flush();
  harness.backend.conflictOnce = true;
  await harness.click('新增账号');
  const fields = harness.textInputs();
  fields[0].props.onChange({ target: { value: 'team-b' } });
  fields[1].props.onChange({ target: { value: '团队 B' } });
  await harness.flush();
  await harness.click('保存');
  assert.match(harness.joined(), /请刷新后重试/);
  assert.ok(harness.buttonByText('刷新'), '冲突后缺少刷新按钮');
  harness.dispose();
});

test('生命周期：dispose 收回远端挂载，并放行挂起的服务等待', async () => {
  // inject 不交出服务、ctx.get 也查不到 → invoke 会进入有上限的兜底轮询
  const harness = createHarness({ provideService: false, serviceAfterPolls: Number.MAX_SAFE_INTEGER });
  const pending = harness.registered.props.client.invoke({ op: 'read' });
  await tick(50);
  harness.dispose();
  assert.equal(harness.unmounted, true, 'dispose 未收回远端挂载');
  await assert.rejects(pending, /设置页已卸载/);
});

test('远端服务迟到时，兜底轮询仍能拿到服务（有上限、不无限等待）', async () => {
  const harness = createHarness({ provideService: false, serviceAfterPolls: 2 });
  const value = await harness.registered.props.client.invoke({ op: 'read' });
  assert.equal(value.revision, 'rev-1');
  harness.dispose();
});

test('构建脚本漂移守卫：bundle 拼接只有 client-bundle.mjs 一处定义', () => {
  const build = readSource('scripts/build.mjs');
  const shared = readSource('scripts/client-bundle.mjs');
  // build 不得再自己拼接：新增共享模块只改一处，否则测试与产物会再次漂移。
  assert.match(build, /buildClientBundleFromDisk/, '构建必须复用 scripts/client-bundle.mjs');
  assert.doesNotMatch(build, /__ModuleLoader__/, '构建不应再自行拼 bundle');
  assert.match(shared, /replace\(\/\^export \/gm, ''\)/, '去 export 变换变了，测试需同步');
  assert.match(shared, /return \{name,inject,apply\};/, '导出形状变了，测试需同步');
  assert.match(shared, /src\/remote\.mjs[\s\S]*src\/client\.js/, '内联顺序变了，测试需同步');
  // 测试装载的源码与构建产物逐字同源。
  assert.equal(buildBundleSource(), buildClientBundleSyncFromDisk(ROOT));
});

test('官方身份优先、本地备注独立，OAuth 按套餐展示绑定与额度访问能力', async () => {
  const backend = new FakeBackend();
  backend.accounts = [{
    id: 'default', label: '默认账号', displayName: '官方小明', authMode: 'oauth',
    identity: { name: '官方小明', userId: 'user-123', accountId: 'account-456' },
    loggedAt: '2026-10-26T12:00:00Z', oauthProfiles: { 'agent-plan': 'agent-personal' },
    hasApiKeys: {}, hasQuotaKeys: false, credentialError: '凭据服务不可用 token=hidden-secret',
    hasQuotaAccess: { 'agent-plan': true, 'coding-plan': false }
  }];
  const harness = createHarness({ backend });
  await harness.flush();
  const text = harness.joined();
  assert.equal(harness.accountSelect().props.value, 'default');
  assert.match(text, /本地备注：默认账号/);
  assert.match(text, /官方账号 ID：account-456/);
  assert.match(text, /官方用户 ID：user-123/);
  assert.match(text, /最近登录：/);
  assert.match(text, /Agent套餐：当前使用 · 已绑定/);
  assert.match(text, /编程套餐：当前使用 · 未绑定/);
  assert.match(text, /额度鉴权：OAuth 已就绪/);
  assert.match(text, /套餐绑定：未绑定/);
  assert.doesNotMatch(text, /AK 引用：|SK 引用：|推理引用：|缺少 AK\/SK|模型调用会失败|没有可用的额度鉴权/);
  assert.equal(String(harness.accountSelect().props.children[1][0].props.children), '官方小明（default）');
  assert.match(String(harness.accountSelect().props.children[1][0].props.title), /本地备注：默认账号/);
  assert.match(text, /凭据状态：凭据服务不可用 token=\[REDACTED\]/);
  assert.doesNotMatch(text, /hidden-secret/);
  await harness.click('编辑');
  assert.match(harness.joined(), /此账号当前使用 OAuth，编辑引用不会切换鉴权方式/);
  harness.dispose();
});

test('额度空值不伪造 100%，仅有效百分比提供可访问进度与更新时间', async t => {
  const backend = new FakeBackend();
  // 中间层快照直接下发这类边界值，Client 只负责渲染。
  backend.quotas['default:agent-plan'] = { at: Date.now(), value: {
    accountId: 'default', plan: 'agent-plan', state: 'ok', updatedAt: '2026-10-26T12:00:00Z',
    windows: [
      { kind: '5h', percent: null, detail: { used: null, limit: 100, unit: 'AFP' } },
      { kind: 'week' }, { kind: 'month', percent: '', detail: { used: 0, limit: 10, unit: 'AFP' } },
      { kind: 'day', percent: 0 }
    ]
  } };
  const harness = createHarness({ backend });
  t.after(() => harness.dispose());
  await harness.flush();
  const text = harness.joined();
  const section = harness.find(harness.tree, node => node.type === 'section' && node.props['aria-label'] === '火山方舟 · Agent 套餐额度')[0];
  assert.ok(section, '缺少 Agent 套餐卡片');
  const progress = harness.find(section, node => node.props?.role === 'progressbar');
  assert.equal(progress.length, 1, '只有真实的零用量可显示剩余100%');
  assert.equal(harness.find(section, node => node.props?.className === 'vcp-quota-percent').length, 1);
  assert.doesNotMatch(text, /已用 null/);
  assert.match(text, /已用 0 \/ 10 AFP/);
  assert.match(text, /百分比未提供/);
  assert.match(text, /额度采集于/);
  assert.equal(progress[0].props['aria-valuenow'], 100);
  assert.equal(progress[0].props['aria-label'], '每日剩余额度');
  assert.equal(progress[0].props['aria-valuetext'], '剩余 100%');
});

test('额度重置时间已过时不把旧用尽状态冒充当前状态', async t => {
  const backend = new FakeBackend();
  backend.quotas['default:agent-plan'] = { at: Date.now(), value: {
    accountId: 'default', plan: 'agent-plan', state: 'ok',
    windows: [
      { kind: '5h', percent: 100, resetsAt: new Date(Date.now() + 60_000).toISOString() },
      { kind: 'week', percent: 100, resetsAt: new Date(Date.now() - 60_000).toISOString() }
    ]
  } };
  const harness = createHarness({ backend });
  t.after(() => harness.dispose());
  await harness.flush();
  const section = harness.find(harness.tree, node => node.type === 'section' && node.props['aria-label'] === '火山方舟 · Agent 套餐额度')[0];
  assert.ok(section, '缺少 Agent 套餐卡片');
  const rows = harness.find(section, node => node.props?.className === 'vcp-quota-window');
  const textOf = row => harness.find(row, node => node.props.className === 'vcp-status-chip')[0]?.props.children;
  assert.deepEqual(rows.map(textOf), ['已用尽', '已用尽 · 待刷新']);
  assert.equal(harness.find(section, node => node.props?.role === 'progressbar').filter(bar => bar.props['aria-valuenow'] === 0).length, 2);
});

test('首次读取失败停止加载提示，重试可恢复且普通重渲染不重复 read', async () => {
  const backend = new FakeBackend();
  const original = backend.handle.bind(backend);
  let fail = true;
  backend.handle = (request) => {
    if (request.op === 'read' && fail) return { ok: false, error: '读取暂不可用' };
    return original(request);
  };
  const harness = createHarness({ backend });
  await harness.flush();
  assert.match(harness.joined(), /读取状态失败：读取暂不可用/);
  assert.doesNotMatch(harness.joined(), /正在读取方舟账号状态/);
  fail = false;
  await harness.click('重试读取状态');
  assert.match(harness.joined(), /现有方舟账号/);
  assert.doesNotMatch(harness.joined(), /读取状态失败/);
  const reads = backend.calls.filter((request) => request.op === 'read').length;
  await harness.flush();
  await harness.flush();
  assert.equal(backend.calls.filter((request) => request.op === 'read').length, reads);
  harness.dispose();
});

test('额度请求展示具体忙态，失败后可直接重试', async () => {
  const backend = new FakeBackend();
  const original = backend.handle.bind(backend);
  let resolver = null;
  let delayed = true;
  // 手动刷新才走 Host 采集：这里让这次采集挂起，验证忙态只锁该套餐的按钮。
  backend.handle = (request) => request.op === 'quota' && delayed
    ? new Promise((resolve) => { resolver = resolve; }) : original(request);
  const harness = createHarness({ backend });
  await harness.flush();
  // 打开设置就有中间层快照：首屏不需要发任何额度请求。
  assert.equal(backend.calls.filter((call) => call.op === 'quota').length, 0, '打开设置不应触发额度查询');
  assert.ok(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'), '快照下发后立即有窗口');
  await harness.click('刷新额度');
  assert.equal(harness.buttonByText('刷新额度').props.disabled, true, '采集进行中按钮应禁用');
  assert.equal(harness.buttonByText('编辑').props.disabled, false, '只读额度请求不能锁住账号管理');
  assert.equal(harness.accountSelect().props.disabled, false, '额度请求期间仍可切换账号');
  resolver({ ok: false, error: '暂时不可用' });
  await harness.flush();
  // 刷新失败不清掉上次窗口：中间层仍显示旧数据。
  assert.ok(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'));
  delayed = false;
  await harness.click('刷新额度');
  assert.ok(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'));
  harness.dispose();
  harness.dispose();
});

test('保存已落盘但路由失败后重新读取，区分所选与实际生效账号', async () => {
  const backend = new FakeBackend();
  const original = backend.handle.bind(backend);
  let routingError = null;
  backend.handle = (request) => {
    if (request.op === 'saveAccount') {
      original(request);
      routingError = '路由校验失败';
      return { ok: false, error: routingError };
    }
    const response = original(request);
    if (request.op === 'read' && routingError) {
      response.value.routingError = routingError;
      response.value.appliedAccounts = {
        'agent-plan': { id: 'previous', displayName: '原官方账号' }, 'coding-plan': null
      };
    }
    return response;
  };
  const harness = createHarness({ backend });
  await harness.flush();
  await harness.click('编辑');
  harness.textInputs()[1].props.onChange({ target: { value: '已保存的新备注' } });
  await harness.flush();
  const reads = backend.calls.filter((request) => request.op === 'read').length;
  await harness.click('保存');
  assert.ok(backend.calls.filter((request) => request.op === 'read').length > reads);
  assert.match(harness.joined(), /所选账号：已保存的新备注/);
  assert.match(harness.joined(), /实际生效账号：原官方账号（previous）/);
  assert.match(harness.joined(), /该套餐当前没有已生效的模型路由/);
  assert.doesNotMatch(harness.joined(), /本次操作没有生效/);
  harness.dispose();
});

test('空账号可直接网页登录，确认前不写入，确认后自动创建且使用新 revision', async t => {
  const backend = new FakeBackend(); backend.accounts = []; backend.active = { 'agent-plan': null, 'coding-plan': null };
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  assert.ok(h.buttonByText('网页登录'));
  await h.click('网页登录');
  assert.equal(backend.calls.some(c => ['saveAccount', 'startLogin'].includes(c.op)), false);
  await h.click('取消');
  assert.equal(backend.accounts.length, 0);
  await h.click('网页登录'); await h.click('确认并生成登录链接');
  assert.equal(backend.accounts.length, 1);
  const start = backend.calls.find(c => c.op === 'startLogin');
  assert.equal(start.accountId, backend.accounts[0].id);
  assert.equal(start.revision, backend.revision);
  assert.deepEqual(backend.accounts[0].apiKeyRefs, {});
  assert.ok(h.buttonByText('取消登录'));
});

test('额度请求期间切换账号，迟到响应不会覆盖新账号', async t => {
  const backend = new FakeBackend(); backend.accounts.push({ ...backend.accounts[0], id: 'second', label: '第二账号' });
  const handle = backend.handle.bind(backend); const pending = new Map();
  backend.handle = request => request.op === 'quota'
    ? new Promise(resolve => pending.set(`${request.accountId}:${request.plan}`, resolve)) : handle(request);
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  // 先为 default 发起一次手动刷新（挂起），再切到还没有中间层快照的 second 账号。
  const agentSection = h.find(h.tree, node => node.type === 'section' && node.props['aria-label'] === '火山方舟 · Agent 套餐额度')[0];
  h.find(agentSection, node => node.type === 'button' && node.props.children === '刷新额度')[0].props.onClick();
  await h.flush();
  assert.ok(pending.has('default:agent-plan'), '手动刷新已经发出');
  h.accountSelect().props.onChange({ target: { value: 'second' } }); await h.flush();
  assert.match(h.joined(), /后台正在采集额度/, '新账号还没有中间层快照');
  pending.get('default:agent-plan')({ ok: true, value: { plan: 'agent-plan', accountId: 'default', state: 'ok', windows: [{ kind: '5h', percent: 99 }] } }); await h.flush();
  assert.ok(!h.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 1%'), '迟到的旧账号结果不得覆盖新账号');
});

test('已有账号可登录其他身份，不覆盖原账号或套餐选择', async t => {
  const h = createHarness(); t.after(() => h.dispose()); await h.flush();
  const old = JSON.stringify(h.backend.accounts[0]);
  await h.click('登录其他账号'); await h.click('确认并生成登录链接');
  assert.equal(h.backend.accounts.length, 2);
  assert.equal(JSON.stringify(h.backend.accounts[0]), old);
  assert.equal(h.backend.active['agent-plan'], 'default');
  assert.equal(h.backend.calls.find(c => c.op === 'startLogin').accountId, 'account-1');
});

test('登录启动冲突会同步状态，下一次登录使用最新 revision', async t => {
  const h = createHarness(); t.after(() => h.dispose()); await h.flush(); h.backend.bump();
  await h.click('网页登录'); await h.click('确认并生成登录链接');
  assert.equal(h.backend.login.state, 'idle');
  assert.match(h.joined(), /别处被改动/);
  await h.click('网页登录'); await h.click('确认并生成登录链接');
  assert.equal(h.backend.login.state, 'launching');
});

test('登录启动响应丢失时读回正在运行的任务，不误报失败或重复启动', async t => {
  const backend = new FakeBackend(); const handle = backend.handle.bind(backend);
  backend.handle = request => {
    const result = handle(request);
    if (request.op === 'startLogin') return { ok: false, error: new Error('响应丢失') };
    return result;
  };
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  await h.click('网页登录'); await h.click('确认并生成登录链接');
  assert.match(h.joined(), /检测到登录仍在进行/);
  assert.doesNotMatch(h.joined(), /启动登录失败/);
  assert.ok(h.buttonByText('取消登录'));
  assert.equal(backend.calls.filter(c => c.op === 'startLogin').length, 1);
});

for (const hostStarted of [true, false]) {
  test(`启动及补读同时断网时保护状态，恢复后收敛到 Host ${hostStarted ? '进行中' : '无任务'}`, async t => {
    const backend = new FakeBackend(); const handle = backend.handle.bind(backend);
    let disconnected = false;
    backend.handle = request => {
      if (request.op === 'startLogin') {
        if (hostStarted) handle(request);
        disconnected = true;
        return { ok: false, error: new Error('连接中断') };
      }
      if (disconnected && request.op === 'read') return { ok: false, error: new Error('连接仍中断') };
      return handle(request);
    };
    const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
    await h.click('网页登录'); await h.click('确认并生成登录链接');
    assert.match(h.joined(), /启动结果暂无法确认/);
    assert.doesNotMatch(h.joined(), /启动登录失败/);
    assert.equal(h.buttonByText('编辑').props.disabled, true);
    assert.equal(h.buttonByText('同步状态后可取消登录').props.disabled, true);
    await tick(1100); await h.flush();
    assert.equal(h.buttonByText('编辑').props.disabled, true, '补读再次失败仍须保持保护');
    disconnected = false;
    await tick(2100); await h.flush();
    if (hostStarted) {
      assert.equal(h.buttonByText('取消登录').props.disabled, false);
      assert.equal(h.buttonByText('编辑').props.disabled, true);
      await h.click('取消登录');
      assert.equal(backend.login.state, 'cancelled');
    } else assert.match(h.joined(), /未检测到进行中的登录/);
    assert.equal(h.buttonByText('编辑').props.disabled, false);
  });
}

test('登录状态查询短暂失败保留取消入口与写锁，恢复后可完成', async t => {
  const backend = new FakeBackend();
  backend.login = { jobId: 'ongoing', accountId: 'default', state: 'waiting', message: '等待授权' };
  const handle = backend.handle.bind(backend); let polls = 0;
  backend.handle = request => {
    if (request.op === 'loginStatus' && ++polls === 1) return { ok: false, error: new Error('临时网络错误') };
    return handle(request);
  };
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  await new Promise(r => setTimeout(r, 1100)); await h.flush();
  assert.match(h.joined(), /自动重试/);
  assert.equal(h.buttonByText('取消登录').props.disabled, false);
  assert.equal(h.buttonByText('编辑').props.disabled, true);
  backend.login = { ...backend.login, state: 'success', message: '官方授权已完成' };
  await new Promise(r => setTimeout(r, 2100)); await h.flush();
  assert.match(h.joined(), /官方授权已完成/);
  assert.equal(h.buttonByText('编辑').props.disabled, false);
});

test('删除正在编辑的账号会关闭旧表单，不留下可复活账号的保存入口', async t => {
  const h = createHarness(); t.after(() => h.dispose()); await h.flush();
  await h.click('编辑'); assert.ok(h.buttonByText('保存'));
  await h.click('删除'); await h.click('确认删除');
  assert.equal(h.backend.accounts.length, 0);
  assert.equal(h.buttonByText('保存'), undefined);
  assert.ok(h.buttonByText('网页登录'));
});

test('账号表单编辑中发起或确认登录会被拦截，草稿不丢失', async t => {
  const h = createHarness(); t.after(() => h.dispose()); await h.flush();
  await h.click('编辑'); assert.ok(h.buttonByText('保存'));
  await h.click('登录其他账号');
  assert.match(h.joined(), /先保存或取消账号表单/);
  assert.equal(h.buttonByText('确认并生成登录链接'), undefined, '编辑中不应弹出登录确认');
  assert.ok(h.buttonByText('保存'), '编辑草稿必须保留');
  // 确认框先弹出、之后再打开表单的交错顺序同样拦截。
  await h.click('取消');
  await h.click('登录其他账号'); assert.ok(h.buttonByText('确认并生成登录链接'));
  await h.click('编辑'); assert.ok(h.buttonByText('保存'));
  await h.click('确认并生成登录链接');
  assert.match(h.joined(), /先保存或取消账号表单/);
  assert.ok(h.buttonByText('保存'), '确认登录不得清空编辑草稿');
  assert.equal(h.backend.calls.filter(c => c.op === 'startLogin').length, 0);
});

test('已绑定账号可显式用于套餐，同时启用且不改变另一套餐', async t => {
  const backend = new FakeBackend(); backend.active['agent-plan'] = null; backend.enabled['agent-plan'] = false;
  backend.accounts[0] = { ...backend.accounts[0], authMode: 'oauth', oauthProfiles: { 'agent-plan': 'agent' }, hasQuotaAccess: { 'agent-plan': true, 'coding-plan': false } };
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  await h.click('用于 Agent套餐');
  assert.equal(backend.active['agent-plan'], 'default'); assert.equal(backend.enabled['agent-plan'], true);
  assert.equal(backend.active['coding-plan'], 'default');
  assert.deepEqual(backend.calls.filter(c => ['select', 'setProviderEnabled'].includes(c.op)).map(c => c.op), ['select', 'setProviderEnabled']);
});

test('未绑定套餐和缺少隔离 Profile 不提供必失败的目录或额度操作', async t => {
  const backend = new FakeBackend();
  backend.accounts[0] = { ...backend.accounts[0], authMode: 'oauth', oauthProfiles: { 'agent-plan': 'agent' }, hasQuotaAccess: { 'agent-plan': true, 'coding-plan': false } };
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  const buttons = name => h.buttons().filter(b => b.props.children === name);
  assert.equal(buttons('拉取模型')[0].props.disabled, false);
  assert.equal(buttons('拉取模型')[1].props.disabled, true);
  assert.equal(buttons('刷新额度')[1].props.disabled, true);
  assert.match(h.joined(), /确认已订阅此个人套餐/);
  backend.accounts[0] = { ...backend.accounts[0], authMode: 'references', cliProfile: '' };
  await h.click('刷新状态');
  assert.equal(buttons('拉取模型')[0].props.disabled, true);
  assert.match(h.joined(), /可使用本地模型快照/);
});

test('布局回归：统一页头、账号与两个套餐面板并存，技术细节默认折叠', async t => {
  const h = createHarness(); t.after(() => h.dispose()); await h.flush();
  assert.equal(h.tree.props.className, 'vcp-settings');
  assert.match(h.joined(), /火山方舟 Provider/);
  assert.match(h.joined(), /1 个账号 · 2 个套餐/);
  // 套餐启用与账号选择的容器在「账号与登录」分区，标识为「<套餐>接入」。
  for (const label of ['账号管理', '火山方舟 · Agent 套餐接入', '火山方舟 · 编程套餐接入']) {
    assert.equal(h.find(h.tree, node => node.type === 'section' && node.props['aria-label'] === label).length, 1, label);
  }
  assert.equal(h.selects().filter(node => /使用账号$/.test(node.props['aria-label'] ?? '')).length, 2, '两个套餐的账号选择必须同时可用');
  const accountSelectFields = h.find(h.tree, node => node.type === 'label'
    && h.find(node, child => child.type === 'select' && /使用账号$/.test(child.props['aria-label'] ?? '')).length > 0);
  assert.equal(accountSelectFields.length, 2);
  assert.ok(accountSelectFields.every(field => field.props.style.minWidth === 0), '账号字段须允许窄屏收缩');
  const cards = h.find(h.tree, node => String(node.props.className ?? '').split(' ').includes('vcp-card'));
  // 套餐接入面板已改为套在 PlanPanel 描边容器内，不再自带卡片外框；剩图片生成与账号两个卡片。
  assert.ok(cards.length >= 2, `应有独立卡片容器，实际 ${cards.length}`);
  assert.ok(cards.every(card => card.props.style?.padding === undefined), '卡片 padding 必须交给可响应断点的 scoped CSS');
  assert.match(h.buttonByText('登录其他账号').props.style.background, /#2563eb/, '主按钮实色回退必须保证白字对比度');
  assert.ok(h.buttons().every(button => String(button.props.className).includes('vcp-button')), '按钮应共享统一主次与焦点样式');
  // 模型列表与高级信息仍然默认折叠；套餐面板本身默认展开（用于承载内容）。
  const details = h.find(h.tree, node => node.type === 'details' && !String(node.props.className ?? '').includes('vcp-plan-panel'));
  assert.ok(details.length >= 3);
  assert.ok(details.every(node => node.props.open !== true), '高级信息和模型列表默认不应强制展开');
  // 每个功能分区内按套餐分面板：额度、模型、账号各两个。
  const planPanels = h.find(h.tree, node => String(node.props.className ?? '').split(' ').includes('vcp-plan-panel'));
  assert.equal(planPanels.length, 6, '额度/模型/账号三个分区各两个套餐面板');
  assert.equal(h.find(h.tree, node => /(^| )vcp-(plans|plan-workspace)( |$)/.test(String(node.props.className ?? ''))).length, 0, '套餐面板之间不得再有并排容器');
  assert.match(h.joined(), /账号高级配置与标识/);
  assert.equal(h.find(h.tree, node => node.props['aria-label'] === '火山方舟 · Agent 套餐额度').length, 1);
  assert.equal(h.find(h.tree, node => node.props['aria-label'] === '火山方舟 · 编程套餐额度').length, 1);
});

test('账号管理默认收起，展开编辑或登录进行中仍可访问', async t => {
  const backend = new FakeBackend();
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  const accountDetails = () => h.find(h.tree, node => node.type === 'details' && node.props.className === 'vcp-accounts-disclosure')[0];
  assert.equal(accountDetails().props.open, false);
  const summary = h.find(accountDetails(), node => node.type === 'summary')[0];
  accountDetails().props.onToggle({ target: { open: true } });
  await h.flush();
  assert.equal(accountDetails().props.open, true);
  await h.click('编辑');
  assert.equal(accountDetails().props.open, true);
  await h.click('取消');
  backend.login = { jobId: 'waiting', state: 'waiting', accountId: 'default', message: '等待授权（测试）' };
  await h.click('刷新状态');
  assert.equal(accountDetails().props.open, true);
  assert.ok(h.buttonByText('取消登录'));
});

test('额度倒计时按实际时间刷新，缺失与过期不伪造重置', async t => {
  const originalNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalDocument = globalThis.document;
  let clock = Date.parse('2026-10-27T08:00:00Z');
  let intervalId = 0;
  const intervals = new Map();
  Date.now = () => clock;
  // 额度自动轮询用 setTimeout，这里只收集倒计时用的 1 秒定时器。
  globalThis.setInterval = (callback, delay) => { assert.equal(delay, 1000); intervals.set(++intervalId, callback); return intervalId; };
  globalThis.clearInterval = id => intervals.delete(id);
  // 页面隐藏时自动轮询不查询：本用例只验证倒计时本身不触发额度请求。
  globalThis.document = { hidden: true, addEventListener() {}, removeEventListener() {} };
  let h;
  t.after(() => { h?.dispose(); Date.now = originalNow; globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
  const backend = new FakeBackend();
  // 首屏不给快照：本用例只验证手动采集后的倒计时行为。
  backend.quotas = {};
  backend.quotaWindows = [
    { kind: '5h', percent: 10, resetsAt: '2026-10-27T08:02:00Z', group: 'text' },
    { kind: 'week', percent: 20, group: 'text' },
    { kind: 'month', percent: 30, resetsAt: 'not-a-date', group: 'all' },
    { kind: 'day', percent: 40, resetsAt: '2026-10-27T07:59:00Z', group: 'daily-capabilities' }
  ];
  h = createHarness({ backend });
  await h.flush();
  await h.click('刷新额度');
  assert.match(h.joined(), /距重置 2分 0秒/);
  assert.match(h.joined(), /重置时间未提供/);
  assert.match(h.joined(), /重置时间不可用/);
  assert.match(h.joined(), /已到重置时间，等待自动刷新/);
  assert.equal(intervals.size, 1, '页面对多个额度窗口共用一个定时器');
  clock += 61000;
  for (const callback of [...intervals.values()]) callback();
  await h.flush();
  assert.match(h.joined(), /距重置 59秒/);
  assert.equal(backend.calls.filter(call => call.op === 'quota').length, 1, '倒计时不能自动刷新额度');
  h.dispose(); h = null;
  assert.equal(intervals.size, 0, '页面卸载后停止倒计时');
  h = createHarness({ backend });
  await h.flush(); await h.click('刷新额度');
  assert.equal(intervals.size, 1);
  clock += 59000;
  for (const callback of [...intervals.values()]) callback();
  await h.flush();
  assert.doesNotMatch(h.joined(), /距重置/);
  assert.equal(intervals.size, 0, '全部到期后停止定时器');
  assert.equal(backend.calls.filter(call => call.op === 'quota').length, 2, '到期不会自动触发网络查询');
});

test('两套餐各自共享倒计时时钟，刷新目标时仅回收对应套餐的旧时钟', async t => {
  const originalNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalDocument = globalThis.document;
  const clock = Date.parse('2026-10-27T08:00:00Z');
  let intervalId = 0;
  const intervals = new Map();
  Date.now = () => clock;
  globalThis.setInterval = (callback, delay) => { assert.equal(delay, 1000); intervals.set(++intervalId, callback); return intervalId; };
  globalThis.clearInterval = id => intervals.delete(id);
  // 页面隐藏时自动轮询不查询：本用例只验证手动刷新建立的倒计时时钟。
  globalThis.document = { hidden: true, addEventListener() {}, removeEventListener() {} };
  let harness;
  t.after(() => { harness?.dispose(); Date.now = originalNow; globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
  const backend = new FakeBackend();
  // 首屏不给快照：本用例只验证手动采集建立的倒计时时钟。
  backend.quotas = {};
  let agentReset = clock + 120_000;
  backend.quotaWindows = plan => [
    { kind: '5h', percent: 10, resetsAt: new Date(plan === 'agent-plan' ? agentReset : clock + 300_000).toISOString() },
    { kind: 'week', percent: 20, resetsAt: new Date(plan === 'agent-plan' ? agentReset : clock + 300_000).toISOString() }
  ];
  harness = createHarness({ backend });
  await harness.flush();
  const refreshPlan = async label => {
    const section = harness.find(harness.tree, node => node.type === 'section' && node.props['aria-label'] === label)[0];
    assert.ok(section, `缺少套餐分区：${label}`);
    const button = harness.find(section, node => node.type === 'button' && node.props.children === '刷新额度')[0];
    assert.ok(button && !button.props.disabled, `套餐额度刷新不可用：${label}`);
    button.props.onClick();
    await harness.flush();
  };
  await refreshPlan('火山方舟 · Agent 套餐额度');
  const agentTimer = [...intervals.keys()][0];
  assert.equal(intervals.size, 1, '同套餐的多个窗口只创建一个时钟');
  await refreshPlan('火山方舟 · 编程套餐额度');
  assert.equal(intervals.size, 2, '两个套餐独立维护时钟');
  const codingTimer = [...intervals.keys()].find(id => id !== agentTimer);
  agentReset = clock + 180_000;
  await refreshPlan('火山方舟 · Agent 套餐额度');
  assert.equal(intervals.size, 2);
  assert.equal(intervals.has(agentTimer), false, '重置目标变化时回收旧时钟');
  assert.equal(intervals.has(codingTimer), true, '另一套餐的时钟不受影响');
  assert.equal(backend.calls.filter(call => call.op === 'quota').length, 3);
  harness.dispose(); harness = null;
  assert.equal(intervals.size, 0, '卸载后回收两个套餐的时钟');
});

test('冷启动没有快照时补一次采集，随后由中间层接管', async t => {
  const backend = new FakeBackend();
  backend.quotas = {};
  const h = createHarness({ backend }); t.after(() => h.dispose());
  await h.flush();
  const quotaCalls = () => backend.calls.filter(call => call.op === 'quota');
  assert.equal(quotaCalls().length, 2, '冷启动为两个套餐各补一次采集');
  assert.ok(h.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'), '采集结果回填后立即可见');
  assert.ok(backend.calls.some(call => call.op === 'snapshots'), '先读中间层再决定是否补采');
  await h.flush();
  assert.equal(quotaCalls().length, 2, '已经有快照后不再补采');
});

test('额度自动轮询：只读中间层、后台更新后自动刷新、隐藏时暂停、卸载回收', async t => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const originalDocument = globalThis.document;
  const polls = new Map();
  let pollId = 0;
  // 只拦截读取中间层的 30 秒定时器；测试自身的 tick 等延时走真实实现。
  globalThis.setTimeout = (callback, delay, ...rest) => {
    if (Number(delay) === 30000) { const id = `poll:${++pollId}`; polls.set(id, callback); return id; }
    return realSetTimeout(callback, delay, ...rest);
  };
  globalThis.clearTimeout = id => {
    if (typeof id === 'string' && id.startsWith('poll:')) { polls.delete(id); return; }
    return realClearTimeout(id);
  };
  let visibility = null;
  globalThis.document = {
    hidden: false,
    addEventListener(name, handler) { if (name === 'visibilitychange') visibility = handler; },
    removeEventListener(name, handler) { if (name === 'visibilitychange' && visibility === handler) visibility = null; }
  };
  let h;
  t.after(() => {
    h?.dispose();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  });
  const backend = new FakeBackend();
  const quotaCalls = () => backend.calls.filter(call => call.op === 'quota');
  const snapshotCalls = () => backend.calls.filter(call => call.op === 'snapshots');
  const reads = () => backend.calls.filter(call => call.op === 'read');
  const firePoll = async () => {
    for (const callback of [...polls.values()]) callback();
    await h.flush();
  };
  h = createHarness({ backend });
  await h.flush();
  assert.equal(quotaCalls().length, 0, '打开设置不应触发额度查询');
  assert.ok(h.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'), '首屏直接渲染中间层快照');
  assert.equal(polls.size, 1, '只排一个读取定时器');

  // Host 采集器更新了快照：下一次读取后页面跟着更新，仍不发额度查询。
  backend.quotas['default:agent-plan'] = { at: Date.now(), value: { ...defaultQuotaValue('default', 'agent-plan'), windows: [{ kind: '5h', percent: 60 }] } };
  await firePoll();
  assert.ok(snapshotCalls().length >= 1, '按间隔读取中间层');
  assert.ok(h.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 40%'), '读取中间层后刷新显示');
  assert.equal(quotaCalls().length, 0, '读取中间层不会触发上游查询');

  // 模型目录采集更新了 state revision：页面重读整份快照（含模型列表）。
  const beforeReads = reads().length;
  backend.bump();
  await firePoll();
  assert.ok(reads().length > beforeReads, 'revision 变化后重读设置与模型目录');

  // 页面隐藏时暂停读取，回到前台立即补读。
  const beforeHidden = snapshotCalls().length;
  globalThis.document.hidden = true;
  await firePoll();
  assert.equal(snapshotCalls().length, beforeHidden, '页面隐藏时不读中间层');
  globalThis.document.hidden = false;
  assert.equal(typeof visibility, 'function', '需要监听 visibilitychange 才能回前台补读');
  visibility();
  await h.flush();
  assert.ok(snapshotCalls().length > beforeHidden, '回到前台立即补读');

  h.dispose(); h = null;
  assert.equal(polls.size, 0, '卸载后回收读取定时器');
});

test('设置页重开后先显示上次额度，不回到「未获取」', async t => {
  const h = createHarness(); t.after(() => h.dispose());
  await h.flush();
  assert.ok(h.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'));
  // 重开后的请求故意挂起：能画出额度就说明用的是留存结果，而不是等新查询返回。
  const original = h.backend.handle.bind(h.backend);
  h.backend.handle = request => request.op === 'quota' ? new Promise(() => {}) : original(request);
  // 关闭设置页：组件卸载，插件模块与远端仍在（真实宿主里再次打开就是重新挂载组件）。
  h.mini.unmount();
  await h.flush();
  assert.ok(h.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'), '重开后应立即显示上次额度');
  assert.doesNotMatch(h.joined(), /尚未获取额度/);
});

test('空闲与成功登录状态保持紧凑，进行中仍保留状态和取消入口', async t => {
  const backend = new FakeBackend();
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  assert.doesNotMatch(h.joined(), /网页登录状态/);
  backend.login = { jobId: 'done', state: 'success', accountId: 'default', message: '身份已核验（测试）' };
  await h.click('刷新状态'); assert.match(h.joined(), /身份已核验（测试）/); assert.doesNotMatch(h.joined(), /网页登录状态/);
  backend.login = { jobId: 'waiting', state: 'waiting', accountId: 'default', message: '等待授权（测试）' };
  await h.click('刷新状态'); assert.match(h.joined(), /登录状态/); assert.ok(h.buttonByText('取消登录'));
});

test('作用域样式：使用 DSW 变量、焦点和 390px 内断点，并随插件卸载', async t => {
  const previous = globalThis.document;
  const appended = [];
  let removed = 0;
  globalThis.document = {
    head: { querySelector: () => null, append: element => { appended.push(element); } },
    createElement: tag => {
      assert.equal(tag, 'style');
      return { dataset: {}, textContent: '', remove: () => { removed++; } };
    }
  };
  let h;
  try {
    h = createHarness(); await h.flush();
    const settingsStyle = appended.find(element => element.dataset.volcengineProvider !== undefined);
    const mediaStyle = appended.find(element => element.dataset.volcengineMedia !== undefined);
    assert.ok(settingsStyle);
    assert.ok(mediaStyle);
    assert.match(settingsStyle.textContent, /var\(--dsw-alias-label-primary/);
    assert.match(settingsStyle.textContent, /:focus-visible/);
    assert.match(settingsStyle.textContent, /\.vcp-select\{[^}]*flex:none/);
    assert.ok(!/\.vcp-select\{[^}]*flex(?:-basis)?:[^}]*220px/.test(settingsStyle.textContent), '选择框本身也不能有垂直 220px basis');
    assert.match(settingsStyle.textContent, /@media\(max-width:420px\)/);
    assert.match(settingsStyle.textContent, /\.vcp-card\{padding:10px 12px\}/);
    assert.match(settingsStyle.textContent, /@media\(max-width:420px\)\{[^}]*\.vcp-settings[^}]*\}\.vcp-card\{padding:10px\}/);
    assert.match(settingsStyle.textContent, /\.vcp-fields,\.vcp-fields-three\{grid-template-columns:1fr\}/);
    assert.match(mediaStyle.textContent, /\.vcp-media-card/);
    h.dispose(); h = null;
    assert.equal(removed, 2);
  } finally {
    h?.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('样式实例重叠：旧实例卸载只回收自己的样式，新实例保持可用', async () => {
  const previous = globalThis.document;
  const appended = [];
  const removed = [];
  globalThis.document = {
    head: { append: element => { appended.push(element); } },
    createElement: () => {
      const index = appended.length;
      return { dataset: {}, textContent: '', remove: () => { removed[index] = (removed[index] ?? 0) + 1; } };
    }
  };
  let first;
  let second;
  try {
    first = createHarness(); second = createHarness();
    await first.flush(); await second.flush();
    assert.equal(appended.length, 4, '每实例分别持有设置页与图片卡片样式，不能复用清理所有权');
    first.dispose(); first = null;
    assert.deepEqual(removed, [1, 1], '第一个实例不得删除第二个实例的样式');
    second.dispose(); second = null;
    assert.deepEqual(removed, [1, 1, 1, 1]);
  } finally {
    first?.dispose(); second?.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('真实构建产物通过宿主的单参数工厂返回插件导出', () => {
  const built = join(ROOT, 'lib', 'client.js');
  const react = createMiniReact();
  const exported = loadBundle(readFileSync(built, 'utf8'), react);
  assert.equal(exported.name, 'dsh-volcengine-provider');
  assert.deepEqual(exported.inject, ['slots', 'remote']);
  assert.equal(typeof exported.apply, 'function');
});

test('两套餐都用此账号：一次选择两个套餐，不改启用状态', async () => {
  const backend = new FakeBackend();
  backend.accounts.push({
    id: 'other', label: '另一个方舟账号',
    apiKeyRefs: { 'agent-plan': 'OTHER_AGENT_PLAN_API_KEY', 'coding-plan': 'OTHER_CODING_PLAN_API_KEY' },
    accessKeyRef: 'OTHER_ACCESSKEY', secretKeyRef: 'OTHER_SECRETKEY',
    hasApiKeys: { 'agent-plan': true, 'coding-plan': true }, hasQuotaKeys: true, authMode: 'references'
  });
  backend.active = { 'agent-plan': 'other', 'coding-plan': 'default' };
  backend.enabled = { 'agent-plan': true, 'coding-plan': false };
  const harness = createHarness({ backend });
  await harness.flush();
  // 首个账号卡是 default（仅 coding 选用）：点击后只需补选 agent。
  await harness.click('两套餐都用此账号');
  const selects = backend.calls.filter((call) => call.op === 'select');
  // coding 已是 default 只需补 agent：不重复发已选中的套餐。
  assert.deepEqual(selects.map((call) => [call.plan, call.accountId]), [['agent-plan', 'default']]);
  assert.deepEqual(backend.active, { 'agent-plan': 'default', 'coding-plan': 'default' });
  assert.equal(backend.enabled['coding-plan'], false, '一键同账号不得改变套餐启用状态');
  assert.match(harness.joined(), /启用状态未动/);
  harness.dispose();
});

test('套餐未绑定给出账号区重新登录入口', async () => {
  const backend = new FakeBackend();
  backend.accounts = [{
    id: 'default', label: '默认账号', displayName: '官方小明', authMode: 'oauth',
    identity: { name: '官方小明', userId: 'user-123', accountId: 'account-456' },
    loggedAt: '2026-10-26T12:00:00Z', oauthProfiles: { 'agent-plan': 'agent-personal' },
    hasApiKeys: {}, hasQuotaKeys: false,
    hasQuotaAccess: { 'agent-plan': true, 'coding-plan': false }
  }];
  const harness = createHarness({ backend });
  await harness.flush();
  await harness.click('去账号区重新登录');
  assert.match(harness.joined(), /确认并生成登录链接/);
  harness.dispose();
});

test('路由错误可复制脱敏诊断', async () => {
  const backend = new FakeBackend();
  backend.routingError = '模型路由更新失败；已保留此前可用路由。';
  const harness = createHarness({ backend });
  await harness.flush();
  await harness.click('复制诊断');
  // 无剪贴板环境的回退路径也必须有明确结果，不能静默失败。
  assert.match(harness.joined(), /已复制|复制失败/);
  harness.dispose();
});

test('额度未就绪时两个套餐都给出账号区编辑入口', async () => {
  const backend = new FakeBackend();
  backend.accounts[0].accessKeyRef = '';
  backend.accounts[0].secretKeyRef = '';
  backend.accounts[0].hasQuotaKeys = false;
  const harness = createHarness({ backend });
  await harness.flush();
  const edits = harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '去账号区编辑');
  assert.equal(edits.length, 2, '两个套餐卡片应各有一个编辑入口');
  harness.dispose();
});

// ── OAuth 登录态到期提醒 ───────────────────────────────────────────────────────

/** OAuth 账号夹具：到期时间由用例指定。 */
function oauthAccountFixture(oauthExpiresAt) {
  const backend = new FakeBackend();
  backend.accounts = [{
    id: 'default', label: '默认账号', displayName: '官方小明', authMode: 'oauth',
    identity: { name: '官方小明', userId: 'user-123', accountId: 'account-456' },
    loggedAt: '2026-10-26T12:00:00Z', oauthProfiles: { 'agent-plan': 'agent-personal', 'coding-plan': 'coding-personal' },
    hasApiKeys: { 'agent-plan': true, 'coding-plan': true }, hasQuotaKeys: true,
    hasQuotaAccess: { 'agent-plan': true, 'coding-plan': true },
    ...(oauthExpiresAt !== undefined ? { oauthExpiresAt } : {})
  }];
  return backend;
}

test('OAuth 账号展示登录态有效期与剩余时间', async () => {
  const backend = oauthAccountFixture(new Date(Date.now() + 40 * 3600 * 1000).toISOString());
  const harness = createHarness({ backend });
  await harness.flush();
  assert.match(harness.joined(), /登录态有效至/);
  assert.match(harness.joined(), /剩余 1天/);
  assert.match(harness.joined(), /有效期内官方 CLI 自动续期/);
  harness.dispose();
});

test('登录态剩余不足 2 小时升级为临期警告', async () => {
  const backend = oauthAccountFixture(new Date(Date.now() + 30 * 60 * 1000).toISOString());
  const harness = createHarness({ backend });
  await harness.flush();
  assert.match(harness.joined(), /登录态将在 30分钟后到期/);
  assert.match(harness.joined(), /请及时重新网页登录/);
  const note = harness.find(harness.tree, (node) => node.type === 'p' && /登录态将在/.test(String(node.props.children)));
  assert.equal(note.length, 1);
  assert.equal(note[0].props.style.fontWeight, 600, '临期提示使用警告样式');
  harness.dispose();
});

test('登录态到期给出错误提示与重新登录指引', async () => {
  const backend = oauthAccountFixture(new Date(Date.now() - 60 * 1000).toISOString());
  const harness = createHarness({ backend });
  await harness.flush();
  assert.match(harness.joined(), /登录态已到期，请重新网页登录/);
  const note = harness.find(harness.tree, (node) => node.type === 'p' && /登录态已到期/.test(String(node.props.children)));
  assert.equal(note.length, 1);
  assert.equal(note[0].props.role, 'alert');
  harness.dispose();
});

test('到期元数据缺失或凭据引用账号不显示到期提示', async () => {
  const missing = createHarness({ backend: oauthAccountFixture(undefined) });
  await missing.flush();
  assert.doesNotMatch(missing.joined(), /登录态/);
  missing.dispose();

  const invalid = createHarness({ backend: oauthAccountFixture('not-a-date') });
  await invalid.flush();
  assert.doesNotMatch(invalid.joined(), /登录态/);
  invalid.dispose();

  // 凭据引用账号即使误带到期字段也不展示（长效凭据不适用 SSO 到期）。
  const refs = new FakeBackend();
  refs.accounts[0].oauthExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  const references = createHarness({ backend: refs });
  await references.flush();
  assert.doesNotMatch(references.joined(), /登录态/);
  references.dispose();
});

test('登录确认与等待授权码界面展示官方时限说明', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.click('网页登录');
  const confirmation = harness.joined();
  assert.match(confirmation, /官方 SSO 登录态有效期 48 小时/);
  assert.match(confirmation, /到期后需要重新网页登录/);
  assert.match(confirmation, /授权码 10 分钟内有效/);
  await harness.click('确认并生成登录链接');
  // 进入等待授权码阶段后仍能看到时限说明。
  harness.backend.login = { jobId: 'job-1', accountId: 'default', state: 'waiting', message: '请在浏览器中完成登录', url: 'https://signin.volcengine.com/authorize/volc?state=abc&redirect=ark' };
  await tick(1200);
  await harness.flush();
  assert.match(harness.joined(), /授权码 10 分钟内有效；登录完成后官方 SSO 登录态有效期 48 小时/);
  harness.dispose();
});

test('图片设置单开关启用：选择默认模型后通过 setMedia 持久化且不展示视频入口', async () => {
  const backend = new FakeBackend();
  const harness = createHarness({ backend });
  await harness.flush();
  assert.doesNotMatch(harness.joined(), /Seedance|视频生成|volc_video/);
  await harness.click('图片生成');
  const initialSelector = harness.selects().find(node => node.props['aria-label'] === '默认图片模型');
  assert.ok(initialSelector);
  assert.equal(initialSelector.props.disabled, true, '未启用时选择器可见但禁用');
  const gate = harness.find(harness.tree, node => node.props?.['aria-label'] === '启用图片生成')[0];
  assert.ok(gate);
  gate.props.onChange({ target: { checked: true } });
  await harness.flush();
  const enabled = backend.calls.find(call => call.op === 'setMedia' && call.imageTool === true);
  assert.ok(enabled);
  assert.equal(enabled.riskAcknowledged, true, '开关写入必须同时确认按用量计费');
  assert.equal(backend.media.imageTool, true);
  const selector = harness.selects().find(node => node.props['aria-label'] === '默认图片模型');
  assert.ok(selector);
  assert.equal(selector.props.disabled, false);
  const options = harness.find(selector, node => node.type === 'option').map(node => node.props.value);
  assert.deepEqual(options, ['doubao-seedream-5-0-pro', 'doubao-seedream-5.5', 'doubao-seedream-5.0-flash']);
  selector.props.onChange({ target: { value: 'doubao-seedream-5.5' } });
  await harness.flush();
  const saved = backend.calls.find(call => call.op === 'setMedia' && call.imageModel === 'doubao-seedream-5.5');
  assert.ok(saved);
  assert.equal(backend.media.imageModel, 'doubao-seedream-5.5');
  assert.match(harness.joined(), /默认图片模型已切换为 Doubao Seedream 5.5/);
  harness.dispose();
});

test('设置分区按功能分组，只隐藏不卸载且切换后编辑状态保留', async () => {
  const backend = new FakeBackend();
  const defaults = { contextWindow: 32768, maxTokens: 8192, imageInput: true, toolsEnabled: true, reasoningEfforts: { low: 'low', high: 'high' }, defaultReasoning: 'low', forceAdaptiveThinking: true };
  backend.catalogs = [{ plan: 'agent-plan', accountId: 'default', count: 1, enabledCount: 1, source: 'remote', models: [{ id: 'demo-model', name: '示例模型', enabled: true, defaults, effective: { ...defaults }, settings: {} }] }];
  const harness = createHarness({ backend });
  await harness.flush();
  const tabs = () => harness.find(harness.tree, node => node.props?.role === 'tab');
  const selected = () => tabs().filter(node => node.props['aria-selected'] === true).map(node => String(node.props.children));
  const sections = () => harness.find(harness.tree, node => node.props?.className === 'vcp-tab-section');
  const hiddenFlags = () => sections().map(node => Boolean(node.props.hidden));
  assert.deepEqual(selected(), ['额度']);
  assert.equal(tabs().length, 4);
  const controls = tabs().map(node => node.props['aria-controls']);
  assert.equal(new Set(controls).size, 1, '所有标签应指向同一个持久 tabpanel');
  assert.equal(harness.find(harness.tree, node => node.props?.role === 'tabpanel')[0].props.id, controls[0]);
  // 分区按功能分组：额度、模型、图片生成、账号与登录。
  assert.deepEqual(hiddenFlags(), [false, true, true, true]);

  // 按分区内的内容定位，而不是靠渲染索引：分区顺序调整时断言仍然有效。
  const sectionWith = (label) => sections().find(node => harness.find(node, child => child.props?.['aria-label'] === label).length > 0);
  // 额度分区承载两个套餐的额度面板。
  const quotaSection = sectionWith('火山方舟 · Agent 套餐额度');
  assert.ok(quotaSection, '未找到 Agent 套餐额度所在分区');
  assert.equal(harness.find(quotaSection, node => node.props?.['aria-label'] === '火山方舟 · Agent 套餐额度').length, 1);
  assert.equal(harness.find(quotaSection, node => node.props?.['aria-label'] === '火山方舟 · 编程套餐额度').length, 1);
  // 模型分区承载两个套餐的模型目录。
  const modelsSection = sectionWith('火山方舟 · Agent 套餐模型目录');
  assert.ok(modelsSection, '未找到 Agent 套餐模型目录所在分区');
  assert.equal(harness.find(modelsSection, node => node.props?.['aria-label'] === '火山方舟 · Agent 套餐模型目录').length, 1);
  assert.equal(harness.find(modelsSection, node => node.props?.['aria-label'] === '火山方舟 · 编程套餐模型目录').length, 1);
  // 套餐启用与账号选择只在账号与登录分区出现一次，不在额度/模型分区重复。
  const accountsSection = sectionWith('火山方舟 · Agent 套餐接入');
  assert.ok(accountsSection, '未找到套餐接入所在分区');
  assert.equal(harness.find(accountsSection, node => node.props?.['aria-label'] === '火山方舟 · Agent 套餐接入').length, 1);
  assert.equal(harness.find(quotaSection, node => node.type === 'select').length, 0, '额度分区不得再放账号选择');
  assert.equal(harness.find(modelsSection, node => node.type === 'select').length, 0, '模型分区不得再放账号选择');
  // 套餐启用开关与账号选择各自只出现一次：散落多处会让用户不知道哪个才是生效的。
  // 两个套餐各一个启用开关：按前缀统计，任一套餐的开关重复都会被抓到。
  const enableSwitches = harness.find(harness.tree, node => node.type === 'input'
    && /^启用火山方舟 · /u.test(String(node.props['aria-label'] ?? '')));
  const accountSelects = harness.selects().filter(node => /使用账号$/u.test(node.props['aria-label'] ?? ''));
  assert.equal(enableSwitches.length, 2, '两个套餐各一个启用开关，不得散落多处');
  assert.equal(accountSelects.length, 2, '两个套餐各有一个账号选择，不多不少');
  // 只匹配「启用<套餐名>」的开关；模型行上的「启用模型 X」属于模型开关，不算。
  const isPlanSwitch = (node) => node.type === 'input' && /^启用火山方舟 · /u.test(String(node.props['aria-label'] ?? ''));
  assert.equal(harness.find(quotaSection, isPlanSwitch).length, 0, '额度分区不得出现套餐启用开关');
  assert.equal(harness.find(modelsSection, isPlanSwitch).length, 0, '模型分区不得出现套餐启用开关');

  // 在模型分区展开列表并打开参数编辑器。
  const summary = harness.find(modelsSection, node => node.type === 'summary' && /模型列表/.test(String(node.props.children)))[0];
  assert.ok(summary);
  summary.props.onClick({ preventDefault() {} });
  await harness.flush();
  await harness.click('参数');
  assert.ok(harness.buttonByText('收起参数'));
  // 切到额度再回模型，编辑器状态必须保留（分区只隐藏不卸载）。
  await harness.click('额度');
  assert.deepEqual(selected(), ['额度']);
  assert.deepEqual(hiddenFlags(), [false, true, true, true]);
  await harness.click('模型');
  assert.deepEqual(hiddenFlags(), [true, false, true, true]);
  assert.ok(harness.buttonByText('收起参数'), '标签切换不得卸载模型编辑器');
  await harness.click('账号与登录');
  assert.deepEqual(hiddenFlags(), [true, true, true, false]);

  // 键盘导航在四个功能分区之间循环。
  const key = value => harness.find(harness.tree, node => node.props?.role === 'tablist')[0].props.onKeyDown({ key: value, preventDefault() {} });
  // 从账号与登录回到第一个分区，再逐格前进，验证顺序与循环。
  key('Home');
  await harness.flush();
  assert.deepEqual(selected(), ['额度']);
  key('ArrowRight');
  await harness.flush();
  assert.deepEqual(selected(), ['模型']);
  key('ArrowRight');
  await harness.flush();
  assert.deepEqual(selected(), ['图片生成']);
  key('ArrowRight');
  await harness.flush();
  assert.match(selected()[0], /^账号与登录/);
  key('ArrowRight');
  await harness.flush();
  assert.deepEqual(selected(), ['额度'], '最后一个分区之后循环回第一个');
  key('End');
  await harness.flush();
  // End 跳到最后一个分区：账号与登录（带账号计数后缀）。
  assert.match(selected()[0], /^账号与登录/);
  key('Home');
  await harness.flush();
  assert.deepEqual(selected(), ['额度']);
  harness.dispose();
});

test('空账号自动进入账号与登录分区', async () => {
  const backend = new FakeBackend();
  backend.accounts = [];
  backend.active = { 'agent-plan': null, 'coding-plan': null };
  const harness = createHarness({ backend });
  await harness.flush();
  const selected = harness.find(harness.tree, node => node.props?.role === 'tab' && node.props['aria-selected'] === true);
  assert.deepEqual(selected.map(node => String(node.props.children)), ['账号与登录 (0)']);
  const sections = harness.find(harness.tree, node => node.props?.className === 'vcp-tab-section');
  assert.deepEqual(sections.map(node => Boolean(node.props.hidden)), [true, true, true, false]);
  harness.dispose();
});

test('图片生成缺套餐时跳到账号与登录，不会切到已废弃的分区', async () => {
  const backend = new FakeBackend();
  // 图片工具已启用，但 Agent 套餐停用：MediaCard 应给出跳转入口。
  backend.media = { riskAcknowledged: true, imageTool: true, imageModel: 'doubao-seedream-5-0-pro' };
  backend.enabled = { 'agent-plan': false, 'coding-plan': true };
  const h = createHarness({ backend });
  await h.flush();
  await h.click('图片生成');
  assert.ok(h.buttonByText('前往账号与登录'), '缺少跳转入口');
  await h.click('前往账号与登录');
  const selected = h.find(h.tree, node => node.props?.role === 'tab' && node.props['aria-selected'] === true);
  assert.match(String(selected[0]?.props.children), /^账号与登录/, '应切到账号与登录分区');
  // 关键回归：任何分区 id 失效都会让四个分区同时 hidden、整页空白。
  const sections = h.find(h.tree, node => node.props?.className === 'vcp-tab-section');
  assert.ok(sections.some(node => !node.props.hidden), '至少有一个分区保持可见');
  h.dispose();
});
