// 图片工具请求、原图保存与格式一致性测试；所有 HTTP 与附件服务均为内存替身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// peer 依赖只由真实宿主提供；本测试注入与 defineTool 相同的定义透传契约。
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      const source = 'export function defineTool(value) { return value; }';
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return next(specifier, context);
  }
});
const { registerVolcImagineTool } = await import('../src/media-image.mjs');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const FILE_ID = `sha256:${'a'.repeat(64)}`;
const PREVIEW_ID = `sha256:${'b'.repeat(64)}`;

function toolDefinition(options) {
  let definition;
  const ctx = { tools: { register(tool) { definition = tool; return () => {}; } } };
  registerVolcImagineTool(ctx, options);
  return definition;
}

function fixture(t, responseBytes = PNG) {
  const requests = [];
  const files = [];
  const previews = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const text = String(url);
    if (text.includes('/images/generations')) {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ model: requests.at(-1).model, created: 1, data: [{ url: 'https://tos.volces.com/result' }] }), { status: 200 });
    }
    assert.equal(text, 'https://tos.volces.com/result');
    return new Response(responseBytes, { status: 200 });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const attachments = {
    async saveImage(input) {
      previews.push(input);
      // 模拟当前宿主：不透明图片规范化成 JPEG，不能改变原文件附件。
      return { attachmentId: PREVIEW_ID, mediaType: 'image/jpeg', bytes: 9, width: 2, height: 3, name: input.name };
    },
    async saveFile(input) {
      files.push(input);
      return { attachmentId: FILE_ID, name: input.name, bytes: input.data.byteLength };
    }
  };
  const options = {
    enabled: () => true, credentials: async () => ({ key: 'fixture-key' }),
    defaultModel: () => 'doubao-seedream-5.5', resolveAttachments: () => attachments
  };
  const definition = toolDefinition(options);
  return { definition, options, requests, files, previews };
}

const EXEC = { signal: new AbortController().signal, agent: { session: { header: {} } } };

test('默认模型进入请求，PNG 原图逐字节保存且预览可独立规范化', async t => {
  const { definition, options, requests, files, previews } = fixture(t);
  const value = await definition.execute({ prompt: '生成测试图', output_format: 'png' }, EXEC);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'doubao-seedream-5.5');
  assert.equal(requests[0].output_format, 'png');
  assert.equal(requests[0].response_format, 'url');
  assert.equal(previews[0].mediaType, 'image/png');
  assert.deepEqual(files[0].data, PNG);
  assert.match(files[0].name, /\.png$/u);
  assert.equal(value.images[0].mediaType, 'image/jpeg');
  assert.equal(value.originals[0].mediaType, 'image/png');
  assert.deepEqual(value.originals[0].attachment, { attachmentId: FILE_ID, name: files[0].name, bytes: PNG.byteLength });
  assert.equal(value.originals[0].width, 2);
  const content = definition.presentResult({ prompt: '生成测试图' }, { meta: value }).content;
  assert.deepEqual(content.map(part => part.type), ['image', 'file']);
  assert.equal(content[1].attachment.attachmentId, FILE_ID);
});

test('上游实际格式与 output_format 不符时明确失败且不保存错误文件', async t => {
  const { definition, options, files, previews } = fixture(t, JPEG);
  await assert.rejects(
    definition.execute({ prompt: '生成测试图', output_format: 'png' }, EXEC),
    /实际返回 image\/jpeg.*output_format=png/u
  );
  assert.equal(files.length, 0);
  assert.equal(previews.length, 0);
});

test('JPEG 请求保留 JPEG 原图，不改写为 PNG', async t => {
  const { definition, options, requests, files } = fixture(t, JPEG);
  const value = await definition.execute({ prompt: '生成测试图', output_format: 'jpeg' }, EXEC);
  assert.equal(requests[0].output_format, 'jpeg');
  assert.match(files[0].name, /\.jpg$/u);
  assert.equal(value.originals[0].mediaType, 'image/jpeg');
  assert.deepEqual(files[0].data, JPEG);
});

test('缺少原文件存储能力时在网络请求前失败', async () => {
  const definition = toolDefinition({
    enabled: () => true, credentials: async () => ({ key: 'unused' }),
    resolveAttachments: () => ({ saveImage: async () => ({}) })
  });
  await assert.rejects(definition.execute({ prompt: '生成测试图' }, EXEC), (error) => {
    assert.match(error.message, /原图与预览分开保存/);
    return true;
  },);
});
