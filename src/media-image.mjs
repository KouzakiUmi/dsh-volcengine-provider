// volc_imagine：方舟 Seedream 图片生成、编辑与图层拆分。
// 原图经通用文件附件逐字节保存；会话视觉输入继续使用宿主规范化图片附件。
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  ARK_MEDIA_BASE_URL, arkFetchJson, downloadMediaBytes, mediaExtensionFor,
  assertMediaEnabled, resolveImageSources, sniffMediaType, pngHasAlpha,
  MAX_PROMPT_CHARS, MAX_SOURCE_IMAGES, BILLING_NOTE
} from './media.mjs';
import { SUPPORTED_IMAGE_MODELS, SEEDREAM_55 } from './media-config.mjs';
import {
  SUPPORTED_IMAGE_FORMATS, IMAGE_BACKGROUNDS, IMAGE_OUTPUT_SCHEMA, LAYER_OPTIONS_SCHEMA,
  imageRequest, assertReferenceFormat, imageResultEntries
} from './media-image-contract.mjs';

export { SUPPORTED_IMAGE_MODELS } from './media-config.mjs';
export const IMAGE_TOOL = 'volc_imagine';
export { SUPPORTED_IMAGE_SIZES, SUPPORTED_IMAGE_FORMATS } from './media-image-contract.mjs';
const TOOL_TIMEOUT_MS = 300000;

