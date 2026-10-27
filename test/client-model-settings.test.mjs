// test/client-model-settings.test.mjs —— 设置页模型管理的交互测试。
//
// ⚠️ 与 test/client.test.mjs 一样：本机没有可用的 React DOM 运行时，
// 所以这里用一个最小的 React 替身（createElement + useState/useRef/useCallback/useEffect）
// 驱动**真实的**组件源码，断言的是「组件逻辑 + 与 remote 的交互契约」：
// 每个用例都检查实际发出的 op 与 payload，而不是只比对渲染出来的字符串。
//
// 组件源码不能被直接 import：构建产物是一个 CommonJS 工厂。测试复刻
// scripts/build.mjs 的同一段文本变换后再加载，保证测到的就是构建时的那份代码。
//
// 依赖：无第三方包，无网络，无 GUI。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getModelRows } from '../src/catalog.mjs';
import { initialState } from '../src/state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 迷你 React 替身（与 test/client.test.mjs 保持同一套机制） ──────────────────

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
  return loaded.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`未预期的 require: ${id}`);
  });
}

// ── 假后端 ────────────────────────────────────────────────────────────────────

const PLANS = ['agent-plan', 'coding-plan'];

/** 目录里的模型（含能力默认值与生效值），与后端 catalogs[].models 的形状一致。 */
const CATALOG_MODELS = {
  'default:agent-plan': [
    {
      id: 'doubao-seed-2-1-pro-260915',
      name: 'Doubao Seed 2.1 Pro',
      capabilityUnverified: false,
      defaults: {
        contextWindow: 1048576, maxTokens: 256000,
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
        defaultReasoning: null, forceAdaptiveThinking: false
      }
    },
    {
      id: 'ark-code-latest',
      name: 'ark-code-latest',
      capabilityUnverified: true,
      defaults: {
        contextWindow: 32768, maxTokens: 32000,
        reasoningEfforts: { off: null, low: 'low' },
        defaultReasoning: null, forceAdaptiveThinking: false
      }
    }
  ],
  'default:coding-plan': [
    {
      id: 'doubao-seed-code',
      name: 'Doubao Seed Code',
      capabilityUnverified: false,
      defaults: {
        contextWindow: 262144, maxTokens: 65536,
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
        defaultReasoning: null, forceAdaptiveThinking: false
      }
    }
  ]
};

class FakeBackend {
  /**
   * @param {object} [options]
   * @param {boolean} [options.legacySnapshot] 旧快照：没有 enabled 字段
   * @param {boolean} [options.legacyCatalogs] 旧目录：没有 models 明细
   */
  constructor(options = {}) {
    this.options = options;
    this.calls = [];
    this.revision = 'rev-1';
    this.accounts = [{
      id: 'default', label: '现有方舟账号',
      apiKeyRefs: { 'agent-plan': 'ARKCLI_AGENT_PLAN_API_KEY', 'coding-plan': 'ARKCLI_CODING_PLAN_API_KEY' },
      accessKeyRef: 'VOLC_ACCESSKEY', secretKeyRef: 'VOLC_SECRETKEY',
      hasApiKeys: { 'agent-plan': true, 'coding-plan': true }, hasQuotaKeys: true, authMode: 'references'
    }];
    this.active = { 'agent-plan': 'default', 'coding-plan': 'default' };
    this.enabled = { 'agent-plan': true, 'coding-plan': true };
    this.modelEnabled = {};
    this.modelSettings = {};
    this.login = { jobId: null, state: 'idle', message: '' };
  }

  bump() { this.revision = `rev-${this.calls.length}-${Math.random().toString(16).slice(2, 8)}`; }

  modelKey(accountId, plan, modelId) { return `${accountId}:${plan}:${modelId}`; }

