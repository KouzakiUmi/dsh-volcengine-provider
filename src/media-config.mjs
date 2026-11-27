// 图片生成的 Host / Client 共享契约；本文件必须保持浏览器安全，不引入 Node 模块。
export const SEEDREAM_55 = 'doubao-seedream-5.5';
export const IMAGE_MODEL_OPTIONS = [
  { id: 'doubao-seedream-5-0-pro', label: 'Doubao Seedream 5.0 Pro' },
  { id: SEEDREAM_55, label: 'Doubao Seedream 5.5' },
  { id: 'doubao-seedream-5.0-flash', label: 'Doubao Seedream 5.0 Flash' }
];
export const SUPPORTED_IMAGE_MODELS = IMAGE_MODEL_OPTIONS.map(option => option.id);
export const DEFAULT_IMAGE_MODEL = SUPPORTED_IMAGE_MODELS[0];
export const MEDIA_TOOL_KEYS = ['imageTool'];

export function defaultMediaState() {
  return { riskAcknowledged: false, imageTool: false, imageModel: DEFAULT_IMAGE_MODEL };
}

export function normalizeMediaState(value) {
  const base = defaultMediaState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  for (const key of ['riskAcknowledged', ...MEDIA_TOOL_KEYS]) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('媒体工具开关必须是布尔值');
    if (typeof value[key] === 'boolean') base[key] = value[key];
  }
  if (value.imageModel !== undefined) {
    if (typeof value.imageModel !== 'string' || !SUPPORTED_IMAGE_MODELS.includes(value.imageModel)) {
      throw new Error(`默认图片模型必须是 ${SUPPORTED_IMAGE_MODELS.join(' / ')} 之一`);
    }
    base.imageModel = value.imageModel;
  }
  // 旧版 videoTool 字段在读取时丢弃；撤销风险确认会关闭图片工具。
  if (!base.riskAcknowledged) for (const key of MEDIA_TOOL_KEYS) base[key] = false;
  return base;
}

export function mediaToolEnabled(media, key) {
  return media?.riskAcknowledged === true && media?.[key] === true;
}

export function assertMediaEnabled(enabled, toolName) {
  if (!enabled()) throw new Error(`${toolName} 未启用：请先在 设置 → 火山方舟 Provider → 图片生成 中开启图片工具`);
}
