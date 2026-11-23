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
export async function arkFetchJson(url, { method = 'GET', apiKey, body, signal, timeoutMs = 120000 } = {}) {
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
    const text = await response.text();
    if (text.length > MAX_JSON_RESPONSE_BYTES) throw new ArkApiError('方舟媒体接口响应过大', response.status);
    let data;
    try { data = text.length ? JSON.parse(text) : {}; }
    catch { throw new ArkApiError(`方舟媒体接口返回非 JSON 内容（HTTP ${response.status}）`, response.status); }
    if (!response.ok) {
      const detail = data?.error?.message ?? data?.message ?? data?.error?.code ?? '';
      throw new ArkApiError(`方舟媒体接口错误（HTTP ${response.status}）${detail ? `：${redactSecrets(detail).slice(0, 300)}` : ''}`, response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof ArkApiError) throw error;
    if (error?.name === 'AbortError') throw error;
    throw new ArkApiError(`方舟媒体接口请求失败：${redactSecrets(error?.message ?? error)}`);
  } finally { clearTimeout(timer); }
}

function allowedDownloadHost(hostname) {
  return MEDIA_DOWNLOAD_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

/**
 * 以流式字节块下载受白名单保护的远程媒体。签名 URL 只在本函数内存活，
 * 不进入状态、日志或工具输出。redirect 手动跟随且每跳重新校验主机。
 */
export async function downloadMediaChunks(signedUrl, { signal, timeoutMs = 300000, maxBytes = MAX_IMAGE_RESULT_BYTES, label = '图片' } = {}) {
  let current = new URL(signedUrl);
  if (current.protocol !== 'https:') throw new Error(`${label}下载地址必须是 HTTPS`);
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
    if (!allowedDownloadHost(current.hostname)) throw new Error(`${label}下载地址不在火山引擎白名单内：${current.hostname}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label}下载超时`)), timeoutMs);
    try {
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.arrayBuffer().catch(() => {});
        if (!location) throw new Error(`${label}下载重定向缺少目标`);
        current = new URL(location, current);
        if (current.protocol !== 'https:') throw new Error(`${label}下载重定向目标必须是 HTTPS`);
        continue;
      }
      if (!response.ok) throw new Error(`${label}下载失败（HTTP ${response.status}）`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        await response.arrayBuffer().catch(() => {});
        throw new Error(`${label}超过 ${maxBytes} 字节上限`);
      }
      const stream = (async function* () {
        let total = 0;
        try {
          for await (const chunk of response.body) {
            total += chunk.byteLength;
            if (total > maxBytes) throw new Error(`${label}超过 ${maxBytes} 字节上限`);
            yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          }
        } finally { await response.body.cancel().catch(() => {}); }
      })();
      const expected = declared > 0 ? declared : undefined;
      return { stream, bytes: expected };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw error instanceof Error ? error : new Error(redactSecrets(String(error)));
    } finally { clearTimeout(timer); }
  }
  throw new Error(`${label}下载重定向次数过多`);
}

export async function downloadMediaBytes(url, options = {}) {
  const { stream, bytes } = await downloadMediaChunks(url, options);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) { chunks.push(chunk); total += chunk.byteLength; }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return { data, bytes: bytes ?? total };
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

export function mediaExtensionFor(mediaType) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tif' }[mediaType] ?? 'bin';
}

const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/u;
const ATTACHMENT_ID_ANY = /sha256:[a-f0-9]{64}/u;

/** 模型可给出 attachmentId=… / attachment={…json…} / 裸 sha256 id 三种形式。 */
export function parseAttachmentSpec(value) {
  const text = String(value).trim();
  const embedded = /attachment=(\{[^}]*\})/u.exec(text);
  if (embedded) {
    try {
      const parsed = JSON.parse(embedded[1]);
      if (typeof parsed?.attachmentId === 'string' && ATTACHMENT_ID.test(parsed.attachmentId)) {
        return { attachmentId: parsed.attachmentId, ref: parsed };
      }
    } catch { /* fall through to id matching */ }
  }
  const labeled = /attachmentId\s*=\s*(sha256:[a-f0-9]{64})/u.exec(text);
  if (labeled) return { attachmentId: labeled[1] };
  const bare = ATTACHMENT_ID_ANY.exec(text);
  if (bare && text.replace(ATTACHMENT_ID_ANY, '').replace(/attachmentId\s*=/u, '').trim().length === 0) {
    return { attachmentId: bare[0] };
  }
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

async function readAttachmentBytes(attachments, attachment, maxBytes, signal) {
  if (!attachments) throw new Error('引用会话附件需要宿主附件服务，当前上下文不可用');
  const id = attachment.attachmentId;
  // 完整 ImageAttachmentRef 走 readImage（存储侧校验字节）；裸 id 先经 imageHostPath。
  if (attachment.ref && typeof attachment.ref === 'object' && typeof attachments.readImage === 'function') {
    const stored = await attachments.readImage(attachment.ref, signal);
    const data = stored?.data;
    if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error(`附件 ${id} 无法读取`);
    if (data.byteLength > maxBytes) throw new Error(`附件 ${id} 为 ${data.byteLength} 字节，超过 ${maxBytes} 上限`);
    return { bytes: data, mediaType: sniffMediaType(data) ?? attachment.ref.mediaType ?? 'image/png' };
  }
  if (typeof attachments.imageHostPath === 'function' && attachment.ref) {
    const hostPath = attachments.imageHostPath(attachment.ref);
    if (hostPath) {
      const { readFile } = await import('node:fs/promises');
      const data = new Uint8Array(await readFile(hostPath));
      if (data.byteLength > maxBytes) throw new Error(`附件 ${id} 为 ${data.byteLength} 字节，超过 ${maxBytes} 上限`);
      const mediaType = sniffMediaType(data);
      if (!mediaType) throw new Error(`附件 ${id} 不是可识别的图片格式`);
      return { bytes: data, mediaType };
    }
  }
  throw new Error(`附件 ${id} 需要完整 attachment JSON 引用（含 mediaType/bytes/width/height）才能读取`);
}

/**
 * 把模型给出的图像来源（https URL / data URI / 会话附件 / 本地路径）解析为
 * 方舟可接受的 url 字段。本地与附件内容编码为 data URI；远程 URL 原样透传。
 * readFile 由调用方注入（默认 node fs；工具内会换成宿主 fs 服务）。
 */
export async function resolveImageSources(specs, {
  cwd, maxBytes = MAX_SOURCE_IMAGE_BYTES, maxSources = MAX_SOURCE_IMAGES,
  readFile, attachments, signal
} = {}) {
  const list = (Array.isArray(specs) ? specs : []).filter(value => typeof value === 'string' && value.trim().length > 0);
  if (list.length > maxSources) throw new Error(`参考图过多：${list.length} 张（最多 ${maxSources} 张）`);
  const resolved = [];
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
    const attachment = parseAttachmentSpec(trimmed);
    if (attachment) {
      const { bytes, mediaType } = await readAttachmentBytes(attachments, attachment, maxBytes, signal);
      resolved.push({ url: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`, origin: 'attachment', mediaType, bytes: bytes.byteLength });
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