  readShape() {
    return {
      revision: this.revision,
      accounts: this.accounts.map((account) => ({ ...account })),
      active: { ...this.active },
      // 旧快照没有 enabled：客户端必须按启用处理。
      ...(this.options.legacySnapshot ? {} : { enabled: { ...this.enabled } }),
      catalogs: this.accounts.flatMap((account) => PLANS.map((plan) => {
        const rows = CATALOG_MODELS[`${account.id}:${plan}`] ?? [];
        const base = {
          accountId: account.id, plan,
          count: rows.length,
          source: 'remote',
          updatedAt: '2026-01-01T00:00:00.000Z'
        };
        if (this.options.legacyCatalogs) return base; // 旧目录：没有 models 明细
        const models = rows.map((row) => {
          const key = this.modelKey(account.id, plan, row.id);
          const settings = this.modelSettings[key] ?? {};
          const efforts = Object.hasOwn(settings, 'reasoningEfforts')
            ? settings.reasoningEfforts
            : row.defaults.reasoningEfforts;
          return {
            id: row.id,
            name: row.name,
            enabled: this.modelEnabled[key] !== false,
            capabilityUnverified: row.capabilityUnverified,
            settings,
            defaults: { ...row.defaults },
            effective: {
              ...row.defaults,
              ...(Object.hasOwn(settings, 'contextWindow') ? { contextWindow: settings.contextWindow } : {}),
              ...(Object.hasOwn(settings, 'maxTokens') ? { maxTokens: settings.maxTokens } : {}),
              ...(Object.hasOwn(settings, 'temperature') ? { temperature: settings.temperature } : {}),
              reasoningEfforts: efforts,
              ...(Object.hasOwn(settings, 'defaultReasoning') ? { defaultReasoning: settings.defaultReasoning } : {}),
              ...(Object.hasOwn(settings, 'forceAdaptiveThinking') ? { forceAdaptiveThinking: settings.forceAdaptiveThinking } : {})
            }
          };
        });
        return { ...base, enabledCount: models.filter((item) => item.enabled).length, models };
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
      case 'setProviderEnabled': {
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        this.enabled = { ...this.enabled, [request.plan]: request.enabled };
        this.bump();
        return { ok: true, value: this.readShape() };
      }
      case 'setModelEnabled': {
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        this.modelEnabled[this.modelKey(request.accountId, request.plan, request.modelId)] = request.enabled;
        this.bump();
        return { ok: true, value: this.readShape() };
      }
      case 'saveModelSettings': {
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        this.modelSettings[this.modelKey(request.accountId, request.plan, request.modelId)] = structuredClone(request.settings);
        this.bump();
        return { ok: true, value: this.readShape() };
      }
      case 'resetModelSettings': {
        if (request.revision !== this.revision) return { ok: false, error: new Error('设置已改变，请刷新后重试') };
        delete this.modelSettings[this.modelKey(request.accountId, request.plan, request.modelId)];
        this.bump();
        return { ok: true, value: this.readShape() };
      }
      case 'quota':
        return { ok: true, value: { accountId: request.accountId, plan: request.plan, state: 'ok', windows: [] } };
      default:
        return { ok: false, error: new Error(`未知 op: ${request.op}`) };
    }
  }
}

// ── 测试夹具 ──────────────────────────────────────────────────────────────────

function createHarness(options = {}) {
  const backend = options.backend ?? new FakeBackend(options.backendOptions ?? {});
  const mini = createMiniReact();
  const exported = loadBundle(buildBundleSource(), mini);

  let registered = null;
  const disposers = [];

  const service = { invoke: async (request) => backend.handle(request) };
  const ctx = {
    slots: {
      inject(name, fn) { fn(); },
      register(slotOptions, Component) {
        registered = { options: slotOptions, Component, props: slotOptions.inject ? slotOptions.inject() : {} };
      }
    },
    remote: { $mount() { return Promise.resolve(() => {}); } },
    inject(deps, callback) { callback({ remote: { volcengineProvider: service } }); return { dispose() {} }; },
    effect(fn) { disposers.push(fn()); },
    get() { return service; }
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
  const byLabel = (type, label) => find(tree, (node) => node.type === type && node.props?.['aria-label'] === label)[0];
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
  const checkboxes = () => find(tree, (node) => node.type === 'input' && node.props.type === 'checkbox');
  const clicks = async (node) => {
    assert.ok(node, '要点击的控件不存在');
    node.props.onClick({ preventDefault() {} });
    await flush();
  };
  const change = async (node, value) => {
    assert.ok(node, '要修改的控件不存在');
    node.props.onChange({ target: { value } });
    await flush();
  };
  const toggle = async (node, checked) => {
    assert.ok(node, '要切换的复选框不存在');
    node.props.onChange({ target: { checked } });
    await flush();
  };
  const select = () => find(tree, (node) => node.type === 'select');
  const dispose = () => {
    mini.unmount();
    for (const disposer of disposers) disposer();
  };

  return {
    backend, mini, flush, find, texts, joined, checkboxes, clicks, change, toggle, select, dispose, byLabel,
    get tree() { return tree; }
  };
}

// ── 用例 ──────────────────────────────────────────────────────────────────────

test('套餐启用开关：发 setProviderEnabled，关闭后仍保留账号选择', async () => {
  const harness = createHarness();
  await harness.flush();

  const providerCheckbox = harness.byLabel('input', '启用火山方舟 · Agent 套餐');
  assert.ok(providerCheckbox, '缺少 Agent 套餐启用复选框');
  assert.equal(providerCheckbox.props.checked, true, '默认应为启用');

  await harness.toggle(providerCheckbox, false);

  const call = harness.backend.calls.find((item) => item.op === 'setProviderEnabled');
  assert.ok(call, '未发起 setProviderEnabled');
  assert.equal(call.plan, 'agent-plan');
  assert.equal(call.enabled, false);
  assert.equal(call.revision, 'rev-1');

  // 关闭套餐不得清掉账号选择。
  assert.equal(harness.backend.active['agent-plan'], 'default');
  assert.equal(harness.select()[0].props.value, 'default');
  // The redesigned layout separates the state badge from the routing hint.
  assert.match(harness.joined(), /套餐已停用/);
  assert.match(harness.joined(), /不注册模型路由/);

  // Coding 套餐不受影响。
  assert.equal(harness.backend.enabled['coding-plan'], true);
  harness.dispose();
});

test('模型行以友好名称为标题，调用 ID 收入默认折叠详情且操作仍按 ID', async () => {
  const h = createHarness(); await h.flush();
  const id = 'doubao-seed-2-1-pro-260915';
  const row = h.find(h.tree, node => node.props.className === 'vcp-model')[0];
  const title = h.find(row, node => node.props.className === 'vcp-model-name')[0];
  assert.equal(title.props.children, 'Doubao Seed 2.1 Pro'); assert.equal(title.props.title, id);
  const details = h.find(row, node => node.type === 'details')[0];
  assert.ok(details && details.props.open !== true);
  assert.equal(h.find(details, node => node.props.className === 'vcp-model-id')[0].props.children, `调用 ID：${id}`);
  await h.toggle(h.byLabel('input', `启用模型 ${id}`), false);
  assert.equal(h.backend.calls.find(call => call.op === 'setModelEnabled').modelId, id);
  h.dispose();
});

test('旧默认档位失效时显示修复入口，重新选择后更新配置', async t => {
  const backend = new FakeBackend(), state = initialState(), key = 'default:agent-plan', modelId = 'glm-5.3';
  backend.modelSettings[`${key}:${modelId}`] = { defaultReasoning: 'medium' };
  state.catalogs[key] = { models: [{ id: modelId, name: modelId }] };
  const originalRead = backend.readShape.bind(backend);
  backend.readShape = () => {
    const shape = originalRead();
    state.modelSettings[key] = { [modelId]: backend.modelSettings[`${key}:${modelId}`] };
    const catalog = shape.catalogs.find(row => row.plan === 'agent-plan');
    catalog.models = getModelRows(state, 'default', 'agent-plan'); catalog.count = 1; catalog.enabledCount = 1;
    return shape;
  };
  const h = createHarness({ backend }); t.after(() => h.dispose()); await h.flush();
  assert.match(h.joined(), /已保存的默认思考档位 medium/);
  assert.match(h.joined(), /部分模型设置需要确认/);
  assert.match(h.joined(), /展开模型列表可查看原因并调整/);
  await h.clicks(h.byLabel('button', `模型参数 ${modelId}`));
  const select = h.byLabel('select', '默认思考档位 defaultReasoning');
  const oldOption = h.find(select, node => node.type === 'option' && node.props.value === 'medium')[0];
  assert.equal(oldOption.props.disabled, true); assert.match(oldOption.props.children, /已失效/);
  await h.change(select, 'high');
  await h.clicks(h.find(h.tree, node => node.type === 'button' && node.props.children === '保存参数')[0]);
  assert.equal(backend.calls.find(call => call.op === 'saveModelSettings').settings.defaultReasoning, 'high');
  assert.doesNotMatch(h.joined(), /已保存的默认思考档位 medium/);
});

test('能力状态区分文档缺项和动态路由，常驻模型不提供关闭档位', async t => {
  const backend=new FakeBackend(),state=initialState(),key='default:agent-plan';
  state.catalogs[key]={models:[{id:'kimi-k3-1-pro-261024'},{id:'kimi-k2.7-code'},{id:'auto'}]};
  const read=backend.readShape.bind(backend);
  backend.readShape=()=>{const shape=read(),catalog=shape.catalogs.find(row=>row.plan==='agent-plan');catalog.models=getModelRows(state,'default','agent-plan');catalog.count=3;catalog.enabledCount=3;return shape;};
  const h=createHarness({backend});t.after(()=>h.dispose());await h.flush();
  assert.doesNotMatch(h.joined(),/能力未核实/);assert.match(h.joined(),/动态路由/);assert.match(h.joined(),/部分参数未公开/);assert.match(h.joined(),/常驻思考/);assert.match(h.joined(),/默认档位 max/);
  await h.clicks(h.byLabel('button','模型参数 kimi-k3-1-pro-261024'));
  assert.ok(!h.find(h.byLabel('select','默认思考档位 defaultReasoning'),node=>node.type==='option').some(node=>node.props.value==='off'));
  await h.change(h.byLabel('select','思考档位映射 reasoningEfforts'),'map');
  await h.change(h.byLabel('textarea','JSON 映射'),'{"off":null,"low":"low"}');
  await h.clicks(h.find(h.tree,node=>node.type==='button'&&node.props.children==='保存参数')[0]);
  assert.match(h.joined(),/请移除 off 映射/);assert.equal(backend.calls.some(call=>call.op==='saveModelSettings'),false);
  await h.change(h.byLabel('textarea','JSON 映射'),'{"off":"low","low":"high"}');
  await h.change(h.byLabel('select','默认思考档位 defaultReasoning'),'off');
  await h.clicks(h.find(h.tree,node=>node.type==='button'&&node.props.children==='保存参数')[0]);
  const saved=backend.calls.find(call=>call.op==='saveModelSettings');assert.equal(saved.settings.defaultReasoning,'off');assert.deepEqual(saved.settings.reasoningEfforts,{off:'low',low:'high'});
});

test('旧快照缺少 enabled 时按启用处理', async () => {
  const harness = createHarness({ backendOptions: { legacySnapshot: true } });
  await harness.flush();
  const providerCheckbox = harness.byLabel('input', '启用火山方舟 · Agent 套餐');
  assert.ok(providerCheckbox, '缺少 Agent 套餐启用复选框');
  assert.equal(providerCheckbox.props.checked, true, '旧快照默认应为启用');
  await harness.toggle(providerCheckbox, false);
  const call = harness.backend.calls.find((item) => item.op === 'setProviderEnabled');
  assert.ok(call, '未发起 setProviderEnabled');
  assert.equal(call.enabled, false);
  harness.dispose();
});

test('模型开关：发 setModelEnabled，并展示启用数/总数', async () => {
  const harness = createHarness();
  await harness.flush();

  const modelCheckbox = harness.byLabel('input', '启用模型 doubao-seed-2-1-pro-260915');
  assert.ok(modelCheckbox, '缺少模型启用复选框');
  assert.equal(modelCheckbox.props.checked, true);

  await harness.toggle(modelCheckbox, false);

  const call = harness.backend.calls.find((item) => item.op === 'setModelEnabled');
  assert.ok(call, '未发起 setModelEnabled');
  assert.equal(call.accountId, 'default');
  assert.equal(call.plan, 'agent-plan');
  assert.equal(call.modelId, 'doubao-seed-2-1-pro-260915');
  assert.equal(call.enabled, false);
  assert.equal(call.revision, 'rev-1');

  assert.match(harness.joined(), /模型列表（已启用 1 \/ 共 2）/);
  harness.dispose();
});

test('模型参数保存：只发有效字段，负载形状符合契约', async () => {
  const harness = createHarness();
  await harness.flush();

  await harness.clicks(harness.byLabel('button', '模型参数 doubao-seed-2-1-pro-260915'));
  await harness.change(harness.byLabel('input', '上下文长度 contextWindow'), '131072');
  await harness.change(harness.byLabel('input', '温度 temperature'), '0.3');
  await harness.change(harness.byLabel('select', '默认思考档位 defaultReasoning'), 'high');
  await harness.clicks(harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '保存参数')[0]);

  const call = harness.backend.calls.find((item) => item.op === 'saveModelSettings');
  assert.ok(call, '未发起 saveModelSettings');
  assert.equal(call.accountId, 'default');
  assert.equal(call.plan, 'agent-plan');
  assert.equal(call.modelId, 'doubao-seed-2-1-pro-260915');
  assert.equal(call.revision, 'rev-1');
  assert.deepEqual(call.settings, { contextWindow: 131072, temperature: 0.3, defaultReasoning: 'high' });
  // 未填写的字段不得出现在负载里（空值＝继承）。
  assert.ok(!Object.hasOwn(call.settings, 'maxTokens'));
  assert.ok(!Object.hasOwn(call.settings, 'reasoningEfforts'));
  assert.ok(!Object.hasOwn(call.settings, 'forceAdaptiveThinking'));
  harness.dispose();
});

test('模型参数：空数字等于继承，档位与思考模式按三态写入', async () => {
  const harness = createHarness();
  await harness.flush();

  await harness.clicks(harness.byLabel('button', '模型参数 doubao-seed-2-1-pro-260915'));
  // 清空上下文长度 → 继承目录默认，负载里不应出现该字段。
  await harness.change(harness.byLabel('input', '上下文长度 contextWindow'), '');
  await harness.change(harness.byLabel('select', '思考档位映射 reasoningEfforts'), 'none');
  await harness.change(harness.byLabel('select', '默认思考档位 defaultReasoning'), 'none');
  await harness.change(harness.byLabel('select', '思考模式 forceAdaptiveThinking'), 'true');
  await harness.clicks(harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '保存参数')[0]);

  const call = harness.backend.calls.find((item) => item.op === 'saveModelSettings');
  assert.ok(call, '未发起 saveModelSettings');
  assert.deepEqual(call.settings, { reasoningEfforts: false, defaultReasoning: null, forceAdaptiveThinking: true });
  assert.ok(!Object.hasOwn(call.settings, 'contextWindow'));
  harness.dispose();
});

test('模型参数：非法输入只提示错误，不发 RPC', async () => {
  const harness = createHarness();
  await harness.flush();

  await harness.clicks(harness.byLabel('button', '模型参数 doubao-seed-2-1-pro-260915'));
  await harness.change(harness.byLabel('input', '上下文长度 contextWindow'), 'abc');
  await harness.clicks(harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '保存参数')[0]);

  assert.ok(!harness.backend.calls.some((item) => item.op === 'saveModelSettings'), '非法输入不应发起 saveModelSettings');
  assert.match(harness.joined(), /上下文长度 contextWindow 须为正整数/);

  // 温度越界同样不发 RPC。
  await harness.change(harness.byLabel('input', '上下文长度 contextWindow'), '');
  await harness.change(harness.byLabel('input', '温度 temperature'), '5');
  await harness.clicks(harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '保存参数')[0]);
  assert.ok(!harness.backend.calls.some((item) => item.op === 'saveModelSettings'), '越界温度不应发起 saveModelSettings');
  assert.match(harness.joined(), /温度 temperature 须为 0 到 1/);
  harness.dispose();
});

