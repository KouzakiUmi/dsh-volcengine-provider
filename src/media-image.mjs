// volc_imagine：方舟 Seedream 文生图 / 图像编辑（单个工具，image/images 可选）。
// 原图经通用文件附件逐字节保存；会话视觉输入继续使用宿主规范化图片附件。
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  ARK_MEDIA_BASE_URL, arkFetchJson, downloadMediaBytes, mediaExtensionFor,
  assertMediaEnabled, resolveImageSources, sniffMediaType,
  MAX_IMAGE_RESULT_BYTES, MAX_PROMPT_CHARS, MAX_SOURCE_IMAGES, BILLING_NOTE
} from './media.mjs';
import { SUPPORTED_IMAGE_MODELS, DEFAULT_IMAGE_MODEL } from './media-config.mjs';

export { SUPPORTED_IMAGE_MODELS } from './media-config.mjs';
export const IMAGE_TOOL = 'volc_imagine';
export const SUPPORTED_IMAGE_SIZES = ['1K', '1.5K', '2K'];
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpeg'];
const SIZE_PATTERN = /^\d{3,5}x\d{3,5}$/u;

const IMAGE_ATTACHMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' },
    width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' }
  }
};
const FILE_ATTACHMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { attachmentId: { type: 'string' }, name: { type: 'string' }, bytes: { type: 'number' } }
};
const ORIGINAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    attachment: FILE_ATTACHMENT_SCHEMA, mediaType: { type: 'string' },
    width: { type: 'number' }, height: { type: 'number' }
  }
};
const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string' }, model: { type: 'string' }, created: { type: 'number' },
    images: { type: 'array', items: IMAGE_ATTACHMENT_SCHEMA },
    originals: { type: 'array', items: ORIGINAL_SCHEMA }
  }
};

function describeArgs(args) {
  const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
  const hasRefs = Boolean(args?.image) || (Array.isArray(args?.images) && args.images.length > 0);
  return `${hasRefs ? '改图' : '文生图'}：${prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt}`;
}

function attachmentsFrom(value) {
  const list = Array.isArray(value?.images) ? value.images : [];
  return list.map(image => image?.attachmentId ? {
    attachmentId: image.attachmentId, mediaType: image.mediaType ?? 'image/png',
    bytes: image.bytes ?? 0, width: image.width ?? 0, height: image.height ?? 0,
    ...(image.name ? { name: image.name } : {})
  } : undefined).filter(Boolean);
}

function originalAttachmentsFrom(value) {
  const list = Array.isArray(value?.originals) ? value.originals : [];
  return list.map(item => item?.attachment?.attachmentId ? item.attachment : undefined).filter(Boolean);
}

function presentationContent(value) {
  return [
    ...attachmentsFrom(value).map(attachment => ({ type: 'image', attachment })),
    ...originalAttachmentsFrom(value).map(attachment => ({ type: 'file', attachment }))
  ];
}

function expectedMediaType(outputFormat) {
  return outputFormat === 'png' ? 'image/png' : 'image/jpeg';
}

async function saveResultEntry(attachments, bytes, mediaType, name) {
  const preview = await attachments.saveImage({ data: bytes, mediaType, name });
  const original = await attachments.saveFile({ data: bytes, name });
  const originalRef = original?.attachment ?? original;
  return {
    preview: {
      attachmentId: preview.attachmentId, mediaType: preview.mediaType,
      bytes: preview.bytes, width: preview.width, height: preview.height,
      ...(preview.name ? { name: preview.name } : {})
    },
    original: {
      attachment: {
        attachmentId: String(originalRef.attachmentId),
        name: String(originalRef.name ?? name),
        bytes: Number(originalRef.bytes ?? bytes.byteLength)
      },
      mediaType, width: preview.width, height: preview.height
    }
  };
}

function resolveReadFile(exec) {
  const cwd = exec.agent?.session?.header?.cwd;
  return async path => {
    const fs = exec.agent?.ctx?.fs;
    if (!fs) {
      const { readFile } = await import('node:fs/promises');
      const { isAbsolute, resolve } = await import('node:path');
      const target = isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
      return readFile(target);
    }
    const target = await fs.resolve(path, { cwd, signal: exec.signal });
    return fs.readBytes(target, exec.signal, 30 * 1024 * 1024);
  };
}

function sessionIdOf(exec) {
  try { return exec?.agent?.session?.id; } catch { return undefined; }
}

