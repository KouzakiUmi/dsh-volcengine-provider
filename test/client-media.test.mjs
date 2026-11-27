// 图片工具卡片的隔离渲染测试：真实 Client 源码 + 最小 React 替身，不是浏览器截图测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClientBundleSyncFromDisk } from '../scripts/client-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function miniReact() {
  const instances = new Map();
  const effects = [];
  let current;
  let dirty = false;
  const depsChanged = (instance, index, deps) => !instance.deps[index] || !deps || deps.some((dep, i) => !Object.is(dep, instance.deps[index][i]));
  const instanceOf = path => {
    if (!instances.has(path)) instances.set(path, { state: [], refs: [], deps: [], callbacks: [], cleanups: [], index: 0 });
    return instances.get(path);
  };
  function useState(initial) {
    const instance = current;
    const index = instance.index++;
    if (!(index in instance.state)) instance.state[index] = typeof initial === 'function' ? initial() : initial;
    const set = value => {
      const next = typeof value === 'function' ? value(instance.state[index]) : value;
      if (!Object.is(next, instance.state[index])) { instance.state[index] = next; dirty = true; }
    };
    return [instance.state[index], set];
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
    if (typeof instance.cleanups[index] === 'function') instance.cleanups[index]();
    effects.push(() => { instance.cleanups[index] = fn(); });
  }
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } });
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
      try { output = element.type(element.props); } finally { current = previous; }
      return render(output, `${path}>`);
    }
    return { type: element.type, props: element.props, children: render(element.props.children, `${path}.c`) };
  }
  return {
    createElement, useState, useRef, useCallback, useEffect, render,
    flushEffects() { let guard = 0; while (effects.length && guard++ < 200) effects.shift()(); },
    isDirty: () => dirty,
    clearDirty() { dirty = false; },
    unmount() {
      for (const instance of instances.values()) for (const cleanup of instance.cleanups) if (typeof cleanup === 'function') cleanup();
      instances.clear(); effects.length = 0;
    }
  };
}

function createHarness() {
  const react = miniReact();
  let loaded;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec; } } };
  try { new Function(buildClientBundleSyncFromDisk(ROOT))(); } finally { globalThis.window = previousWindow; }
  const exported = loaded.factory(id => id === 'react' ? react : (() => { throw new Error(`unexpected require ${id}`); })());
  const registrations = [];
  const disposers = [];
  const service = { invoke: async () => ({ ok: true, value: {} }) };
  const ctx = {
    slots: {
      inject(_name, setup) { setup(); },
      register(spec, Component) { registrations.push({ spec, Component }); return () => {}; }
    },
    remote: { $mount: async () => () => {} },
    inject(_deps, callback) { callback({ remote: { volcengineProvider: service } }); },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup); },
    get() { return service; }
  };
  exported.apply(ctx);
  const registration = registrations.find(row => row.spec.name === 'tool.call.toolview' && row.spec.key === 'volc_imagine');
  assert.ok(registration, 'volc_imagine 专用卡片未注册');
  let tree;
  let props;
  const render = () => { tree = react.render({ type: registration.Component, props }, 'root'); };
  const flush = async () => {
    for (let index = 0; index < 16; index++) {
      react.clearDirty(); render(); react.flushEffects(); await tick();
      if (!react.isDirty()) break;
    }
  };
  const find = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const child of node) find(child, predicate, out); return out; }
    if (node.type && predicate(node)) out.push(node);
    find('children' in node ? node.children : node.props?.children, predicate, out);
    return out;
  };
  const texts = () => {
    const out = [];
    const walk = node => {
      if (node === null || node === undefined) return;
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type) walk('children' in node ? node.children : node.props?.children);
    };
    walk(tree); return out.join(' | ');
  };
  return {
    react, registrations,
    async mount(value) { props = value; await flush(); },
    find: predicate => find(tree, predicate),
    texts,
    get tree() { return tree; },
    dispose() { react.unmount(); for (const dispose of disposers) dispose(); }
  };
}