test('模型参数：预算模式拦截 xhigh/max，并提示手工调整 JSON', async () => {
  const harness = createHarness();
  await harness.flush();

  await harness.clicks(harness.byLabel('button', '模型参数 ark-code-latest'));
  await harness.change(harness.byLabel('select', '思考档位映射 reasoningEfforts'), 'map');
  await harness.change(harness.byLabel('textarea', 'JSON 映射'), '{"off": null, "low": "low", "xhigh": "xhigh"}');
  await harness.change(harness.byLabel('select', '思考模式 forceAdaptiveThinking'), 'false');
  await harness.clicks(harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '保存参数')[0]);

  assert.ok(!harness.backend.calls.some((item) => item.op === 'saveModelSettings'), '预算模式下的 xhigh 不应发起 saveModelSettings');
  assert.match(harness.joined(), /预算模式仅支持 off\/minimal\/low\/medium\/high，非 off 映射值与档位同名/);
  // 不得静默删掉已有映射：JSON 文本仍保留原样。
  assert.equal(harness.byLabel('textarea', 'JSON 映射').props.value, '{"off": null, "low": "low", "xhigh": "xhigh"}');

  // 原生 effort 模式按声明的映射值发送，同样的 JSON 可以保存。
  await harness.change(harness.byLabel('select', '思考模式 forceAdaptiveThinking'), 'true');
  await harness.clicks(harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '保存参数')[0]);
  const call = harness.backend.calls.find((item) => item.op === 'saveModelSettings');
  assert.ok(call, '原生 effort 模式应能保存');
  assert.deepEqual(call.settings.reasoningEfforts, { off: null, low: 'low', xhigh: 'xhigh' });
  assert.equal(call.settings.forceAdaptiveThinking, true);
  harness.dispose();
});

