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
import { readFileSync, existsSync } from 'node:fs';
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
    return instance.callbacks[index];
  }

  function useEffect(fn, deps) {
    const instance = current;
    const index = instance.index++;
    if (!depsChanged(instance, index, deps)) return;
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
  return `window.__ModuleLoader__.load({id:'dsh-volcengine-provider',factory:(require,exports,module)=>{\n'use strict';\n${remote}\n${client}\nmodule.exports={name,inject,apply};\n}});\n`;
}

/** 执行 bundle，取出 module.exports。 */
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
  const moduleRecord = { exports: {} };
  loaded.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`未预期的 require: ${id}`);
  }, moduleRecord.exports, moduleRecord);
  return moduleRecord.exports;
}

// ── 假后端 ────────────────────────────────────────────────────────────────────

class FakeBackend {
  constructor() {
    this.calls = [];
    this.revision = 'rev-1';
    this.accounts = [{
      id: 'default', label: '现有方舟账号',
      apiKeyRefs: { 'agent-plan': 'ARKCLI_AGENT_PLAN_API_KEY', 'coding-plan': 'ARKCLI_CODING_PLAN_API_KEY' },
      accessKeyRef: 'VOLC_ACCESSKEY', secretKeyRef: 'VOLC_SECRETKEY',
      hasApiKeys: { 'agent-plan': true, 'coding-plan': true }, hasQuotaKeys: true, authMode: 'references'
    }];
    this.active = { 'agent-plan': 'default', 'coding-plan': 'default' };
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
          hasQuotaKeys: true, authMode: 'oauth'
        }];
        this.bump();
        return { ok: true, value: this.readShape() };
      }
      case 'removeAccount':
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        this.accounts = this.accounts.filter((account) => account.id !== request.accountId);
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
  const selects = () => find(tree, (node) => node.type === 'select');
  const anchors = () => find(tree, (node) => node.type === 'a');
  const dispose = () => {
    // 组件卸载（清掉组件内的轮询定时器）+ 插件级清理（远端挂载、兜底等待）
    mini.unmount();
    for (const disposer of disposers) disposer();
  };

  return {
    backend, ctx, exported, mini, flush, render, find, buttons, buttonByText, click, texts, joined,
    inputs, selects, anchors, dispose,
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
  assert.equal(options.label(), 'dsh-volcengine-provider');
  assert.equal(typeof harness.registered.props.client.invoke, 'function');
  harness.dispose();
});

test('首次读取渲染：标题、双套餐卡片、账号、路由与 authMode', async () => {
  const harness = createHarness();
  await harness.flush();
  const text = harness.joined();
  assert.match(text, /dsh-volcengine-provider/);
  assert.match(text, /火山方舟 · Agent 套餐/);
  assert.match(text, /火山方舟 · 编程套餐/);
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
  assert.match(text, /剩余 87\.5%/);
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
  await harness.click('网页登录');
  const text = harness.joined();
  assert.match(text, /本插件为该账号准备的隔离目录/);
  assert.match(text, /不会改变你原有 CLI 的默认身份/);
  assert.match(text, /不会删除已经保存的凭据/);
  assert.match(text, /即使还没有 AK\/SK/);
  assert.ok(!harness.backend.calls.some((call) => call.op === 'startLogin'), '确认前不应发起 startLogin');

  await harness.click('确认并打开官方登录页');
  assert.ok(harness.backend.calls.some((call) => call.op === 'startLogin'));
  assert.match(harness.joined(), /正在启动官方登录窗口/);

  harness.backend.login = { jobId: 'job-1', accountId: 'default', state: 'waiting', message: '请在 ArkCli 打开的官方网页完成授权' };
  await tick(1200);
  await harness.flush();
  assert.ok(harness.backend.calls.filter((call) => call.op === 'loginStatus').length >= 1, '登录期间未轮询状态');
  assert.match(harness.joined(), /请在 ArkCli 打开的官方网页完成授权/);
  assert.match(harness.joined(), /当前登录账号：现有方舟账号/);

  const readsBefore = harness.backend.calls.filter((call) => call.op === 'read').length;
  harness.backend.login = { jobId: 'job-1', accountId: 'default', state: 'success', message: 'OAuth 登录已完成' };
  await tick(1200);
  await harness.flush();
  assert.match(harness.joined(), /登录成功，凭据已保存。/);
  assert.ok(harness.backend.calls.filter((call) => call.op === 'read').length > readsBefore, '登录成功后未刷新 read');
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

test('账号新增：AK/SK 可留空；删除需要二次确认', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.click('新增账号');
  const fields = harness.inputs();
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
  const fields = harness.inputs();
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
  assert.match(build, /module\.exports=\{name,inject,apply\};/, '构建的导出形状变了，测试需同步');
  assert.match(build, /src\/remote\.mjs[\s\S]*src\/client\.js/, '构建的内联顺序变了，测试需同步');
});

test('真实构建产物（若已构建）与内存构建的导出契约一致', () => {
  const built = join(ROOT, 'lib', 'client.js');
  if (!existsSync(built)) return; // 未构建时跳过；npm run check 会在测试后构建
  const react = createMiniReact();
  const exported = loadBundle(readFileSync(built, 'utf8'), react);
  assert.equal(exported.name, 'dsh-volcengine-provider');
  assert.deepEqual(exported.inject, ['slots', 'remote']);
  assert.equal(typeof exported.apply, 'function');
});