/**
 * 把模型给出的会话图片引用补全为可读字节。
 * - 完整内容 ID 或 8 位以上短摘要：从图片附件索引取完整 ImageAttachmentRef（内容寻址，可跨会话精确引用）；
 * - `attachment={…}` 自带完整字段时允许直接使用；
 * - 命中后用宿主附件服务读取并校验字节。
 */
function attachmentResolver(index, attachments, signal) {
  if (!index) return undefined;
  return async spec => {
    const id = spec.attachmentId ?? spec.shortId;
    let found;
    try { found = index.resolve(id); } catch { found = undefined; }
    if (found?.ambiguous) {
      throw new Error(`图片短摘要 ${id} 匹配到多张图片；请使用完整 sha256 或 session-latest`);
    }
    if (!found && spec.ref && typeof spec.ref.mediaType === 'string'
      && Number.isSafeInteger(spec.ref.bytes) && Number.isSafeInteger(spec.ref.width) && Number.isSafeInteger(spec.ref.height)) {
      found = { ref: spec.ref };
    }
    if (!found?.ref) {
      if (spec.shortId) {
        throw new Error(`图片短摘要 ${spec.shortId} 未在本次会话图片索引中匹配到唯一图片；请使用完整 sha256 或 session-latest`);
      }
      throw new Error(`图片附件 ${id} 不在本次会话图片索引中；请重新附上图片，或改用 session-latest、本地路径或 https URL`);
    }
    if (typeof attachments.readImage !== 'function') return { ref: found.ref };
    let stored;
    try { stored = await attachments.readImage(found.ref, signal); }
    catch (error) {
      // 附件服务抛英文存储错误；换成可操作提示，并保留原始类型便于排查。
      const reason = String(error?.code ?? error?.message ?? error);
      // 只按稳定错误码区分“确定不存在”与“其余存储失败”，不把 IO/权限故障断言成内容损坏。
      const hint = /NOT_FOUND|missing/iu.test(reason) ? '该图片已被清理或不在存储中' : '图片存储不可用或内容已损坏';
      throw new Error(`图片附件 ${found.ref.attachmentId} 读取失败：${hint}；请重新附上图片，或改用本地路径或 https URL`);
    }
    return { ref: found.ref, bytes: stored?.data, mediaType: stored?.mediaType ?? found.ref.mediaType };
  };
}