function describeArgs(args) {
  const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
  const hasRefs = Boolean(args?.image) || (Array.isArray(args?.images) && args.images.length > 0);
  const mode = args?.layer_decomposition ? '拆分图层' : args?.background === 'transparent' ? '生成透明图' : hasRefs ? '改图' : '文生图';
  return prompt ? `${mode}：${prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt}` : mode;
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

function presentationContent(value, baseOnly = false) {
  const images = attachmentsFrom(value);
  return [
    ...(baseOnly ? images.slice(0, 1) : images).map(attachment => ({ type: 'image', attachment })),
    ...originalAttachmentsFrom(value).map(attachment => ({ type: 'file', attachment }))
  ];
}

async function saveResultEntry(attachments, entry, namePrefix, signal) {
  signal.throwIfAborted();
  const z = entry.meta.z_index;
  const label = z === undefined ? '图片结果' : z === 0 ? '底图' : `图层 ${z}`;
  const { data: bytes } = await downloadMediaBytes(entry.url, { signal, label });
  const mediaType = sniffMediaType(bytes);
  if (mediaType !== `image/${entry.format}`) {
    throw new Error(`方舟${label}实际返回 ${mediaType ?? '未知格式'}，与 output_format=${entry.format} 要求的 image/${entry.format} 不一致`);
  }
  if (entry.requireAlpha && !pngHasAlpha(bytes)) throw new Error(`方舟返回的${label}缺少 PNG 透明通道`);
  const name = `${namePrefix}-${z === undefined ? '1' : z === 0 ? 'base' : `layer-${String(z).padStart(2, '0')}`}.${mediaExtensionFor(mediaType)}`;
  signal.throwIfAborted();
  const preview = await attachments.saveImage({ data: bytes, mediaType, name });
  signal.throwIfAborted();
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
      mediaType,
      width: preview.originalDimensions?.width ?? preview.width,
      height: preview.originalDimensions?.height ?? preview.height,
      ...entry.meta
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
      return readFile(target, { signal: exec.signal });
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

function resultText(saved, model, sources, layered) {
  const header = layered ? `Seedream 拆分完成：1 张底图，${saved.length - 1} 个图层（${model}）。`
    : `${sources.length ? 'Edited' : 'Generated'} ${saved.length} image(s) with ${model} via 火山方舟 Agent Plan.`;
  const previewRefs = saved.map(({ original, preview }, index) => {
    const label = !layered ? `${index + 1}` : index === 0 ? '底图' : `图层 ${original.z_index}${original.name ? ` · ${original.name}` : ''}`;
    const recognized = original.text_recognition?.text;
    const ocr = recognized ? `；OCR: ${JSON.stringify(recognized.length > 240 ? `${recognized.slice(0, 240)}…` : recognized)}` : '';
    return `会话图片 ${label}（再次编辑时可直接作为 image 参数）：attachment=${JSON.stringify(preview)}${ocr}`;
  });
  const fileRefs = layered ? [] : saved.map(({ original }) =>
    `Original ${original.mediaType} file（文件附件，仅用于取原图字节，不能作为 image 参考图）: attachment=${JSON.stringify(original.attachment)}`);
  return [header, ...previewRefs, ...fileRefs,
    '“会话图片”行的 attachment= JSON 可原样传回作为 image 精确引用这张图；原始文件保持方舟返回格式，会话预览可能经宿主规范化，不影响原文件字节。'].join('\n');
}

export function registerVolcImagineTool(ctx, options) {
  return ctx.tools.register(defineTool({
    name: IMAGE_TOOL,
    description: [
      '用火山方舟 Seedream（Agent Plan）生成、编辑图片或拆分图层。',
      `文生透明 PNG 和多图生透明 PNG 用 ${SEEDREAM_55}。`,
      `模型：${SUPPORTED_IMAGE_MODELS.join('、')}。${BILLING_NOTE}`,
      '原始 PNG/JPEG 以文件附件逐字节返回，另附宿主规范化图片供会话视觉输入；远程下载地址不会暴露。'
    ].join(' '),
    parameters: {
      prompt: { type: 'string', description: `生成/编辑必填，图层拆分可省略以自动识别主要元素（≤${MAX_PROMPT_CHARS} 字符）` },
      model: { type: 'string', enum: SUPPORTED_IMAGE_MODELS, description: '生成模型；省略时使用设置页选择的默认模型' },
      image: { type: 'string', description: '单张参考图：会话图片 handle 或 sha256 / attachment={…} / session-latest / 本地路径 / data URI / HTTPS URL' },
      images: { type: 'array', items: { type: 'string' }, description: `多张参考图（与 image 合并，合计 ≤${MAX_SOURCE_IMAGES} 张）；编辑刚上传或刚生成的图时用 session-latest` },
      size: { type: 'string', description: '1K / 1.5K / 2K；生成可填宽x高（默认 2K），拆分可填 auto（默认 auto），不可填宽x高' },
      output_format: { type: 'string', enum: SUPPORTED_IMAGE_FORMATS, description: '默认 png；拆分时仅控制底图格式，上层始终为透明 PNG' },
      background: { type: 'string', enum: IMAGE_BACKGROUNDS, description: '透明通道模式；transparent 需 PNG 输出（5.0 还需一张带透明通道的 PNG 参考图）；auto 仅 5.5。拆分时不要传' },
      layer_decomposition: { type: 'boolean', description: '拆分一张 PNG / JPEG 参考图，返回底图与独立图层；默认 false' },
      layer_decomposition_options: LAYER_OPTIONS_SCHEMA,
      watermark: { type: 'boolean', description: '是否添加水印，默认 true' }
    },
    output: {
      schema: IMAGE_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }, ...presentationContent(value, value?.originals?.[0]?.z_index === 0)];
      },
      presentationMeta: (_args, value) => value
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: args => args.layer_decomposition !== true,
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
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]);
      const request = imageRequest(args, options.defaultModel);
      const { body, specs, layered } = request;
      const attachments = options.resolveAttachments();
      if (!attachments || typeof attachments.saveImage !== 'function' || typeof attachments.saveFile !== 'function') {
        throw new Error('宿主附件服务不支持原图与预览分开保存，无法保留输出格式');
      }
      const sessionId = sessionIdOf(exec);
      const images = specs.length
        ? await resolveImageSources(specs, {
          cwd: exec.agent?.session?.header?.cwd,
          maxSources: request.maxSources, readFile: resolveReadFile({ agent: exec.agent, signal }), attachments, signal,
          resolveAttachment: attachmentResolver(options.attachmentIndex, attachments, signal),
          latestAttachment: () => options.attachmentIndex?.latest(sessionId)
        })
        : [];
      assertReferenceFormat(request, images);
      if (images.length === 1) body.image = images[0].url;
      else if (images.length > 1) body.image = images.map(item => item.url);
      signal.throwIfAborted();
      const { key } = await options.credentials();
      const data = await arkFetchJson(`${ARK_MEDIA_BASE_URL}/images/generations`, {
        method: 'POST', apiKey: key, body, signal, timeoutMs: TOOL_TIMEOUT_MS, maxBytes: request.maxJsonBytes
      });
      const entries = imageResultEntries(data, request);
      const saved = [];
      const namePrefix = `volc-imagine-${Date.now()}`;
      for (const entry of entries) {
        saved.push(await saveResultEntry(attachments, entry, namePrefix, signal));
      }
      signal.throwIfAborted();
      return {
        model: typeof data.model === 'string' ? data.model : body.model,
        created: Number.isSafeInteger(data.created) ? data.created : 0,
        images: saved.map(item => item.preview), originals: saved.map(item => item.original),
        text: resultText(saved, body.model, images, layered)
      };
    }
  }));
}