test('恢复默认：发 resetModelSettings，不带任何参数', async () => {
  const harness = createHarness();
  await harness.flush();

  await harness.clicks(harness.byLabel('button', '恢复默认 doubao-seed-2-1-pro-260915'));
  const call = harness.backend.calls.find((item) => item.op === 'resetModelSettings');
  assert.ok(call, '未发起 resetModelSettings');
  assert.equal(call.accountId, 'default');
  assert.equal(call.plan, 'agent-plan');
  assert.equal(call.modelId, 'doubao-seed-2-1-pro-260915');
  assert.equal(call.revision, 'rev-1');
  assert.ok(!Object.hasOwn(call, 'settings'), '恢复默认不应带参数负载');
  harness.dispose();
});

test('旧目录没有 models 明细时安全降级，不报错也没有模型开关', async () => {
  const harness = createHarness({ backendOptions: { legacyCatalogs: true } });
  await harness.flush();
  assert.match(harness.joined(), /该目录暂无模型明细/);
  assert.equal(harness.checkboxes().length, 2, '只有两个套餐启用复选框');
  assert.ok(!harness.backend.calls.some((item) => item.op === 'setModelEnabled'));
  harness.dispose();
});

test('模型列表可折叠，展开后仍可操作单个模型', async () => {
  const harness = createHarness();
  await harness.flush();
  const details = harness.find(harness.tree, (node) => node.type === 'details' && String(node.props.children?.[0]?.props.children).startsWith('模型列表'))[0];
  assert.ok(details, '缺少模型列表容器');
  assert.equal(details.props.open, false, '默认折叠');
  await harness.clicks(details.props.children[0]);
  const opened = harness.find(harness.tree, (node) => node.type === 'details' && String(node.props.children?.[0]?.props.children).startsWith('模型列表'))[0];
  assert.equal(opened.props.open, true, '展开后应处于展开状态');
  assert.ok(harness.byLabel('button', '模型参数 doubao-seed-2-1-pro-260915'), '展开后应有参数入口');
  harness.dispose();
});