export function registerVolcImagineTool(ctx, options) {
  return ctx.tools.register(defineTool({
    name: IMAGE_TOOL,
    description: [
      '用火山方舟 Seedream（Agent Plan）生成或编辑图片。',
      '仅传 prompt 即文生图；传 image/images 即按参考图编辑/多图融合。',
      'image 可直接复制会话历史中图片旁的 `Image "name" (sha256:…)` 或工具结果里的 `attachment={…}`；也可以传 `session-latest` 表示本会话最近一张图片（用户刚上传或刚生成的图），插件会自动补全格式、尺寸与字节等参数，不需要模型报告这些值。',
      `模型：${SUPPORTED_IMAGE_MODELS.join('、')}。${BILLING_NOTE}`,
      '原始 PNG/JPEG 以文件附件逐字节返回，另附宿主规范化图片供会话视觉输入；远程下载地址不会暴露。'
    ].join(' '),
    parameters: {
      prompt: { type: 'string', required: true, description: `图片提示词（≤${MAX_PROMPT_CHARS} 字符）` },
      model: { type: 'string', enum: SUPPORTED_IMAGE_MODELS, description: '生成模型；省略时使用设置页选择的默认模型' },
      image: { type: 'string', description: '单张参考图：会话图片 sha256 / attachment={…} / session-latest / 本地路径 / data URI / https URL' },
      images: { type: 'array', items: { type: 'string' }, description: `多张参考图（与 image 合并，合计 ≤${MAX_SOURCE_IMAGES} 张）；编辑刚上传或刚生成的图时用 session-latest` },
      size: { type: 'string', description: '输出尺寸：1K / 1.5K / 2K，或 WpxH 像素（如 1920x1920）；默认 2K' },
      output_format: { type: 'string', enum: SUPPORTED_IMAGE_FORMATS, description: '原始文件格式，默认 png' },
      watermark: { type: 'boolean', description: '是否添加水印，默认 true' }
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }, ...presentationContent(value)];
      },
      presentationMeta: (_args, value) => value
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `${IMAGE_TOOL} ${describeArgs(args)}`, kind: 'other' };
    },
    presentResult(args, result) {
      return {
        card: 'generic', title: `${IMAGE_TOOL} ${describeArgs(args)}`,
        content: presentationContent(result?.meta)
      };
    },
    async execute(args, exec) {
      assertMediaEnabled(options.enabled, IMAGE_TOOL);
      const prompt = String(args?.prompt ?? '').trim();
      if (!prompt) throw new Error('prompt 必须是非空字符串');
      if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt 超过 ${MAX_PROMPT_CHARS} 字符上限`);
      const model = args?.model ?? options.defaultModel?.() ?? DEFAULT_IMAGE_MODEL;
      if (!SUPPORTED_IMAGE_MODELS.includes(model)) throw new Error(`model 必须是 ${SUPPORTED_IMAGE_MODELS.join(' / ')} 之一`);
      const size = args?.size === undefined ? '2K' : String(args.size).trim();
      if (!SUPPORTED_IMAGE_SIZES.includes(size) && !SIZE_PATTERN.test(size)) {
        throw new Error(`size 必须是 ${SUPPORTED_IMAGE_SIZES.join(' / ')} 或 WpxH（如 1920x1920）`);
      }
      const outputFormat = args?.output_format ?? 'png';
      if (!SUPPORTED_IMAGE_FORMATS.includes(outputFormat)) throw new Error(`output_format 必须是 ${SUPPORTED_IMAGE_FORMATS.join(' / ')} 之一`);

      const attachments = options.resolveAttachments();
      if (!attachments || typeof attachments.saveImage !== 'function' || typeof attachments.saveFile !== 'function') {
        throw new Error('宿主附件服务不支持原图与预览分开保存，无法保留输出格式');
      }
      const specs = [args?.image, ...(Array.isArray(args?.images) ? args.images : [])].filter(Boolean);
      const sessionId = sessionIdOf(exec);
      const images = specs.length
        ? await resolveImageSources(specs, {
          cwd: exec.agent?.session?.header?.cwd,
          readFile: resolveReadFile(exec), attachments, signal: exec.signal,
          resolveAttachment: attachmentResolver(options.attachmentIndex, attachments, exec.signal),
          latestAttachment: () => options.attachmentIndex?.latest(sessionId)
        })
        : [];
      const { key } = await options.credentials();
      const body = {
        model, prompt, size, output_format: outputFormat,
        response_format: 'url', watermark: args?.watermark ?? true
      };
      if (images.length === 1) body.image = images[0].url;
      else if (images.length > 1) body.image = images.map(item => item.url);
      const data = await arkFetchJson(`${ARK_MEDIA_BASE_URL}/images/generations`, {
        method: 'POST', apiKey: key, body, signal: exec.signal, timeoutMs: 300000
      });
      const entries = Array.isArray(data?.data) ? data.data.slice(0, 4) : [];
      if (!entries.length) throw new Error('方舟未返回图片结果');

      const saved = [];
      for (const [index, entry] of entries.entries()) {
        if (typeof entry?.url !== 'string' || !entry.url.startsWith('https://')) continue;
        const { data: bytes } = await downloadMediaBytes(entry.url, {
          signal: exec.signal, maxBytes: MAX_IMAGE_RESULT_BYTES, label: '图片结果'
        });
        const actualType = sniffMediaType(bytes);
        const expectedType = expectedMediaType(outputFormat);
        if (actualType !== expectedType) {
          throw new Error(`方舟实际返回 ${actualType ?? '未知格式'}，与 output_format=${outputFormat} 要求的 ${expectedType} 不一致`);
        }
        const name = `volc-imagine-${Date.now()}-${index + 1}.${mediaExtensionFor(actualType)}`;
        saved.push(await saveResultEntry(attachments, bytes, actualType, name));
      }
      if (!saved.length) throw new Error('方舟返回了空图片结果');
      const value = {
        model: String(data.model ?? model), created: Number(data.created ?? 0),
        images: saved.map(item => item.preview), originals: saved.map(item => item.original)
      };
      const lines = [
        `${images.length ? 'Edited' : 'Generated'} ${saved.length} image(s) with ${model} via 火山方舟 Agent Plan.`,
        ...saved.map((item, index) => `会话图片 ${index + 1}（再次编辑时可直接作为 image 参数）：attachment=${JSON.stringify(item.preview)}`),
        ...saved.map((item, index) => `Original ${item.original.mediaType} file${saved.length > 1 ? ` ${index + 1}` : ''}（文件附件，仅用于取原图字节，不能作为 image 参考图）: attachment=${JSON.stringify(item.original.attachment)}`),
        '“会话图片”行的 attachment= JSON 可原样传回作为 image 精确引用这张图；原始文件保持方舟返回格式，会话预览可能经宿主规范化，不影响原文件字节。'
      ];
      return { ...value, text: lines.join(' ') };
    }
  }));
}
