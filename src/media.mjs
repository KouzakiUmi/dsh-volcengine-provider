// 图片生成的共享工具：方舟端点请求、参考素材解析与受控下载。
// 设置归一化与模型目录在浏览器安全的 media-config.mjs 中维护。
import { isAbsolute, resolve } from 'node:path';

export {
  MEDIA_TOOL_KEYS, SUPPORTED_IMAGE_MODELS, DEFAULT_IMAGE_MODEL,
  defaultMediaState, normalizeMediaState, mediaToolEnabled, assertMediaEnabled
} from './media-config.mjs';
export const ARK_MEDIA_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3';
export const ARK_MEDIA_HOST = 'ark.cn-beijing.volces.com';
export const MAX_JSON_RESPONSE_BYTES = 256 * 1024;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_IMAGE_RESULT_BYTES = 48 * 1024 * 1024;
export const MAX_SOURCE_IMAGES = 10;
// 方舟返回的图像/视频为 24 小时有效的预签名 GET 链接，域名归属火山引擎 TOS/CDN。
export const MEDIA_DOWNLOAD_HOST_SUFFIXES = ['.volces.com', '.volces.com.cn', '.volcdoc.com', '.volcengine.com'];
export const MAX_DOWNLOAD_REDIRECTS = 3;

export const BILLING_NOTE = '图片按官方 Agent Plan 额度计费并消耗套餐 AFP，提交即视为确认本次消耗。';

export class ArkApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function redactSecrets(text) {
  return String(text).replace(/Bearer\s+[^"'\\\s]+/giu, 'Bearer ***').replace(/[?&](X-Tos-Signature|Signature|token|access_key|sk|api_key|key)=[^&\s"']*/giu, '$1=***');
}

/** 读取 JSON 响应并限制体积；错误响应只暴露摘要，不携带响应头与凭证。 */
export async function arkFetchJson(url, { method = 'GET', apiKey, body, signal, timeoutMs = 120000, maxBytes = MAX_JSON_RESPONSE_BYTES } = {}) {
  const parsed = url instanceof URL ? url : new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== ARK_MEDIA_HOST) {
    throw new Error(`媒体请求目标不在方舟白名单内：${parsed.hostname}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('方舟媒体接口请求超时')), timeoutMs);
  const links = signal ? [signal, controller.signal] : [controller.signal];
  try {
    const response = await fetch(parsed, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.any(links)
    });
    const { data: bytes } = await collectMediaBytes(boundedBody(response, maxBytes, () => new ArkApiError('方舟媒体接口响应过大', response.status)));
    const text = new TextDecoder().decode(bytes);
    let data;
    try { data = text.length ? JSON.parse(text) : {}; }
    catch { throw new ArkApiError(`方舟媒体接口返回非 JSON 内容（HTTP ${response.status}）`, response.status); }
    if (!response.ok) {
      const detail = data?.error?.message ?? data?.message ?? data?.error?.code ?? '';
      throw new ArkApiError(`方舟媒体接口错误（HTTP ${response.status}）${detail ? `：${redactSecrets(detail).slice(0, 300)}` : ''}`, response.status);
    }
    return data;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ArkApiError) throw error;
    if (error?.name === 'AbortError') throw error;
    throw new ArkApiError(`方舟媒体接口请求失败：${redactSecrets(error?.message ?? error)}`);
  } finally { clearTimeout(timer); }
}

function allowedDownloadHost(hostname) {
  return MEDIA_DOWNLOAD_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

async function* boundedBody(response, maxBytes, tooLarge) {
  if (!response.body) return;
  let total = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) throw tooLarge();
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw tooLarge();
      yield chunk;
    }
  } finally { await response.body.cancel().catch(() => {}); }
}

function parseDownloadUrl(value, base) {
  try { return new URL(value, base); }
  catch { throw new Error('方舟返回无效的图片下载地址'); }
}

/**
 * 以流式字节块下载受白名单保护的远程媒体。签名 URL 只在本函数内存活，
 * 不进入状态、日志或工具输出。redirect 手动跟随且每跳重新校验主机。
 */
export async function downloadMediaChunks(signedUrl, { signal, timeoutMs = 300000, maxBytes = MAX_IMAGE_RESULT_BYTES, label = '图片' } = {}) {
  let current = parseDownloadUrl(signedUrl);
  const deadline = AbortSignal.timeout(timeoutMs);
  const downloadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
    if (current.protocol !== 'https:') throw new Error(`${label}下载地址必须是 HTTPS`);
    if (!allowedDownloadHost(current.hostname) || current.username || current.password || current.port) {
      throw new Error(`${label}下载地址不在火山引擎白名单内`);
    }
    let response;
    try {
      response = await fetch(current, { redirect: 'manual', signal: downloadSignal });
    } catch {
      signal?.throwIfAborted();
      throw new Error(deadline.aborted ? `${label}下载超时` : `${label}下载请求失败`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error(`${label}下载重定向缺少目标`);
      current = parseDownloadUrl(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${label}下载失败（HTTP ${response.status}）`);
    }
    const declared = Number(response.headers.get('content-length'));
    const tooLarge = new Error(`${label}超过 ${maxBytes} 字节上限`);
    const stream = (async function* () {
      try { yield* boundedBody(response, maxBytes, () => tooLarge); }
      catch (error) {
        signal?.throwIfAborted();
        if (deadline.aborted) throw new Error(`${label}下载超时`);
        if (error === tooLarge) throw error;
        throw new Error(`${label}下载过程中断`);
      }
    })();
    return { stream, bytes: declared > 0 ? declared : undefined };
  }
  throw new Error(`${label}下载重定向次数过多`);
}