test('两套套餐的启用开关互相独立', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.toggle(harness.byLabel('input', '启用火山方舟 · 编程套餐'), false);
  const call = harness.backend.calls.find((item) => item.op === 'setProviderEnabled');
  assert.ok(call, '未发起 setProviderEnabled');
  assert.equal(call.plan, 'coding-plan');
  assert.equal(call.enabled, false);
  assert.equal(harness.backend.enabled['agent-plan'], true, 'Agent 套餐不应受影响');
  assert.equal(harness.backend.enabled['coding-plan'], false);
  harness.dispose();
});

test('预算模式下 off 只能是 null，非法值不发 RPC', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.clicks(harness.byLabel('button', '模型参数 ark-code-latest'));
  await harness.change(harness.byLabel('select', '思考档位映射 reasoningEfforts'), 'map');
  await harness.change(harness.byLabel('textarea', 'JSON 映射'), '{"off": "off", "low": "low"}');
  await harness.change(harness.byLabel('select', '思考模式 forceAdaptiveThinking'), 'false');
  await harness.clicks(harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '保存参数')[0]);
  assert.ok(!harness.backend.calls.some((item) => item.op === 'saveModelSettings'), '非法 off 映射不应发起 saveModelSettings');
  assert.match(harness.joined(), /预算模式下 off 档位只能为空值/);
  harness.dispose();
});

