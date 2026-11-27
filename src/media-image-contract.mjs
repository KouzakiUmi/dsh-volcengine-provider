// Seedream 请求约束及响应到工具结果的白名单投影。
import { DEFAULT_IMAGE_MODEL, SEEDREAM_55, SUPPORTED_IMAGE_MODELS } from './media-config.mjs';
import { MAX_PROMPT_CHARS, MAX_SOURCE_IMAGES, pngHasAlpha } from './media.mjs';

export const SUPPORTED_IMAGE_SIZES = ['1K', '1.5K', '2K'];
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpeg'];
export const IMAGE_BACKGROUNDS = ['auto', 'transparent', 'opaque'];
const LAYER_SIZES = ['auto', ...SUPPORTED_IMAGE_SIZES];
const SIZE_PATTERN = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/u;
const MAX_IMAGES_55 = 100;
const DEFAULT_LAYERS_55 = 30; // 含底图
const MAX_IMAGES_50 = 17;
const MAX_LAYER_JSON_BYTES = 2 * 1024 * 1024;

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const string = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' };
const arrayOf = items => ({ type: 'array', items });
const objectOf = properties => ({ type: 'object', additionalProperties: false, properties });
const dimensions = { width: integer, height: integer };
const box = objectOf({ absolute: arrayOf(integer), normalized: arrayOf(integer) });
const styleFlags = ['bold', 'italic', 'underline', 'strikethrough', 'shadow', 'translucent'];
const style = objectOf({
  similar_font_family: string, foreground_color: string,
  ...Object.fromEntries(styleFlags.map(flag => [flag, boolean]))
});
const ocrSchema = objectOf({
  text: string,
  lines: arrayOf(objectOf({ bounding_box: box, runs: arrayOf(objectOf({ text: string, style })) }))
});

export const LAYER_OPTIONS_SCHEMA = {
  ...objectOf({
    max_images: { ...integer, description: '2–100 张，包含底图；省略时方舟默认 30 张' },
    text_recognition: { ...boolean, description: '是否返回规整文字图层的富文本 OCR，默认 false' }
  }),
  description: '仅 Seedream 5.5 图层拆分使用'
};

export const IMAGE_OUTPUT_SCHEMA = objectOf({
  text: string, model: string, created: integer,
  images: arrayOf(objectOf({ attachmentId: string, mediaType: string, bytes: integer, ...dimensions, name: string })),
  originals: arrayOf(objectOf({
    attachment: objectOf({ attachmentId: string, name: string, bytes: integer }),
    mediaType: string, ...dimensions, background: { type: 'string', enum: ['transparent', 'opaque'] },
    z_index: integer, name: string, description: string, bounding_box: box, text_recognition: ocrSchema
  }))
});

function readLayerOptions(value, layered, model) {
  if (value === undefined) return undefined;
  if (!layered || model !== SEEDREAM_55) throw new Error('layer_decomposition_options 仅用于 Seedream 5.5 图层拆分');
  if (!isRecord(value) || Object.keys(value).some(key => !(key === 'max_images' || key === 'text_recognition'))) {
    throw new Error('layer_decomposition_options 只接受 max_images 和 text_recognition');
  }
  const { max_images: max, text_recognition: ocr } = value;
  if (max !== undefined && (!Number.isInteger(max) || max < 2 || max > MAX_IMAGES_55)) {
    throw new Error(`layer_decomposition_options.max_images 必须是 2–${MAX_IMAGES_55} 的整数（含底图）`);
  }
  if (ocr !== undefined && typeof ocr !== 'boolean') throw new Error('layer_decomposition_options.text_recognition 必须是布尔值');
  return value;
}

