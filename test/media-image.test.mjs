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
const { createAttachmentIndex } = await import('../src/attachment-index.mjs');

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
  const reads = [];
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
    async readImage(ref) {
      reads.push(ref);
      // 模拟真实存储：引用必须自带 mediaType/width/height，否则按损坏拒绝。
      if (!ref.mediaType || !Number.isSafeInteger(ref.width) || !Number.isSafeInteger(ref.height)
        || !Number.isSafeInteger(ref.bytes)) {
        const error = new Error('Stored attachment metadata does not match its reference.');
        error.code = 'ATTACHMENT_CORRUPT';
        throw error;
      }
      return { ref, data: PNG, mediaType: 'image/png' };
    },
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
  return { definition, options, requests, files, previews, reads };
}

const EXEC = { signal: new AbortController().signal, agent: { session: { header: {} } } };
const SESSION_EXEC = { signal: EXEC.signal, agent: { session: { id: 'session-1', header: {} } } };
const SESSION_IMAGE = {
  attachmentId: `sha256:${'c'.repeat(64)}`, mediaType: 'image/png',
  bytes: PNG.byteLength, width: 2, height: 2, name: 'upload.png'
};

function sessionIndex(ref = SESSION_IMAGE, sessionId = 'session-1') {
  const index = createAttachmentIndex();
  index.observeRequest({ sessionId, messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] }] });
  return index;
}

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

test('session-latest 自动补全本会话最近图片的读取参数', async t => {
  const { definition, options, requests, reads } = fixture(t);
  options.attachmentIndex = sessionIndex();
  await definition.execute({ prompt: '改成水彩画风', image: 'session-latest' }, SESSION_EXEC);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].attachmentId, SESSION_IMAGE.attachmentId);
  assert.equal(reads[0].bytes, SESSION_IMAGE.bytes);
  assert.match(requests[0].image, /^data:image\/png;base64,/u);
});

test('直接复制 Core 图片 handle 或裸 sha256 也能作为参考图', async t => {
  const { definition, options, requests, reads } = fixture(t);
  options.attachmentIndex = sessionIndex();
  const handle = `Image "upload.png" (${SESSION_IMAGE.attachmentId}); request preview 2x2px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.`;
  await definition.execute({ prompt: '按这张图生成 2K 版本', image: handle }, SESSION_EXEC);
  assert.equal(reads.length, 1);
  assert.match(requests[0].image, /^data:image\/png;base64,/u);
  await definition.execute({ prompt: '再来一张', image: `attachmentId=${SESSION_IMAGE.attachmentId}` }, SESSION_EXEC);
  assert.equal(reads.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(typeof requests[1].image, 'string');
});

test('索引缺失时给出可操作的附件引用错误', async t => {
  const { definition, options } = fixture(t);
  options.attachmentIndex = createAttachmentIndex();
  await assert.rejects(
    definition.execute({ prompt: '改图', image: `sha256:${'d'.repeat(64)}` }, SESSION_EXEC),
    /不在本次会话图片索引中/
  );
  await assert.rejects(
    definition.execute({ prompt: '改图', image: 'session-latest' }, SESSION_EXEC),
    /本会话最近没有可用图片/
  );
});

test('结果文本给出可再次编辑的完整附件引用', async t => {
  const { definition, options, requests, reads } = fixture(t);
  const value = await definition.execute({ prompt: '生成测试图' }, EXEC);
  const line = value.text.split('会话图片 1')[1] ?? '';
  const matched = /attachment=(\{[^}]*\})/u.exec(line);
  assert.ok(matched, '结果文本必须包含可直接复制的 attachment JSON');
  const copied = JSON.parse(matched[1]);
  assert.equal(copied.attachmentId, PREVIEW_ID);
  assert.equal(copied.mediaType, 'image/jpeg');
  // 不需要会话索引：完整引用本身就能再次读取。
  const noIndexOptions = { ...options, attachmentIndex: undefined };
  const second = toolDefinition(noIndexOptions);
  await second.execute({ prompt: '在此基础上改成夜景', image: `attachment=${matched[1]}` }, EXEC);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].attachmentId, PREVIEW_ID);
  assert.equal(requests.length, 2);
});

test('结果文本区分会话图片引用与文件附件，避免照抄文件引用失败', async t => {
  const { definition } = fixture(t);
  const value = await definition.execute({ prompt: '生成测试图' }, EXEC);
  assert.match(value.text, /会话图片 1（再次编辑时可直接作为 image 参数）/u);
  assert.match(value.text, /Original image\/png file（文件附件，仅用于取原图字节，不能作为 image 参考图）/u);
  assert.match(value.text, /“会话图片”行的 attachment= JSON 可原样传回/u);
  // 文件附件 JSON 不能当参考图：必须给出可操作错误，而不是静默成功。
  const fileRef = value.originals[0].attachment;
  await assert.rejects(
    definition.execute({ prompt: '改图', image: `attachment=${JSON.stringify(fileRef)}` }, SESSION_EXEC),
    /读取失败|不在本次会话图片索引中/
  );
});

test('会话标识缺失时 session-latest 明确报错，不回退到全局最近一张', async t => {
  const { definition, options } = fixture(t);
  options.attachmentIndex = sessionIndex();
  // EXEC 没有 agent.session.id：不得返回上一个会话的图。
  await assert.rejects(
    definition.execute({ prompt: '改图', image: 'session-latest' }, EXEC),
    /本会话最近没有可用图片/
  );
});

test('附件对象被清理或损坏时给出可操作中文提示', async t => {
  const { definition, options } = fixture(t);
  options.attachmentIndex = sessionIndex();
  const attachments = options.resolveAttachments();
  attachments.readImage = async () => {
    const error = new Error('Attachment object is missing.');
    error.code = 'ATTACHMENT_NOT_FOUND';
    throw error;
  };
  await assert.rejects(
    definition.execute({ prompt: '改图', image: 'session-latest' }, SESSION_EXEC),
    /读取失败：该图片已被清理或不在存储中/u
  );
  attachments.readImage = async () => {
    const error = new Error('Stored attachment failed integrity verification.');
    error.code = 'ATTACHMENT_CORRUPT';
    throw error;
  };
  await assert.rejects(
    definition.execute({ prompt: '改图', image: 'session-latest' }, SESSION_EXEC),
    /读取失败：图片存储不可用或内容已损坏/u
  );
});

test('session-latest 取本会话最新一张，同会话两图时用后一张', async t => {
  const { definition, options, reads } = fixture(t);
  const older = { ...SESSION_IMAGE, attachmentId: `sha256:${'e'.repeat(64)}`, name: 'older.png' };
  const index = createAttachmentIndex();
  index.observeRequest({ sessionId: 'session-1', messages: [{ role: 'user', content: [{ type: 'image', attachment: older }] }] });
  index.observeRequest({ sessionId: 'session-1', messages: [{ role: 'user', content: [{ type: 'image', attachment: SESSION_IMAGE }] }] });
  options.attachmentIndex = index;
  await definition.execute({ prompt: '改最新那张', image: 'session-latest' }, SESSION_EXEC);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].attachmentId, SESSION_IMAGE.attachmentId);
});