test('自定义思考映射切回继承时只显示目录档位并清除不兼容默认档位', async t => {
  const backend = new FakeBackend();
  backend.modelSettings['default:agent-plan:ark-code-latest'] = { reasoningEfforts: { high: 'high' }, defaultReasoning: 'high' };
  const harness = createHarness({ backend }); t.after(() => harness.dispose()); await harness.flush();
  await harness.clicks(harness.byLabel('button', '模型参数 ark-code-latest'));
  await harness.change(harness.byLabel('select', '思考档位映射 reasoningEfforts'), 'inherit');
  const select = harness.byLabel('select', '默认思考档位 defaultReasoning');
  assert.equal(select.props.value, 'inherit');
  const options = harness.find(select, node => node.type === 'option').map(node => node.props.value);
  assert.ok(options.includes('low')); assert.ok(!options.includes('high'));
  await harness.clicks(harness.find(harness.tree, node => node.type === 'button' && node.props.children === '保存参数')[0]);
  assert.deepEqual(backend.calls.find(call => call.op === 'saveModelSettings').settings, {});
});

test('路由失败时保存的模型配置不得称为生效值，恢复停用模型明确会启用', async t => {
  const backend = new FakeBackend(); const read = backend.readShape.bind(backend);
  backend.readShape = () => ({ ...read(), routingError: '模型路由更新失败' });
  backend.modelEnabled['default:agent-plan:ark-code-latest'] = false;
  const harness = createHarness({ backend }); t.after(() => harness.dispose()); await harness.flush();
  assert.match(harness.joined(), /已保存配置（路由尚未生效）/);
  assert.doesNotMatch(harness.joined(), /生效值：/);
  assert.match(harness.joined(), /恢复默认并启用/);
});

