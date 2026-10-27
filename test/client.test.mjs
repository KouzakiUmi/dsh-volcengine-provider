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

/** 与 scripts/build.mjs 相同的文本变换：去 export、内联 remote.mjs、包进 ModuleLoader 工厂。 */
function buildBundleSource() {
  const remote = readSource('src/remote.mjs').replace(/^export /gm, '');
  const client = readSource('src/client.js').replace(/^export /gm, '');
  return `window.__ModuleLoader__.load({id:'dsh-volcengine-provider',factory:(require)=>{\n'use strict';\n${remote}\n${client}\nreturn {name,inject,apply};\n}});\n`;
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
    this.login = { jobId: null, state: 'idle', message: '' };
    this.quotaMode = 'ok';
    this.quotaError = '';
    this.conflictOnce = false;
  }

  bump() { this.revision = `rev-${this.calls.length}-${Math.random().toString(16).slice(2, 8)}`; }

  readShape() {
    return {
      revision: this.revision,
      accounts: this.accounts.map((account) => ({ ...account })),
      active: { ...this.active },
      enabled: { ...this.enabled },
      catalogs: this.accounts.flatMap((account) => ['agent-plan', 'coding-plan'].map((plan) => {
        const cached = this.catalogs.find((entry) => entry.accountId === account.id && entry.plan === plan);
        return {
          accountId: account.id, plan,
          count: cached ? cached.count : 7,
          source: cached ? cached.source : 'local-snapshot',
          ...(cached?.updatedAt ? { updatedAt: cached.updatedAt } : {})
        };
      })),
      login: { ...this.login },
      routes: { 'agent-plan': 'volcengine-agent-plan', 'coding-plan': 'volcengine-coding-plan' }
    };
  }

  handle(request) {
    this.calls.push(request);
    switch (request.op) {
      case 'read':
        return { ok: true, value: this.readShape() };
      case 'loginStatus':
        return { ok: true, value: { ...this.login } };
      case 'cancelLogin':
        this.login = { ...this.login, state: 'cancelled', message: '登录已取消' };
        return { ok: true, value: { ...this.login } };
      case 'quota':
        if (this.quotaMode === 'no-key') {
          return { ok: true, value: { accountId: request.accountId, plan: request.plan, state: 'no-key', windows: [], error: this.quotaError, updatedAt: new Date().toISOString() } };
        }
        return {
          ok: true,
          value: {
            accountId: request.accountId, plan: request.plan, state: 'ok', updatedAt: new Date().toISOString(),
            windows: [
              { kind: '5h', percent: 12.5, resetsAt: new Date().toISOString(), group: 'text', detail: { used: 3, limit: 24, unit: 'AFP', scope: '文本' } },
              { kind: 'week', percent: 40, group: 'text', detail: { used: 8, limit: 20, unit: 'AFP' } },
              { kind: 'day', percent: 95, group: 'daily-capabilities' }
            ]
          }
        };
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
        registered = { options: slotOptions, Component, props: slotOptions.inject ? slotOptions.inject() : {} };
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
    inputs, textInputs, selects, quotaBars, anchors, dispose,
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

test('额度 no-key：先显示后端原因，并提示网页登录出路', async () => {
  const harness = createHarness();
  await harness.flush();
  harness.backend.quotaMode = 'no-key';
  harness.backend.quotaError = '额度查询需要 IAM AK/SK，不是推理 API Key；也可使用网页登录';
  await harness.click('刷新额度');
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

  await harness.click('确认并打开官方登录页');
  assert.ok(harness.backend.calls.some((call) => call.op === 'startLogin'));
  assert.match(harness.joined(), /正在启动官方登录窗口/);
  assert.match(harness.joined(), /登录期间暂不能修改账号与套餐/);
  assert.equal(harness.buttonByText('编辑').props.disabled, true);
  assert.equal(harness.buttonByText('删除').props.disabled, true);
  assert.equal(harness.selects()[0].props.disabled, true);
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
  await tick(1200);
  await harness.flush();
  assert.match(harness.joined(), /登录成功，凭据已保存。/);
  assert.equal(harness.backend.calls.filter((call) => call.op === 'read').length, readsBefore + 1, '登录成功后应刷新一次 read');
  assert.equal(harness.selects()[0].props.value, 'default');
  assert.match(String(harness.selects()[0].props.children[1][0].props.children), /刚登录的官方账号/);
  assert.equal(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'), false, '同账号重新登录必须清理旧身份的额度');
  await harness.flush();
  assert.equal(harness.backend.calls.filter((call) => call.op === 'read').length, readsBefore + 1, '成功后的普通渲染不能反复 read');
  harness.dispose();
});

test('授权链接安全：白名单原样透传，其余一律不渲染，消息中的授权码被脱敏', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.click('网页登录');
  await harness.click('确认并打开官方登录页');

  const official = 'https://signin.volcengine.com/authorize/volc?state=abc&redirect=ark';
  harness.backend.login = { jobId: 'job-1', accountId: 'default', state: 'waiting', message: '授权码 code=SECRET-CODE-123 已收到', url: official };
  await tick(1200);
  await harness.flush();
  const anchor = harness.anchors()[0];
  assert.ok(anchor, '白名单链接应渲染');
  assert.equal(anchor.props.href, official, '授权链接必须原样转交');
  assert.match(String(anchor.props.children), /打开官方授权页面/);
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

test('构建脚本漂移守卫：测试用的文本变换必须与 scripts/build.mjs 一致', () => {
  const build = readSource('scripts/build.mjs');
  assert.match(build, /replace\(\/\^export \/gm, ''\)/, '构建的去 export 变换变了，测试需同步');
  assert.match(build, /return \{name,inject,apply\};/, '构建的导出形状变了，测试需同步');
  assert.match(build, /src\/remote\.mjs[\s\S]*src\/client\.js/, '构建的内联顺序变了，测试需同步');
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
  assert.equal(harness.selects()[0].props.value, 'default');
  assert.match(text, /本地备注：默认账号/);
  assert.match(text, /官方账号 ID：account-456/);
  assert.match(text, /官方用户 ID：user-123/);
  assert.match(text, /最近登录：/);
  assert.match(text, /Agent套餐：当前使用 · 已绑定/);
  assert.match(text, /编程套餐：当前使用 · 未绑定/);
  assert.match(text, /额度鉴权：OAuth 已就绪/);
  assert.match(text, /套餐绑定：未绑定/);
  assert.doesNotMatch(text, /AK 引用：|SK 引用：|推理引用：|缺少 AK\/SK|模型调用会失败|没有可用的额度鉴权/);
  assert.match(String(harness.selects()[0].props.children[1][0].props.children), /官方小明 · 备注：默认账号/);
  assert.match(text, /凭据状态：凭据服务不可用 token=\[REDACTED\]/);
  assert.doesNotMatch(text, /hidden-secret/);
  await harness.click('编辑');
  assert.match(harness.joined(), /此账号当前使用 OAuth，编辑引用不会切换鉴权方式/);
  harness.dispose();
});

test('额度空值不伪造 100%，仅有效百分比提供可访问进度与更新时间', async () => {
  const backend = new FakeBackend();
  const original = backend.handle.bind(backend);
  backend.handle = (request) => request.op === 'quota' ? { ok: true, value: {
    accountId: request.accountId, plan: request.plan, state: 'ok', updatedAt: '2026-10-26T12:00:00Z',
    windows: [
      { kind: '5h', percent: null, detail: { used: null, limit: 100, unit: 'AFP' } },
      { kind: 'week' }, { kind: 'month', percent: '', detail: { used: 0, limit: 10, unit: 'AFP' } },
      { kind: 'day', percent: 0 }
    ]
  } } : original(request);
  const harness = createHarness({ backend });
  await harness.flush();
  await harness.click('刷新额度');
  const text = harness.joined();
  const progress = harness.quotaBars();
  assert.equal(progress.length, 1, '只有真实的零用量可显示剩余100%');
  assert.equal(harness.find(harness.tree, node => node.props.className === 'vcp-quota-percent').length, 1);
  assert.doesNotMatch(text, /已用 null/);
  assert.match(text, /已用 0 \/ 10 AFP/);
  assert.match(text, /百分比未提供/);
  assert.match(text, /额度更新时间：/);
  assert.equal(progress[0].props['aria-valuenow'], 100);
  assert.equal(progress[0].props['aria-label'], '每日剩余额度');
  assert.equal(progress[0].props['aria-valuetext'], '剩余 100%');
  harness.dispose();
});

test('额度重置时间已过时不把旧用尽状态冒充当前状态', async t => {
  const backend = new FakeBackend();
  const original = backend.handle.bind(backend);
  backend.handle = request => request.op === 'quota' ? { ok: true, value: {
    accountId: request.accountId, plan: request.plan, state: 'ok',
    windows: [
      { kind: '5h', percent: 100, resetsAt: new Date(Date.now() + 60_000).toISOString() },
      { kind: 'week', percent: 100, resetsAt: new Date(Date.now() - 60_000).toISOString() }
    ]
  } } : original(request);
  const harness = createHarness({ backend }); t.after(() => harness.dispose());
  await harness.flush(); await harness.click('刷新额度');
  const rows = harness.find(harness.tree, node => node.props.className === 'vcp-quota-window');
  const textOf = row => harness.find(row, node => node.props.className === 'vcp-status-chip')[0]?.props.children;
  assert.deepEqual(rows.map(textOf), ['已用尽', '待刷新']);
  assert.equal(harness.quotaBars().filter(bar => bar.props['aria-valuenow'] === 0).length, 2);
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
  let resolveQuota;
  let delayed = true;
  backend.handle = (request) => request.op === 'quota' && delayed
    ? new Promise((resolve) => { resolveQuota = resolve; }) : original(request);
  const harness = createHarness({ backend });
  await harness.flush();
  await harness.click('刷新额度');
  assert.match(harness.joined(), /正在查询火山方舟 · Agent 套餐的额度/);
  assert.match(harness.joined(), /正在刷新额度/);
  assert.equal(harness.buttonByText('正在刷新额度').props.disabled, true);
  assert.equal(harness.buttonByText('编辑').props.disabled, false, '只读额度请求不能锁住账号管理');
  assert.equal(harness.selects()[0].props.disabled, false, '额度请求期间仍可切换账号');
  resolveQuota({ ok: false, error: '暂时不可用' });
  await harness.flush();
  assert.match(harness.joined(), /额度查询失败：暂时不可用/);
  assert.ok(harness.buttonByText('重试额度查询'));
  delayed = false;
  await harness.click('重试额度查询');
  assert.ok(harness.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 87.5%'));
  assert.doesNotMatch(harness.joined(), /额度查询失败/);
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
  await h.click('网页登录'); await h.click('确认并打开官方登录页');
  assert.equal(backend.accounts.length, 1);
  const start = backend.calls.find(c => c.op === 'startLogin');
  assert.equal(start.accountId, backend.accounts[0].id);
  assert.equal(start.revision, backend.revision);
  assert.deepEqual(backend.accounts[0].apiKeyRefs, {});
  assert.ok(h.buttonByText('取消登录'));
});

test('额度请求期间切换账号立即解锁查询且迟到响应不会覆盖新账号', async t => {
  const backend = new FakeBackend(); backend.accounts.push({ ...backend.accounts[0], id: 'second', label: '第二账号' });
  const handle = backend.handle.bind(backend); const pending = new Map();
  backend.handle = request => request.op === 'quota' ? new Promise(resolve => pending.set(request.accountId, resolve)) : handle(request);
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  await h.click('刷新额度');
  h.selects()[0].props.onChange({ target: { value: 'second' } }); await h.flush();
  await h.click('刷新额度');
  pending.get('second')({ ok: true, value: { plan: 'agent-plan', accountId: 'second', state: 'ok', windows: [{ kind: '5h', percent: 60 }] } }); await h.flush();
  pending.get('default')({ ok: true, value: { plan: 'agent-plan', accountId: 'default', state: 'ok', windows: [{ kind: '5h', percent: 99 }] } }); await h.flush();
  assert.ok(h.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 40%'));
  assert.ok(!h.quotaBars().some(bar => bar.props['aria-valuetext'] === '剩余 1%'));
});

test('已有账号可登录其他身份，不覆盖原账号或套餐选择', async t => {
  const h = createHarness(); t.after(() => h.dispose()); await h.flush();
  const old = JSON.stringify(h.backend.accounts[0]);
  await h.click('登录其他账号'); await h.click('确认并打开官方登录页');
  assert.equal(h.backend.accounts.length, 2);
  assert.equal(JSON.stringify(h.backend.accounts[0]), old);
  assert.equal(h.backend.active['agent-plan'], 'default');
  assert.equal(h.backend.calls.find(c => c.op === 'startLogin').accountId, 'account-1');
});

test('登录启动冲突会同步状态，下一次登录使用最新 revision', async t => {
  const h = createHarness(); t.after(() => h.dispose()); await h.flush(); h.backend.bump();
  await h.click('网页登录'); await h.click('确认并打开官方登录页');
  assert.equal(h.backend.login.state, 'idle');
  assert.match(h.joined(), /别处被改动/);
  await h.click('网页登录'); await h.click('确认并打开官方登录页');
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
  await h.click('网页登录'); await h.click('确认并打开官方登录页');
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
    await h.click('网页登录'); await h.click('确认并打开官方登录页');
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

test('布局回归：统一页头、账号与双套餐分区并存，技术细节默认折叠', async t => {
  const h = createHarness(); t.after(() => h.dispose()); await h.flush();
  assert.equal(h.tree.props.className, 'vcp-settings');
  assert.match(h.joined(), /火山方舟 Provider/);
  assert.match(h.joined(), /1 个账号 · 2 个套餐/);
  for (const label of ['账号管理', '火山方舟 · Agent 套餐', '火山方舟 · 编程套餐']) {
    assert.equal(h.find(h.tree, node => node.type === 'section' && node.props['aria-label'] === label).length, 1, label);
  }
  assert.equal(h.selects().length, 2, '两个套餐的账号选择必须同时可用');
  const accountSelectFields = h.find(h.tree, node => node.type === 'label'
    && h.find(node, child => child.type === 'select' && /使用账号$/.test(child.props['aria-label'] ?? '')).length > 0);
  assert.equal(accountSelectFields.length, 2);
  assert.ok(accountSelectFields.every(field => field.props.style.minWidth === 0), '账号字段须允许窄屏收缩');
  const cards = h.find(h.tree, node => String(node.props.className ?? '').split(' ').includes('vcp-card'));
  assert.ok(cards.length >= 3);
  assert.ok(cards.every(card => card.props.style?.padding === undefined), '卡片 padding 必须交给可响应断点的 scoped CSS');
  assert.match(h.buttonByText('登录其他账号').props.style.background, /#2563eb/, '主按钮实色回退必须保证白字对比度');
  assert.ok(h.buttons().every(button => String(button.props.className).includes('vcp-button')), '按钮应共享统一主次与焦点样式');
  const details = h.find(h.tree, node => node.type === 'details');
  assert.ok(details.length >= 3);
  assert.ok(details.every(node => node.props.open !== true), '高级信息和模型列表默认不应强制展开');
  assert.equal(h.find(h.tree, node => String(node.props.className ?? '').split(' ').includes('vcp-plans')).length, 1, '双套餐应随可用宽度并列');
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
  let prevented = false;
  summary.props.onClick({ preventDefault() { prevented = true; } });
  await h.flush();
  assert.equal(prevented, true);
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
  let clock = Date.parse('2026-10-27T08:00:00Z');
  let intervalId = 0;
  const intervals = new Map();
  Date.now = () => clock;
  globalThis.setInterval = (callback, delay) => { assert.equal(delay, 1000); intervals.set(++intervalId, callback); return intervalId; };
  globalThis.clearInterval = id => intervals.delete(id);
  let h;
  t.after(() => { h?.dispose(); Date.now = originalNow; globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; });
  const backend = new FakeBackend();
  const handle = backend.handle.bind(backend);
  backend.handle = request => {
    const result = handle(request);
    if (request.op === 'quota' && result.ok) result.value.windows = [
      { kind: '5h', percent: 10, resetsAt: '2026-10-27T08:02:00Z', group: 'text' },
      { kind: 'week', percent: 20, group: 'text' },
      { kind: 'month', percent: 30, resetsAt: 'not-a-date', group: 'all' },
      { kind: 'day', percent: 40, resetsAt: '2026-10-27T07:59:00Z', group: 'daily-capabilities' }
    ];
    return result;
  };
  h = createHarness({ backend });
  await h.flush();
  await h.click('刷新额度');
  assert.match(h.joined(), /距重置 2分 0秒/);
  assert.match(h.joined(), /重置时间未提供/);
  assert.match(h.joined(), /重置时间不可用/);
  assert.match(h.joined(), /已到重置时间，请刷新额度/);
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
  const clock = Date.parse('2026-10-27T08:00:00Z');
  let intervalId = 0;
  const intervals = new Map();
  Date.now = () => clock;
  globalThis.setInterval = (callback, delay) => { assert.equal(delay, 1000); intervals.set(++intervalId, callback); return intervalId; };
  globalThis.clearInterval = id => intervals.delete(id);
  let harness;
  t.after(() => { harness?.dispose(); Date.now = originalNow; globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval; });
  const backend = new FakeBackend();
  const handle = backend.handle.bind(backend);
  let agentReset = clock + 120_000;
  backend.handle = request => {
    const result = handle(request);
    if (request.op === 'quota' && result.ok) result.value.windows = [
      { kind: '5h', percent: 10, resetsAt: new Date(request.plan === 'agent-plan' ? agentReset : clock + 300_000).toISOString() },
      { kind: 'week', percent: 20, resetsAt: new Date(request.plan === 'agent-plan' ? agentReset : clock + 300_000).toISOString() }
    ];
    return result;
  };
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
  await refreshPlan('火山方舟 · Agent 套餐');
  const agentTimer = [...intervals.keys()][0];
  assert.equal(intervals.size, 1, '同套餐的多个窗口只创建一个时钟');
  await refreshPlan('火山方舟 · 编程套餐');
  assert.equal(intervals.size, 2, '两个套餐独立维护时钟');
  const codingTimer = [...intervals.keys()].find(id => id !== agentTimer);
  agentReset = clock + 180_000;
  await refreshPlan('火山方舟 · Agent 套餐');
  assert.equal(intervals.size, 2);
  assert.equal(intervals.has(agentTimer), false, '重置目标变化时回收旧时钟');
  assert.equal(intervals.has(codingTimer), true, '另一套餐的时钟不受影响');
  assert.equal(backend.calls.filter(call => call.op === 'quota').length, 3);
  harness.dispose(); harness = null;
  assert.equal(intervals.size, 0, '卸载后回收两个套餐的时钟');
});

test('空闲与成功登录状态保持紧凑，进行中仍保留状态和取消入口', async t => {
  const backend = new FakeBackend();
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  assert.doesNotMatch(h.joined(), /网页登录状态/);
  backend.login = { jobId: 'done', state: 'success', accountId: 'default', message: '身份已核验（测试）' };
  await h.click('刷新状态'); assert.match(h.joined(), /身份已核验（测试）/); assert.doesNotMatch(h.joined(), /网页登录状态/);
  backend.login = { jobId: 'waiting', state: 'waiting', accountId: 'default', message: '等待授权（测试）' };
  await h.click('刷新状态'); assert.match(h.joined(), /网页登录状态/); assert.ok(h.buttonByText('取消登录'));
});

test('作用域样式：使用 DSW 变量、焦点和 390px 内断点，并随插件卸载', async t => {
  const previous = globalThis.document;
  let appended = null;
  let removed = false;
  globalThis.document = {
    head: { querySelector: () => null, append: element => { appended = element; } },
    createElement: tag => {
      assert.equal(tag, 'style');
      return { dataset: {}, textContent: '', remove: () => { removed = true; } };
    }
  };
  let h;
  try {
    h = createHarness(); await h.flush();
    assert.ok(appended);
    assert.equal(appended.dataset.volcengineProvider, '');
    assert.match(appended.textContent, /var\(--dsw-alias-label-primary/);
    assert.match(appended.textContent, /:focus-visible/);
    assert.match(appended.textContent, /\.vcp-select\{[^}]*flex:none/);
    assert.ok(!/\.vcp-select\{[^}]*flex(?:-basis)?:[^}]*220px/.test(appended.textContent), '选择框本身也不能有垂直 220px basis');
    assert.match(appended.textContent, /@media\(max-width:420px\)/);
    assert.match(appended.textContent, /\.vcp-card\{padding:12px 14px\}/);
    assert.match(appended.textContent, /@media\(max-width:420px\)\{[^}]*\.vcp-settings[^}]*\}\.vcp-card\{padding:12px\}/);
    assert.match(appended.textContent, /\.vcp-fields,\.vcp-fields-three\{grid-template-columns:1fr\}/);
    h.dispose(); h = null;
    assert.equal(removed, true);
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
    assert.equal(appended.length, 2, '重叠实例必须各自持有样式，不能复用后无清理所有权');
    first.dispose(); first = null;
    assert.deepEqual(removed, [1], '第一个实例不得删除第二个实例的样式');
    second.dispose(); second = null;
    assert.deepEqual(removed, [1, 1]);
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
