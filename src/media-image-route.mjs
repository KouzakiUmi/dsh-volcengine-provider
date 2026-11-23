// 原始图片文件附件的受控回源：GET /plugins/dsh-volcengine-provider/image/file?…
// 引用由工具结果公开给当前会话；路由只接受回环来源与同源/宿主 Origin。
import { MAX_IMAGE_RESULT_BYTES } from './media.mjs';

export const IMAGE_FILE_PATH = '/plugins/dsh-volcengine-provider/image/file';
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/u;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function fail(response, status, error) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(JSON.stringify({ error }));
}

function loopbackHostname(hostHeader) {
  const value = String(hostHeader ?? '').trim().toLowerCase();
  const host = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0];
  return ['127.0.0.1', 'localhost', '::1'].includes(host) ? host : undefined;
}

export function isTrustedRequest(remoteAddress, headers, method) {
  const remote = String(remoteAddress ?? '');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  if (!loopbackHostname(headers?.host)) return false;
  const origin = typeof headers?.origin === 'string' ? headers.origin : undefined;
  const site = typeof headers?.['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : undefined;
  if (site === 'cross-site') return false;
  if (origin === 'dsh-app://app') return true;
  if (String(method ?? 'GET').toUpperCase() === 'GET' && origin === undefined) return true;
  try { return new URL(origin).host === new URL(`http://${headers.host}`).host; }
  catch { return false; }
}

function readReference(url) {
  const keys = ['attachmentId', 'name', 'bytes', 'mediaType'];
  if (keys.some(key => url.searchParams.getAll(key).length !== 1)) return undefined;
  const attachmentId = url.searchParams.get('attachmentId');
  const bytes = Number(url.searchParams.get('bytes'));
  const mediaType = url.searchParams.get('mediaType');
  const name = String(url.searchParams.get('name') ?? '').slice(0, 200);
  if (!ATTACHMENT_ID.test(attachmentId) || !IMAGE_TYPES.has(mediaType)) return undefined;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_IMAGE_RESULT_BYTES) return undefined;
  if (!name || /[\x00-\x1f\x7f]/u.test(name)) return undefined;
  return { ref: { attachmentId, name, bytes }, mediaType };
}

function safeName(name) {
  return name.replace(/[^\w.-]+/gu, '_').slice(0, 120) || 'image.bin';
}

async function drained(response) {
  await new Promise((resolve, reject) => {
    response.once('finish', resolve);
    response.once('close', resolve);
    response.once('error', reject);
  }).catch(() => {});
}

export function registerImageFileRoute(webCtx, options) {
  const active = new Set();
  let disposed = false;
  const unregister = webCtx.webServer.register({
    kind: 'exact', path: IMAGE_FILE_PATH,
    async handler(request, response) {
      const method = String(request.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return fail(response, 405, 'method not allowed');
      if (!isTrustedRequest(request.socket?.remoteAddress, request.headers, method)) return fail(response, 403, 'forbidden');
      if (disposed) return fail(response, 503, 'plugin disposed');
      const parsed = readReference(new URL(request.url ?? '', 'http://localhost'));
      if (!parsed) return fail(response, 400, '图片附件参数不合法');
      const attachments = options.resolveAttachments();
      if (!attachments || typeof attachments.readFileStream !== 'function') return fail(response, 503, '附件服务不可用');
      const controller = new AbortController();
      active.add(controller);
      try {
        const stream = await attachments.readFileStream(parsed.ref, controller.signal);
        response.statusCode = 200;
        response.setHeader('content-type', parsed.mediaType);
        response.setHeader('content-length', String(parsed.ref.bytes));
        response.setHeader('cache-control', 'private, max-age=3600');
        response.setHeader('x-content-type-options', 'nosniff');
        const disposition = new URL(request.url ?? '', 'http://localhost').searchParams.get('download') === '1' ? 'attachment' : 'inline';
        response.setHeader('content-disposition', `${disposition}; filename="${safeName(parsed.ref.name)}"`);
        let total = 0;
        for await (const chunk of stream) {
          if (disposed || controller.signal.aborted) break;
          total += chunk.byteLength;
          if (total > parsed.ref.bytes) throw new Error('图片附件超出声明长度');
          if (!response.write(chunk)) await new Promise(resolve => response.once('drain', resolve));
        }
        if (total !== parsed.ref.bytes && !controller.signal.aborted) throw new Error('图片附件长度不一致');
        response.end();
        await drained(response);
      } catch {
        if (!response.headersSent) fail(response, 500, '附件读取失败');
        else response.destroy();
      } finally {
        active.delete(controller);
        controller.abort();
      }
    }
  });
  return () => {
    disposed = true;
    for (const controller of active) controller.abort();
    unregister();
  };
}