test('停用的模型仍可编辑参数，且参数负载不改动启用状态', async () => {
  const harness = createHarness();
  await harness.flush();
  await harness.toggle(harness.byLabel('input', '启用模型 doubao-seed-2-1-pro-260915'), false);
  // 停用后仍能打开参数编辑器。
  await harness.clicks(harness.byLabel('button', '模型参数 doubao-seed-2-1-pro-260915'));
  await harness.change(harness.byLabel('input', '最大输出 token maxTokens'), '4096');
  await harness.clicks(harness.find(harness.tree, (node) => node.type === 'button' && String(node.props.children) === '保存参数')[0]);

  const call = harness.backend.calls.find((item) => item.op === 'saveModelSettings');
  assert.ok(call, '未发起 saveModelSettings');
  assert.deepEqual(call.settings, { maxTokens: 4096 });
  // 参数负载不得夹带启用状态：后端会保留模型原有的停用状态与参数。
  assert.ok(!Object.hasOwn(call.settings, 'enabled'));
  // 重新启用时也不清参数。
  await harness.toggle(harness.byLabel('input', '启用模型 doubao-seed-2-1-pro-260915'), true);
  const enableCall = harness.backend.calls.filter((item) => item.op === 'setModelEnabled').pop();
  assert.equal(enableCall.enabled, true);
  assert.ok(!Object.hasOwn(enableCall, 'settings'), '模型开关不应携带参数负载');
  assert.deepEqual(harness.backend.modelSettings['default:agent-plan:doubao-seed-2-1-pro-260915'], { maxTokens: 4096 });
  harness.dispose();
});