export async function downloadMediaBytes(url, options = {}) {
  const { stream } = await downloadMediaChunks(url, options);
  return collectMediaBytes(stream);
}

async function collectMediaBytes(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) { chunks.push(chunk); total += chunk.byteLength; }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return { data, bytes: total };
}

// ---------- 参考素材解析 ----------

function prefixBytes(text) { return new TextEncoder().encode(text); }

export function sniffMediaType(bytes) {
  const png = [0x89, 0x50, 0x4e, 0x47], jpeg = [0xff, 0xd8, 0xff], gif = prefixBytes('GIF8'), webp = prefixBytes('RIFF');
  const bmp = prefixBytes('BM'), tiffLe = [0x49, 0x49, 0x2a, 0x00], tiffBe = [0x4d, 0x4d, 0x00, 0x2a];
  const match = (list) => list.every((value, index) => bytes[index] === value);
  if (bytes.length >= 8 && match(png)) return 'image/png';
  if (bytes.length >= 3 && match(jpeg)) return 'image/jpeg';
  if (bytes.length >= 4 && match(gif)) return 'image/gif';
  if (bytes.length >= 12 && match(webp) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 2 && match(bmp)) return 'image/bmp';
  if (bytes.length >= 4 && (match(tiffLe) || match(tiffBe))) return 'image/tiff';
  return undefined;
}

/** PNG 可通过 RGBA/灰度 Alpha 通道或 tRNS 块声明透明度；完整解码由附件服务校验。 */
export function pngHasAlpha(bytes) {
  if (bytes.length < 33 || sniffMediaType(bytes) !== 'image/png') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false; // IHDR
  if (bytes[25] === 4 || bytes[25] === 6) return true;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    if (offset + length + 12 > bytes.length || type === 0x49444154 || type === 0x49454e44) break; // IDAT / IEND
    if (type === 0x74524e53 && length > 0) return true; // tRNS
    offset += length + 12;
  }
  return false;
}

export function mediaExtensionFor(mediaType) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tif' }[mediaType] ?? 'bin';
}

const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/u;
const ATTACHMENT_ANY = /sha256:[a-f0-9]{8,64}/gu;
const ATTACHMENT_ID_LOOSE = /^sha256:[a-f0-9]{8,64}$/u;
// `auto` 在方舟语境里是控制台路由名，不作为“本会话最近一张”的别名，避免概念混淆。
const SESSION_LATEST = /^(?:session-latest|session|latest)$/iu;

function attachmentSpecOf(id) {
  return ATTACHMENT_ID.test(id) ? { attachmentId: id } : { shortId: id };
}

