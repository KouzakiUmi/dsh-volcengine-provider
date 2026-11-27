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
const RGBA = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPwd3v6HwAE3AJ6zM4FjgAAAABJRU5ErkJggg==', 'base64'));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const FILE_ID = `sha256:${'a'.repeat(64)}`;
const PREVIEW_ID = `sha256:${'b'.repeat(64)}`;

function toolDefinition(options) {
  let definition;
  const ctx = { tools: { register(tool) { definition = tool; return () => {}; } } };
  registerVolcImagineTool(ctx, options);
  return definition;
}

function fixture(t, responseBytes = PNG, entries) {
  const requests = [];
  const files = [];
  const previews = [];
  const reads = [];
  const downloads = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const text = String(url);
    if (text.includes('/images/generations')) {
      requests.push(JSON.parse(init.body));
      assert.equal(text, 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations');
      return Response.json({ model: requests.at(-1).model, created: 1, data: entries ?? [{ url: 'https://tos.volces.com/result' }] });
    }
    assert.equal(new URL(text).hostname, 'tos.volces.com');
    downloads.push(text);
    return new Response(typeof responseBytes === 'function' ? responseBytes(text) : responseBytes, { status: 200 });
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
  return { definition, options, requests, files, previews, reads, downloads };
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

const sourceUrl = 'https://tos.volces.com/source.png';
const layerArgs = { layer_decomposition: true, image: sourceUrl };
const layerEntry = z => ({ z_index: z, size: z === 0 ? '2048x1536' : '1024x768', url: `https://tos.volces.com/result-${z}?X-Tos-Signature=fixture-signature`,
  ...(z > 0 ? { name: `元素 ${z}`, description: '拆出的独立元素', bounding_box: { absolute: [20, 40, 220, 440], normalized: [10, 26, 107, 286] } } : {}) });

test('5.5 文生和多参考图生 RGBA 原图保留 Alpha 与完整字节', async t => {
  const { definition, requests, files } = fixture(t, RGBA, [{ url: 'https://tos.volces.com/result', background: 'transparent' }]);
  const args = { prompt: '提取透明素材', background: 'transparent' };
  const value = await definition.execute(args, EXEC);
  await definition.execute({ ...args, images: [sourceUrl, `${sourceUrl}?second`] }, EXEC);
  assert.equal(requests[0].background, 'transparent');
  assert.equal(requests[0].output_format, 'png');
  assert.equal('image' in requests[0], false);
  assert.deepEqual(requests[1].image, [sourceUrl, `${sourceUrl}?second`]);
  assert.equal(value.originals[0].background, 'transparent');
  assert.ok(files.every(file => Buffer.from(file.data).equals(RGBA)));
});

test('5.5 拆分 100 张时完整保存，按顺序返回 JPEG 底图、PNG 图层与富文本 OCR', async t => {
  const entries = Array.from({ length: 100 }, (_, z) => layerEntry(z));
  const box = entries[5].bounding_box;
  const style = { similar_font_family: 'Helvetica Neue', foreground_color: '#193366', bold: true, italic: false, underline: false, strikethrough: true, shadow: false, translucent: false };
  const ocr = { text: '标题', lines: [{ bounding_box: box, runs: [{ text: '标题', style }] }] };
  entries[5].text_recognition = { ...ocr, url: 'https://tos.volces.com/?secret=fixture-signature' };
  const { definition, requests, files, downloads } = fixture(t, url => url.includes('/result-0?') ? JPEG : RGBA, entries.reverse());
  const value = await definition.execute({ ...layerArgs, output_format: 'jpeg', layer_decomposition_options: { max_images: 100, text_recognition: true } }, EXEC);
  assert.deepEqual(requests[0], { model: 'doubao-seedream-5.5', image: sourceUrl, layer_decomposition: true,
    layer_decomposition_options: { max_images: 100, text_recognition: true }, size: 'auto', output_format: 'jpeg', response_format: 'url', watermark: true });
  assert.equal(files.length, 100);
  assert.equal(downloads.length, 100);
  assert.deepEqual(files[0].data, JPEG);
  assert.deepEqual(files[99].data, RGBA);
  assert.match(files[0].name, /base\.jpg$/u);
  assert.match(files[99].name, /layer-99\.png$/u);
  assert.deepEqual(value.originals.map(item => item.z_index), Array.from({ length: 100 }, (_, z) => z));
  assert.equal(value.originals[0].width, 2048);
  assert.equal(value.images[0].width, 2);
  assert.deepEqual(value.originals[5].text_recognition, ocr);
  assert.deepEqual(value.originals[5].bounding_box, box);
  assert.doesNotMatch(JSON.stringify(value), /fixture-signature/u);
  const content = definition.output.render(layerArgs, value);
  assert.equal(content.filter(part => part.type === 'image').length, 1);
  assert.equal(content.filter(part => part.type === 'file').length, 100);
});

test('5.0 Pro / Flash 拆分可用，输出始终保留底图和透明上层', async t => {
  const { definition, requests } = fixture(t, RGBA, [layerEntry(0), layerEntry(1)]);
  for (const model of ['doubao-seedream-5-0-pro', 'doubao-seedream-5.0-flash']) {
    const value = await definition.execute({ ...layerArgs, model, size: '1.5K', prompt: '拆出文字' }, EXEC);
    assert.deepEqual(value.originals.map(item => item.z_index), [0, 1]);
    assert.equal(requests.at(-1).model, model);
    assert.equal(requests.at(-1).size, '1.5K');
    assert.equal('layer_decomposition_options' in requests.at(-1), false);
  }
});

test('旧模型仅允许单张带 Alpha 的 PNG 参考图生透明图', async t => {
  const { definition, requests } = fixture(t, RGBA);
  const args = { model: 'doubao-seedream-5-0-pro', prompt: '微调透明素材', background: 'transparent' };
  await assert.rejects(definition.execute(args, EXEC), /一张带透明通道的 PNG/u);
  await assert.rejects(definition.execute({ ...args, image: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` }, EXEC), /一张带透明通道的 PNG/u);
  await definition.execute({ ...args, image: `data:image/png;base64,${Buffer.from(RGBA).toString('base64')}` }, EXEC);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].background, 'transparent');
});

test('不合法的模式组合在付费请求前拦截', async t => {
  const { definition, requests, options } = fixture(t);
  options.credentials = () => assert.fail('错误参数不应解析凭据');
  for (const [args, expected] of [
    [{}, /prompt/u],
    [{ ...layerArgs, image: undefined }, /恰好一张/u],
    [{ ...layerArgs, images: [sourceUrl] }, /恰好一张/u],
    [{ ...layerArgs, image: 'data:image/gif;base64,R0lGODlh' }, /仅接受 PNG 或 JPEG/u],
    [{ ...layerArgs, size: '1024x1024' }, /图层拆分的 size/u],
    [{ ...layerArgs, background: 'auto' }, /不接受 background/u],
    [{ ...layerArgs, layer_decomposition_options: { max_images: 101 } }, /2–100/u],
    [{ ...layerArgs, layer_decomposition_options: { max_images: 2.5 } }, /2–100/u],
    [{ ...layerArgs, model: 'doubao-seedream-5.0-flash', layer_decomposition_options: { text_recognition: true } }, /仅用于 Seedream 5.5/u],
    [{ prompt: '测试', layer_decomposition_options: {} }, /仅用于 Seedream 5.5 图层拆分/u],
    [{ prompt: '测试', background: 'transparent', output_format: 'jpeg' }, /要求 output_format=png/u]
  ]) await assert.rejects(definition.execute(args, EXEC), expected);
  assert.equal(requests.length, 0);
});

test('图层缺项不返回部分成功，且在下载前识别错误', async t => {
  const { definition, files, downloads } = fixture(t, RGBA, [layerEntry(0), layerEntry(0)]);
  await assert.rejects(definition.execute(layerArgs, EXEC), /图层顺序缺失或重复/u);
  assert.equal(downloads.length, 0);
  assert.equal(files.length, 0);
});

test('无透明通道 PNG 不得作为透明图返回', async t => {
  const { definition, files } = fixture(t);
  await assert.rejects(definition.execute({ prompt: '测试', background: 'transparent' }, EXEC), /缺少 PNG 透明通道/u);
  assert.equal(files.length, 0);
});