const originalRef = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'original.png', bytes: 11 };
const previewRef = { attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/jpeg', bytes: 9, width: 2, height: 3, name: 'preview.jpg' };
const originalBlock = {
  kind: 'tool-call', call: { name: 'volc_imagine', argsRaw: JSON.stringify({ prompt: '保留 PNG' }) },
  content: [{ type: 'text', text: 'Generated' }, { type: 'image', attachment: previewRef }, { type: 'file', attachment: originalRef }],
  meta: { model: 'doubao-seedream-5.5', images: [previewRef], originals: [{ attachment: originalRef, mediaType: 'image/png', width: 2, height: 3 }] }
};

test('原图卡片走原文件路由，支持大图、缩放和下载，不读取规范化预览', async () => {
  const harness = createHarness();
  let previewLoads = 0;
  await harness.mount({ owner: { phase: 'result', block: originalBlock, loadImage: async () => { previewLoads++; return 'blob:preview'; } } });
  const images = harness.find(node => node.type === 'img');
  assert.equal(images.length, 1);
  assert.match(images[0].props.src, /^\/plugins\/dsh-volcengine-provider\/image\/file\?/u);
  assert.match(images[0].props.src, /mediaType=image%2Fpng/u);
  assert.equal(previewLoads, 0);
  const download = harness.find(node => node.type === 'a' && node.props.download === 'original.png')[0];
  assert.ok(download);
  assert.match(download.props.href, /download=1/u);
  const open = harness.find(node => node.type === 'button' && node.props['aria-label'] === '查看大图：original.png')[0];
  open.props.onClick(); await harness.react.flushEffects();
  harness.react.clearDirty();
  await harness.mount({ owner: { phase: 'result', block: originalBlock, loadImage: async () => 'blob:preview' } });
  assert.equal(harness.find(node => node.type === 'dialog').length, 1);
  const zoom = harness.find(node => node.type === 'button' && node.props['aria-label'] === '放大')[0];
  zoom.props.onClick();
  await harness.mount({ owner: { phase: 'result', block: originalBlock, loadImage: async () => 'blob:preview' } });
  assert.match(harness.texts(), /150%/);
  harness.find(node => node.type === 'button' && node.props['aria-label'] === '关闭大图')[0].props.onClick();
  await harness.mount({ owner: { phase: 'result', block: originalBlock, loadImage: async () => 'blob:preview' } });
  assert.equal(harness.find(node => node.type === 'dialog').length, 0);
  harness.dispose();
});

test('旧会话结果通过 owner.loadImage 渲染', async () => {
  const harness = createHarness();
  const block = { ...originalBlock, meta: { model: 'doubao-seedream-5-0-pro', images: [previewRef] }, content: [{ type: 'image', attachment: previewRef }] };
  const calls = [];
  await harness.mount({ owner: { phase: 'result', block, loadImage: async ref => { calls.push(ref); return 'blob:preview'; } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].attachmentId, previewRef.attachmentId);
  assert.equal(harness.find(node => node.type === 'img')[0].props.src, 'blob:preview');
  harness.dispose();
});

test('旧版 sessions.readAttachment 的 Blob URL 在卸载时回收', async t => {
  const harness = createHarness();
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const revoked = [];
  URL.createObjectURL = () => 'blob:legacy';
  URL.revokeObjectURL = url => { revoked.push(url); };
  t.after(() => { URL.createObjectURL = previousCreate; URL.revokeObjectURL = previousRevoke; });
  const block = { ...originalBlock, meta: { images: [previewRef] }, content: [{ type: 'image', attachment: previewRef }] };
  const sessions = { binding: () => ({ session: { readAttachment: async id => ({ ok: true, value: { attachment: previewRef, data: new Uint8Array([1, 2]) } }) } }) };
  await harness.mount({ block, sessionId: 's1', sessions });
  assert.equal(harness.find(node => node.type === 'img')[0].props.src, 'blob:legacy');
  harness.dispose();
  assert.deepEqual(revoked, ['blob:legacy']);
});

test('原图加载失败显示重试入口，重试后恢复图片', async () => {
  const harness = createHarness();
  const props = { owner: { phase: 'result', block: originalBlock, loadImage: async () => 'blob:unused' } };
  await harness.mount(props);
  const image = harness.find(node => node.type === 'img')[0];
  image.props.onError();
  await harness.mount(props);
  assert.match(harness.texts(), /图片加载失败，点击重试/);
  const retry = harness.find(node => node.type === 'button' && String(node.props.children).includes('点击重试'))[0];
  retry.props.onClick();
  await harness.mount(props);
  assert.equal(harness.find(node => node.type === 'img').length, 1);
  harness.dispose();
});

test('损坏原图按位置回退到规范化预览并显示提示', async () => {
  const harness = createHarness();
  const secondPreview = { ...previewRef, attachmentId: `sha256:${'c'.repeat(64)}`, name: 'second.jpg' };
  const block = {
    ...originalBlock,
    content: [{ type: 'image', attachment: previewRef }, { type: 'image', attachment: secondPreview }],
    meta: { model: 'doubao-seedream-5.5', originals: [{ attachment: { attachmentId: '', name: '', bytes: 0 }, mediaType: 'image/png' }, { attachment: originalRef, mediaType: 'image/png', width: 2, height: 3 }] }
  };
  await harness.mount({ owner: { phase: 'result', block, loadImage: async () => 'blob:preview' } });
  assert.match(harness.texts(), /1 张原图不可用，已回退到会话预览/);
  assert.match(harness.texts(), /预览（规范化）/);
  assert.equal(harness.find(node => node.type === 'img').length, 2);
  harness.dispose();
});

test('生成中与失败状态保留明确反馈，不渲染空成功卡片', async () => {
  const pending = createHarness();
  await pending.mount({ owner: { phase: 'start', block: { call: { name: 'volc_imagine', argsRaw: JSON.stringify({ prompt: '等待中' }) } } } });
  assert.equal(pending.find(node => node.type === 'progress').length, 1);
  assert.match(pending.texts(), /正在生成图片/);
  pending.dispose();
  const failed = createHarness();
  await failed.mount({ owner: { phase: 'result', block: { kind: 'tool-call', isError: true, content: [{ type: 'text', text: '格式不一致' }] } } });
  assert.match(failed.texts(), /图片生成失败/);
  assert.match(failed.texts(), /格式不一致/);
  failed.dispose();
});

test('图层卡片分页、同内容不同图层不丢失，显示透明预览、坐标、OCR 和分别下载', async () => {
  const harness = createHarness();
  const originals = Array.from({ length: 11 }, (_, z_index) => ({
    ...originalBlock.meta.originals[0], z_index, name: `对象 ${z_index}`,
    attachment: { ...originalRef, name: z_index ? `layer-${z_index}.png` : 'base.jpg' },
    mediaType: z_index ? 'image/png' : 'image/jpeg',
    ...(z_index === 1 ? { bounding_box: { absolute: [1, 2, 3, 4] }, text_recognition: { text: '海报标题', lines: [] } } : {})
  }));
  const block = { ...originalBlock, meta: { ...originalBlock.meta, originals } };
  const props = { owner: { phase: 'result', block } };
  await harness.mount(props);
  assert.match(harness.texts(), /1 张底图 · 10 个图层/u);
  assert.match(harness.texts(), /图层 1 · 对象 1/u);
  assert.match(harness.texts(), /底图像素坐标：\[1, 2, 3, 4\]/u);
  assert.match(harness.texts(), /富文本 OCR.*海报标题/su);
  const images = harness.find(node => node.type === 'img');
  assert.equal(images.length, 8);
  assert.equal(images[0].props['data-transparent'], undefined);
  assert.equal(images[1].props['data-transparent'], true);
  const files = harness.find(node => node.type === 'a' && node.props.download);
  assert.equal(files.length, 8);
  assert.match(files[0].props.href, /mediaType=image%2Fjpeg.*download=1/u);
  assert.match(files[1].props.href, /name=layer-1\.png.*mediaType=image%2Fpng/u);
  harness.find(node => node.type === 'button' && node.props.children === '下一页')[0].props.onClick();
  await harness.mount(props);
  assert.match(harness.texts(), /第 2 \/ 2 页/u);
  assert.equal(harness.find(node => node.type === 'img').length, 3);
  assert.match(harness.texts(), /图层 10 · 对象 10/u);
  harness.dispose();
});