/**
 * 模型可给出 attachmentId=… / attachment={…json…} / 裸 sha256 id，或原样复制
 * Core 注入的 handle 文本（`Image "name" (sha256:…)`）。短摘要按内容前缀引用，
 * 由会话附件索引补全；同一文本里出现多个不同 ID 时报告歧义。
 */
export function parseAttachmentSpec(value) {
  const text = String(value).trim();
  const embedded = /attachment=(\{[^}]*\})/u.exec(text);
  if (embedded) {
    try {
      const parsed = JSON.parse(embedded[1]);
      if (typeof parsed?.attachmentId === 'string' && ATTACHMENT_ID_LOOSE.test(parsed.attachmentId)) {
        return { ...attachmentSpecOf(parsed.attachmentId), ref: parsed };
      }
    } catch { /* fall through to id matching */ }
  }
  const labeled = /attachmentId\s*=\s*((?:sha256:[a-f0-9]{8,64}))/u.exec(text);
  if (labeled) return attachmentSpecOf(labeled[1]);
  const ids = [...new Set([...text.matchAll(ATTACHMENT_ANY)].map(match => match[0]))];
  if (ids.length === 1) return attachmentSpecOf(ids[0]);
  if (ids.length > 1) return { ambiguous: ids };
  return undefined;
}

export function isHttpUrl(value) { return /^https?:\/\//iu.test(value.trim()); }

function decodeDataUri(trimmed, maxBytes) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/iu.exec(trimmed);
  if (!match) throw new Error('data URI 必须是 base64 编码的媒体内容');
  const declared = match[1].toLowerCase();
  const payload = match[2].replace(/\s+/gu, '');
  if (!/^[a-z0-9+/]*={0,2}$/iu.test(payload)) throw new Error('data URI 包含非法 base64 内容');
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.byteLength === 0) throw new Error('data URI 内容为空');
  if (bytes.byteLength > maxBytes) throw new Error(`data URI 为 ${bytes.byteLength} 字节，超过 ${maxBytes} 上限`);
  const sniffed = sniffMediaType(bytes);
  if (!sniffed) throw new Error('data URI 内容不是可识别的图片/媒体格式');
  if (sniffed !== declared) throw new Error(`data URI 声明的 ${declared} 与实际内容 ${sniffed} 不一致`);
  return { bytes, mediaType: sniffed };
}

/**
 * 读取一个会话图片附件。优先交给调用方注入的 resolveAttachment（会话索引 +
 * 附件服务），它能把仅含 sha256 的引用补全为完整 ImageAttachmentRef；没有注入或
 * 未命中时退回宿主附件服务上的完整 JSON 引用。
 */
async function readAttachmentBytes(attachments, attachment, { maxBytes, signal, resolveAttachment } = {}) {
  const label = attachment.attachmentId ?? attachment.shortId;
  let bytes, mediaType, ref;
  if (typeof resolveAttachment === 'function') {
    const found = await resolveAttachment(attachment);
    if (found?.bytes instanceof Uint8Array && found.bytes.byteLength > 0) {
      bytes = found.bytes;
      mediaType = sniffMediaType(found.bytes) ?? found.mediaType;
      ref = found.ref;
    }
  }
  if (!bytes) {
    if (attachment.shortId) {
      throw new Error(`附件短摘要 ${attachment.shortId} 无法定位；请给出完整 sha256（共 64 位十六进制）或改用 session-latest`);
    }
    if (!attachments) throw new Error('引用会话附件需要宿主附件服务，当前上下文不可用');
    if (attachment.ref && typeof attachment.ref === 'object' && typeof attachments.readImage === 'function') {
      try {
        const stored = await attachments.readImage(attachment.ref, signal);
        const data = stored?.data;
        if (data instanceof Uint8Array && data.byteLength > 0) {
          bytes = data;
          mediaType = sniffMediaType(data) ?? attachment.ref.mediaType ?? 'image/png';
        }
      } catch (error) {
        throw new Error(`附件 ${attachment.attachmentId} 读取失败：${error?.message ?? error}`);
      }
    }
  }
  if (!bytes) {
    throw new Error(`附件 ${label} 无法读取：需要会话历史中的完整图片引用或可复制的 attachment={…}；也可以改用 session-latest、本地路径或 https URL`);
  }
  if (bytes.byteLength > maxBytes) throw new Error(`附件 ${label} 为 ${bytes.byteLength} 字节，超过 ${maxBytes} 上限`);
  if (!mediaType) mediaType = sniffMediaType(bytes);
  if (!mediaType) throw new Error(`附件 ${label} 不是可识别的图片格式`);
  return { bytes, mediaType, ref };
}