export function imageRequest(args, defaultModel) {
  const { layer_decomposition: layered = false, background, watermark = true } = args;
  const prompt = args.prompt?.trim() ?? '';
  if (!layered && !prompt) throw new Error('图片生成时 prompt 必须是非空字符串');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt 超过 ${MAX_PROMPT_CHARS} 字符上限`);
  const model = args.model ?? defaultModel?.() ?? DEFAULT_IMAGE_MODEL;
  if (!SUPPORTED_IMAGE_MODELS.includes(model)) throw new Error(`model 必须是 ${SUPPORTED_IMAGE_MODELS.join(' / ')} 之一`);
  const layerOptions = readLayerOptions(args.layer_decomposition_options, layered, model);
  const size = args.size?.trim() ?? (layered ? 'auto' : '2K');
  if (layered && !LAYER_SIZES.includes(size)) throw new Error(`图层拆分的 size 必须是 ${LAYER_SIZES.join(' / ')} 之一`);
  if (!layered && !SUPPORTED_IMAGE_SIZES.includes(size) && !SIZE_PATTERN.test(size)) {
    throw new Error(`size 必须是 ${SUPPORTED_IMAGE_SIZES.join(' / ')} 或宽x高（如 1920x1920）`);
  }
  const format = args.output_format ?? 'png';
  if (!SUPPORTED_IMAGE_FORMATS.includes(format)) throw new Error(`output_format 必须是 ${SUPPORTED_IMAGE_FORMATS.join(' / ')} 之一`);
  if (layered && background !== undefined) throw new Error('图层拆分不接受 background；上层自动输出透明 PNG');
  if (background !== undefined && (!IMAGE_BACKGROUNDS.includes(background) || (background === 'auto' && model !== SEEDREAM_55))) {
    throw new Error('background 可用 transparent / opaque，auto 仅用于 Seedream 5.5');
  }
  if (background === 'transparent' && format !== 'png') throw new Error('透明背景要求 output_format=png');
  const legacyAlpha = background === 'transparent' && model !== SEEDREAM_55;
  const specs = [args.image, ...(args.images ?? [])].filter(value => value?.trim());
  if (layered && specs.length !== 1) throw new Error('图层拆分需要恰好一张 PNG 或 JPEG 参考图');
  if (legacyAlpha && specs.length !== 1) throw new Error('Seedream 5.0 的透明背景模式需要一张带透明通道的 PNG 参考图；文生或多图生 RGBA 请用 Seedream 5.5');
  const body = { model, ...(prompt ? { prompt } : {}), size, output_format: format, response_format: 'url', watermark };
  if (layered) body.layer_decomposition = true;
  if (layerOptions) body.layer_decomposition_options = layerOptions;
  if (background !== undefined) body.background = background;
  const maxResults = !layered ? 1 : model === SEEDREAM_55 ? layerOptions?.max_images ?? DEFAULT_LAYERS_55 : MAX_IMAGES_50;
  return { body, specs, layered, legacyAlpha, maxResults, maxSources: layered || legacyAlpha ? 1 : MAX_SOURCE_IMAGES,
    ...(layered ? { maxJsonBytes: MAX_LAYER_JSON_BYTES } : {}) };
}

export function assertReferenceFormat(request, sources) {
  if (!request.layered && !request.legacyAlpha) return;
  const { url, mediaType } = sources[0];
  if (!mediaType) return; // 外部 URL 由方舟拉取和校验，不从扩展名猜格式。
  if (request.legacyAlpha && (mediaType !== 'image/png' || !pngHasAlpha(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')))) {
    throw new Error('Seedream 5.0 的透明背景模式需要一张带透明通道的 PNG 参考图；也可改用 Seedream 5.5');
  }
  if (request.layered && !['image/png', 'image/jpeg'].includes(mediaType)) {
    throw new Error('图层拆分仅接受 PNG 或 JPEG；若会话预览已重编码，请传原始 PNG/JPEG 的本地路径或 HTTPS URL');
  }
}

function copyFields(value, keys, accepts) {
  return Object.fromEntries(keys.filter(key => accepts(value[key])).map(key => [key, value[key]]));
}

function boundingBox(value) {
  if (!isRecord(value)) return undefined;
  const result = copyFields(value, ['absolute', 'normalized'], coords => Array.isArray(coords) && coords.length === 4 && coords.every(Number.isSafeInteger));
  return Object.keys(result).length ? result : undefined;
}

function ocrResult(value) {
  if (!isRecord(value) || typeof value.text !== 'string') return undefined;
  const lines = Array.isArray(value.lines) ? value.lines.filter(isRecord).map(line => {
    const box = boundingBox(line.bounding_box);
    const runs = Array.isArray(line.runs) ? line.runs.filter(run => typeof run?.text === 'string').map(run => {
      const style = isRecord(run.style) ? {
        ...copyFields(run.style, ['similar_font_family', 'foreground_color'], item => typeof item === 'string'),
        ...copyFields(run.style, styleFlags, item => typeof item === 'boolean')
      } : undefined;
      return { text: run.text, ...(style ? { style } : {}) };
    }) : undefined;
    return { ...(box ? { bounding_box: box } : {}), ...(runs ? { runs } : {}) };
  }) : undefined;
  return { text: value.text, ...(lines ? { lines } : {}) };
}

function resultEntry(entry, request) {
  if (typeof entry?.url !== 'string' || !entry.url.startsWith('https://') || entry.error) {
    throw new Error('方舟返回的图片结果缺少有效下载地址');
  }
  const z = entry.z_index;
  if (request.layered && (!Number.isInteger(z) || z < 0 || z >= request.maxResults)) {
    throw new Error('方舟返回的图层顺序无效');
  }
  const isOverlay = request.layered && z > 0;
  const format = isOverlay ? 'png' : request.body.output_format;
  const size = typeof entry.size === 'string' ? SIZE_PATTERN.exec(entry.size) : null;
  const background = ['transparent', 'opaque'].includes(entry.background) ? entry.background : undefined;
  const box = isOverlay ? boundingBox(entry.bounding_box) : undefined;
  const ocr = isOverlay ? ocrResult(entry.text_recognition) : undefined;
  return {
    url: entry.url, format, requireAlpha: isOverlay || request.body.background === 'transparent' || background === 'transparent',
    meta: {
      ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}),
      ...(background ? { background } : {}),
      ...(request.layered ? { z_index: z, ...copyFields(entry, ['name', 'description'], value => typeof value === 'string') } : {}),
      ...(box ? { bounding_box: box } : {}), ...(ocr ? { text_recognition: ocr } : {})
    }
  };
}

export function imageResultEntries(response, request) {
  const entries = response?.data;
  if (response?.error || !Array.isArray(entries) || !entries.length) throw new Error('方舟未返回完整的图片结果');
  if (entries.length > request.maxResults) throw new Error(`方舟返回图片数超过本次上限 ${request.maxResults}，未保存不完整结果`);
  const results = entries.map(entry => resultEntry(entry, request));
  if (!request.layered) return results;
  results.sort((a, b) => a.meta.z_index - b.meta.z_index);
  if (results.some((entry, index) => entry.meta.z_index !== index)) throw new Error('方舟返回的图层顺序缺失或重复');
  return results;
}
