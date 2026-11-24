// 媒体共享模块与 setMedia 操作的隔离测试：node --test test/media.test.mjs
// 不发起任何真实网络请求；涉及本地文件的用例全部写在 mkdtemp 临时目录里。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	defaultMediaState, normalizeMediaState, mediaToolEnabled, assertMediaEnabled,
	redactSecrets, sniffMediaType, mediaExtensionFor, parseAttachmentSpec, isHttpUrl,
	resolveImageSources, arkFetchJson, downloadMediaChunks, ArkApiError,
	MEDIA_TOOL_KEYS, DEFAULT_IMAGE_MODEL, SUPPORTED_IMAGE_MODELS
} from '../src/media.mjs';
import { isTrustedRequest } from '../src/media-image-route.mjs';
import { ArkController } from '../src/manager.mjs';
import { revision } from '../src/state.mjs';

const dirs = [];
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-volc-media-'));
	dirs.push(dir);
	return dir;
}
after(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// ── normalizeMediaState / mediaToolEnabled ─────────────────────────────────

test('默认媒体状态全部关闭', () => {
	assert.deepEqual(defaultMediaState(), { riskAcknowledged: false, imageTool: false, imageModel: DEFAULT_IMAGE_MODEL });
	assert.deepEqual(normalizeMediaState(undefined), defaultMediaState());
	assert.deepEqual(normalizeMediaState('junk'), defaultMediaState());
});

test('normalizeMediaState 丢弃未知字段并要求已知字段为布尔', () => {
	assert.deepEqual(
		normalizeMediaState({ riskAcknowledged: true, imageTool: true, videoTool: false, extra: 'x' }),
		{ riskAcknowledged: true, imageTool: true, imageModel: DEFAULT_IMAGE_MODEL }
	);
	assert.throws(() => normalizeMediaState({ imageTool: 'yes' }), /布尔/);
	assert.throws(() => normalizeMediaState({ riskAcknowledged: 1 }), /布尔/);
});

test('撤销风险确认会强制关闭所有媒体工具开关', () => {
	const normalized = normalizeMediaState({ riskAcknowledged: false, imageTool: true, videoTool: true });
	assert.deepEqual(normalized, { riskAcknowledged: false, imageTool: false, imageModel: DEFAULT_IMAGE_MODEL });
});

test('图片模型目录与默认选择持久化，旧视频字段被丢弃', () => {
	assert.deepEqual(SUPPORTED_IMAGE_MODELS, ['doubao-seedream-5-0-pro', 'doubao-seedream-5.5', 'doubao-seedream-5.0-flash']);
	assert.deepEqual(normalizeMediaState({ riskAcknowledged: true, imageModel: 'doubao-seedream-5.5', videoTool: true }),
		{ riskAcknowledged: true, imageTool: false, imageModel: 'doubao-seedream-5.5' });
	assert.throws(() => normalizeMediaState({ imageModel: 'doubao-seedream-5-5-261028' }), /默认图片模型/);
});

test('mediaToolEnabled 必须同时确认风险并打开开关', () => {
	for (const key of MEDIA_TOOL_KEYS) {
		assert.equal(mediaToolEnabled({ riskAcknowledged: true, imageTool: true, videoTool: true }, key), true);
		assert.equal(mediaToolEnabled({ riskAcknowledged: false, imageTool: true, videoTool: true }, key), false);
		assert.equal(mediaToolEnabled({ riskAcknowledged: true, imageTool: false, videoTool: false }, key), false);
	}
	assert.equal(mediaToolEnabled(undefined, 'imageTool'), false);
});

test('assertMediaEnabled 的错误提示指向设置页风险确认', () => {
	assert.throws(() => assertMediaEnabled(() => false, 'volc_imagine'), /图片生成.*开启图片工具/);
	assertMediaEnabled(() => true, 'volc_imagine');
});

// ── redactSecrets ───────────────────────────────────────────────────────────

test('redactSecrets 遮蔽 Bearer 凭据与签名查询参数', () => {
	const raw = 'GET https://x.volces.com/v.mp4?X-Tos-Signature=abcdef123456&Expires=1 failed: Bearer SECRET-TOKEN-9';
	const redacted = redactSecrets(raw);
	assert.ok(!redacted.includes('SECRET-TOKEN-9'));
	assert.ok(!redacted.includes('abcdef123456'));
	assert.match(redacted, /Bearer \*\*\*/);
	assert.match(redacted, /X-Tos-Signature=\*\*\*/);
});

// ── sniffMediaType / mediaExtensionFor ──────────────────────────────────────

test('sniffMediaType 识别方舟接受的图片格式', () => {
	assert.equal(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
	assert.equal(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
	assert.equal(sniffMediaType(new TextEncoder().encode('GIF89a...')), 'image/gif');
	assert.equal(sniffMediaType(new TextEncoder().encode('RIFFxxxxWEBP')), 'image/webp');
	assert.equal(sniffMediaType(new TextEncoder().encode('BM..')), 'image/bmp');
	assert.equal(sniffMediaType(new Uint8Array([0x49, 0x49, 0x2a, 0x00])), 'image/tiff');
	assert.equal(sniffMediaType(new TextEncoder().encode('plain text')), undefined);
});

test('mediaExtensionFor 为已知图片类型返回扩展名，未知退化为 bin', () => {
	assert.equal(mediaExtensionFor('image/png'), 'png');
	assert.equal(mediaExtensionFor('video/mp4'), 'bin');
	assert.equal(mediaExtensionFor('application/pdf'), 'bin');
});

// ── parseAttachmentSpec / isHttpUrl / stableId ──────────────────────────────

test('parseAttachmentSpec 接受裸 id、attachmentId= 与 attachment=JSON 三种形态', () => {
	const id = 'sha256:' + 'a'.repeat(64);
	assert.equal(parseAttachmentSpec(id)?.attachmentId, id);
	assert.equal(parseAttachmentSpec(`attachmentId=${id}`)?.attachmentId, id);
	const json = parseAttachmentSpec(`attachment={"attachmentId":"${id}","mediaType":"image/png"}`);
	assert.equal(json?.attachmentId, id);
	assert.equal(json?.ref?.mediaType, 'image/png');
	assert.equal(parseAttachmentSpec('not an attachment'), undefined);
	assert.equal(parseAttachmentSpec('sha256:' + 'x'.repeat(64)), undefined);
});

test('parseAttachmentSpec 识别 Core 注入的图片 handle、短摘要与多 ID 歧义', () => {
	const id = 'sha256:' + 'a'.repeat(64);
	const handle = `Image "shot.png" (${id}); request preview 1024x768px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.`;
	assert.equal(parseAttachmentSpec(handle)?.attachmentId, id);
	const normalized = `Image "x.png" (${id}); request preview 10x10px. Normalized copy (read-only; may be resized or re-encoded): "/objects/aa/x.png" (10x10px, image/png).`;
	assert.equal(parseAttachmentSpec(normalized)?.attachmentId, id);
	const short = parseAttachmentSpec(`[image omitted because this model accepts text only; attachment ${'sha256:' + 'a'.repeat(8)}]`);
	assert.equal(short?.shortId, 'sha256:' + 'a'.repeat(8));
	const two = parseAttachmentSpec(`${id} 和 sha256:${'b'.repeat(64)}`);
	assert.deepEqual(two?.ambiguous, [id, `sha256:${'b'.repeat(64)}`]);
});

test('isHttpUrl 只接受 http/https 前缀', () => {
	assert.equal(isHttpUrl('https://ark.volces.com/x.png'), true);
	assert.equal(isHttpUrl(' http://x.y/z '), true);
	assert.equal(isHttpUrl('data:image/png;base64,AA'), false);
	assert.equal(isHttpUrl('/tmp/a.png'), false);
});

// ── 端点与下载白名单（不发请求） ───────────────────────────────────────────

test('arkFetchJson 只放行方舟媒体端点', async () => {
	await assert.rejects(arkFetchJson('https://evil.example.com/x'), /不在方舟白名单/);
	await assert.rejects(arkFetchJson('http://ark.cn-beijing.volces.com/x'), /不在方舟白名单/);
});

test('downloadMediaChunks 拒绝非 HTTPS 与非白名单下载地址', async () => {
	await assert.rejects(downloadMediaChunks('http://tos.volces.com/x.mp4'), /HTTPS/);
	await assert.rejects(downloadMediaChunks('https://attacker.example.com/x.mp4'), /白名单/);
});

// ── resolveImageSources ────────────────────────────────────────────────────

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('resolveImageSources 透传 https URL、拒绝 http URL', async () => {
	const out = await resolveImageSources(['https://tos.volces.com/a.png']);
	assert.deepEqual(out, [{ url: 'https://tos.volces.com/a.png', origin: 'url' }]);
	await assert.rejects(resolveImageSources(['http://tos.volces.com/a.png']), /HTTPS/);
});

test('resolveImageSources 校验 data URI 声明与实际格式一致', async () => {
	const uri = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
	const [resolved] = await resolveImageSources([uri]);
	assert.equal(resolved.origin, 'data-uri');
	assert.equal(resolved.mediaType, 'image/png');
	await assert.rejects(
		resolveImageSources([`data:image/jpeg;base64,${Buffer.from(PNG).toString('base64')}`]),
		/不一致/
	);
	await assert.rejects(resolveImageSources(['data:text/plain;base64,AA==']), /不是可识别/);
});

test('resolveImageSources 把本地图片编码为 data URI，拒绝非图片', async () => {
	const dir = await tempDir();
	await writeFile(join(dir, 'ok.png'), PNG);
	await writeFile(join(dir, 'bad.txt'), 'not an image');
	const [resolved] = await resolveImageSources(['ok.png'], { cwd: dir });
	assert.equal(resolved.origin, 'file');
	assert.match(resolved.url, /^data:image\/png;base64,/u);
	await assert.rejects(resolveImageSources(['bad.txt'], { cwd: dir }), /不是方舟支持的图片格式/);
	await assert.rejects(resolveImageSources(['missing.png'], { cwd: dir }), /无法读取/);
});

test('resolveImageSources 限制参考图数量', async () => {
	const specs = Array.from({ length: 11 }, (_, index) => `https://tos.volces.com/${index}.png`);
	await assert.rejects(resolveImageSources(specs, { maxSources: 10 }), /参考图过多/);
});

test('resolveImageSources 用会话索引补全仅含 sha256 或短摘要的引用', async () => {
	const id = 'sha256:' + 'a'.repeat(64);
	const ref = { attachmentId: id, mediaType: 'image/png', bytes: PNG.byteLength, width: 2, height: 2 };
	const resolveAttachment = async spec => (spec.attachmentId === id || spec.shortId
		? { ref, bytes: PNG, mediaType: 'image/png' }
		: undefined);
	const [handle] = await resolveImageSources([`Image "a.png" (${id}); request preview 2x2px.`], { resolveAttachment });
	assert.equal(handle.origin, 'attachment');
	assert.equal(handle.attachmentId, id);
	assert.match(handle.url, /^data:image\/png;base64,/u);
	const [short] = await resolveImageSources([`sha256:${'a'.repeat(8)}`], { resolveAttachment });
	assert.equal(short.attachmentId, id);
});

test('resolveImageSources 的 session-latest 取会话最近图片，缺失时明确报错', async () => {
	const id = 'sha256:' + 'b'.repeat(64);
	const ref = { attachmentId: id, mediaType: 'image/png', bytes: PNG.byteLength, width: 2, height: 2 };
	const [resolved] = await resolveImageSources(['session-latest'], {
		latestAttachment: async () => ref,
		resolveAttachment: async () => ({ ref, bytes: PNG, mediaType: 'image/png' })
	});
	assert.equal(resolved.attachmentId, id);
	await assert.rejects(resolveImageSources(['session-latest'], {}), /最近没有可用图片/);
	await assert.rejects(resolveImageSources(['latest'], {}), /最近没有可用图片/);
});

test('resolveImageSources 去重同一附件并报告多 ID 歧义', async () => {
	const id = 'sha256:' + 'a'.repeat(64);
	const ref = { attachmentId: id, mediaType: 'image/png', bytes: PNG.byteLength, width: 2, height: 2 };
	const out = await resolveImageSources([id, `attachmentId=${id}`], {
		resolveAttachment: async () => ({ ref, bytes: PNG, mediaType: 'image/png' })
	});
	assert.equal(out.length, 1);
	await assert.rejects(
		resolveImageSources([`${id} ${'sha256:' + 'b'.repeat(64)}`], {}),
		/包含多个附件 ID/
	);
});

test('resolveImageSources 在索引未命中时给出可操作错误', async () => {
	const id = 'sha256:' + 'a'.repeat(64);
	await assert.rejects(
		resolveImageSources([id], { resolveAttachment: async () => undefined }),
		/无法读取|附件服务/
	);
	await assert.rejects(
		resolveImageSources([`sha256:${'a'.repeat(8)}`], { resolveAttachment: async () => undefined }),
		/短摘要 .* 无法定位/
	);
});

// ── isTrustedRequest（视频文件路由） ───────────────────────────────────────

const LOOPBACK = '127.0.0.1';

test('isTrustedRequest 只放行回环地址', () => {
	assert.equal(isTrustedRequest('192.168.1.5', { host: '127.0.0.1:65515' }, 'GET'), false);
	assert.equal(isTrustedRequest('::ffff:10.0.0.2', { host: '127.0.0.1' }, 'GET'), false);
	assert.equal(isTrustedRequest('::1', { host: 'localhost' }, 'GET'), true);
	assert.equal(isTrustedRequest('::ffff:127.0.0.1', { host: '127.0.0.1' }, 'GET'), true);
});

test('isTrustedRequest 要求回环 Host 以阻断 DNS rebinding', () => {
	assert.equal(isTrustedRequest(LOOPBACK, { host: 'evil.example.com' }, 'GET'), false);
	assert.equal(isTrustedRequest(LOOPBACK, {}, 'GET'), false);
});

test('isTrustedRequest 阻断跨站请求与跨站 Origin', () => {
	assert.equal(isTrustedRequest(LOOPBACK, { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' }, 'GET'), false);
	assert.equal(isTrustedRequest(LOOPBACK, { host: '127.0.0.1:65515', origin: 'https://evil.example.com' }, 'GET'), false);
});

test('isTrustedRequest 放行宿主 Origin、无 Origin 的 GET 与同源 Origin', () => {
	assert.equal(isTrustedRequest(LOOPBACK, { host: '127.0.0.1:65515', origin: 'dsh-app://app' }, 'GET'), true);
	assert.equal(isTrustedRequest(LOOPBACK, { host: '127.0.0.1:65515' }, 'GET'), true);
	assert.equal(isTrustedRequest(LOOPBACK, { host: '127.0.0.1:65515', origin: 'http://127.0.0.1:65515' }, 'GET'), true);
});

// ── setMedia 操作（ArkController） ─────────────────────────────────────────

async function mediaController() {
	const dir = await tempDir();
	const controller = new ArkController({
		statePath: join(dir, 'state.json'),
		arkCliPath: '',
		resolveRef: async () => undefined,
		cliFactory: () => { throw new Error('不应调用 CLI'); },
		fetchImpl: async () => { throw new Error('不应发起请求'); },
		spawnImpl: () => { throw new Error('不应拉起进程'); }
	});
	await controller.store.load();
	return controller;
}

test('setMedia 只覆盖传入字段并返回归一化媒体状态', async () => {
	const controller = await mediaController();
	const rev = () => revision(controller.store.current);
	let snapshot = await controller.change({ op: 'setMedia', revision: rev(), riskAcknowledged: true });
	assert.deepEqual(snapshot.media, { riskAcknowledged: true, imageTool: false, imageModel: DEFAULT_IMAGE_MODEL });
	snapshot = await controller.change({ op: 'setMedia', revision: rev(), imageTool: true });
	assert.deepEqual(snapshot.media, { riskAcknowledged: true, imageTool: true, imageModel: DEFAULT_IMAGE_MODEL });
	snapshot = await controller.change({ op: 'setMedia', revision: rev(), imageModel: 'doubao-seedream-5.5' });
	assert.deepEqual(snapshot.media, { riskAcknowledged: true, imageTool: true, imageModel: 'doubao-seedream-5.5' });
	controller.dispose();
});

test('setMedia 撤销风险确认会同时关闭已打开的工具开关', async () => {
	const controller = await mediaController();
	const rev = () => revision(controller.store.current);
	await controller.change({ op: 'setMedia', revision: rev(), riskAcknowledged: true, imageTool: true, videoTool: true });
	const snapshot = await controller.change({ op: 'setMedia', revision: rev(), riskAcknowledged: false });
	assert.deepEqual(snapshot.media, { riskAcknowledged: false, imageTool: false, imageModel: DEFAULT_IMAGE_MODEL });
	assert.equal(controller.mediaEnabled('imageTool'), false);
	controller.dispose();
});

test('setMedia 在 revision 过期时拒绝写入', async () => {
	const controller = await mediaController();
	await controller.change({ op: 'setMedia', revision: revision(controller.store.current), riskAcknowledged: true });
	await assert.rejects(
		controller.change({ op: 'setMedia', revision: 'stale-rev', imageTool: true }),
		/设置已改变/
	);
	controller.dispose();
});