/**
 * 把模型给出的图像来源（https URL / data URI / 会话附件 / 本地路径）解析为
 * 方舟可接受的 url 字段。本地与附件内容编码为 data URI；远程 URL 原样透传。
 * readFile 由调用方注入（默认 node fs；工具内会换成宿主 fs 服务）。
 * resolveAttachment 把会话附件引用补全为字节（工具注入会话索引 + 附件服务）；
 * latestAttachment 提供“本会话最近一张图”，供 session-latest 使用。
 */
export async function resolveImageSources(specs, {
  cwd, maxBytes = MAX_SOURCE_IMAGE_BYTES, maxSources = MAX_SOURCE_IMAGES,
  readFile, attachments, signal, resolveAttachment, latestAttachment
} = {}) {
  const list = (Array.isArray(specs) ? specs : []).filter(value => typeof value === 'string' && value.trim().length > 0);
  if (list.length > maxSources) throw new Error(`参考图过多：${list.length} 张（最多 ${maxSources} 张）`);
  const resolved = [];
  const seen = new Set();
  const pushAttachment = async attachment => {
    if (attachment.attachmentId && seen.has(attachment.attachmentId)) return;
    const { bytes, mediaType, ref } = await readAttachmentBytes(attachments, attachment, { maxBytes, signal, resolveAttachment });
    const id = ref?.attachmentId ?? attachment.attachmentId ?? attachment.shortId;
    if (seen.has(id)) return;
    seen.add(id);
    resolved.push({ url: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`, origin: 'attachment', mediaType, bytes: bytes.byteLength, attachmentId: id });
  };
  for (const spec of list) {
    const trimmed = spec.trim();
    if (isHttpUrl(trimmed)) {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:') throw new Error('参考图 URL 必须使用 HTTPS');
      resolved.push({ url: trimmed, origin: 'url' });
      continue;
    }
    if (/^data:/iu.test(trimmed)) {
      const { mediaType } = decodeDataUri(trimmed, maxBytes);
      resolved.push({ url: trimmed.replace(/^data:[^,]+;/iu, `data:${mediaType};`), origin: 'data-uri', mediaType });
      continue;
    }
    if (SESSION_LATEST.test(trimmed)) {
      const ref = typeof latestAttachment === 'function' ? await latestAttachment() : undefined;
      if (!ref) throw new Error('本会话最近没有可用图片：请先上传图片，或改用本地路径 / https URL / 完整附件引用');
      await pushAttachment({ attachmentId: ref.attachmentId, ref });
      continue;
    }
    const attachment = parseAttachmentSpec(trimmed);
    if (attachment?.ambiguous) {
      throw new Error(`参考图引用包含多个附件 ID（${attachment.ambiguous.join('、')}）；请只保留一个 attachmentId=… 或改用 session-latest`);
    }
    if (attachment) {
      await pushAttachment(attachment);
      continue;
    }
    const target = isAbsolute(trimmed) ? trimmed : resolve(cwd ?? process.cwd(), trimmed);
    let bytes;
    try { bytes = readFile ? new Uint8Array(await readFile(trimmed)) : new Uint8Array(await (await import('node:fs/promises')).readFile(target)); }
    catch (error) { throw new Error(`无法读取参考图 ${JSON.stringify(trimmed)}：${error?.message ?? error}`); }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error(`参考图 ${JSON.stringify(trimmed)} 为空或不可读`);
    if (bytes.byteLength > maxBytes) throw new Error(`参考图 ${JSON.stringify(trimmed)} 为 ${bytes.byteLength} 字节，超过 ${maxBytes} 上限`);
    const mediaType = sniffMediaType(bytes);
    if (!mediaType || !mediaType.startsWith('image/')) throw new Error(`参考图 ${JSON.stringify(trimmed)} 不是方舟支持的图片格式`);
    resolved.push({ url: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`, origin: 'file', mediaType, bytes: bytes.byteLength });
  }
  return resolved;
}

