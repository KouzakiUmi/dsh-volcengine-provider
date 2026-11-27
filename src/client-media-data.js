// 图片工具卡片的数据解析；不访问 DOM、网络或 Node 模块。
export const IMAGE_FILE_PATH = '/plugins/dsh-volcengine-provider/image/file';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mediaViewProps(raw) {
  const owner = isRecord(raw?.owner) ? raw.owner : {};
  return { ...raw, ...owner, block: owner.block ?? raw?.block };
}

export function isSettledMediaBlock(props) {
  if (props?.phase === 'result') return true;
  if (props?.phase === 'preparing' || props?.phase === 'start') return false;
  return isRecord(props?.block) && 'kind' in props.block;
}

export function argsOf(block) {
  if (!isRecord(block)) return {};
  let args = isRecord(block.call) ? block.call.args : block.args;
  if (typeof args === 'function') {
    try { args = args(); } catch { args = undefined; }
  }
  if (isRecord(args) && typeof args.read === 'function') {
    try { args = args.read(); } catch { args = undefined; }
  }
  if (isRecord(args)) return args;
  const raw = isRecord(block.call) ? block.call.argsRaw : block.argsRaw;
  if (typeof raw !== 'string' || raw === '') return {};
  try { const parsed = JSON.parse(raw); return isRecord(parsed) ? parsed : {}; }
  catch { return {}; }
}

export function promptOf(block) {
  const prompt = argsOf(block).prompt;
  return typeof prompt === 'string' ? prompt.trim() : '';
}

export function textOf(block) {
  if (!isRecord(block) || !Array.isArray(block.content)) return '';
  return block.content.filter(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text.trim())
    .map(part => part.text.trim()).join('\n\n');
}

export function isLayerResult(block) {
  return argsOf(block).layer_decomposition === true || block?.meta?.originals?.[0]?.z_index === 0;
}

export function mediaItemLabel(item) {
  if (item.zIndex === 0) return '底图';
  return item.zIndex === undefined ? item.name : `图层 ${item.zIndex}${item.layerName ? ` · ${item.layerName}` : ''}`;
}

function mediaResultDetails(value, transparentRequested) {
  const zIndex = value?.z_index;
  return {
    ...(Number.isSafeInteger(zIndex) && zIndex >= 0 ? { zIndex } : {}),
    layerName: typeof value?.name === 'string' ? value.name : '',
    description: typeof value?.description === 'string' ? value.description : '',
    transparent: zIndex > 0 || value?.background === 'transparent' || (value?.background === undefined && transparentRequested),
    bounds: isRecord(value?.bounding_box) ? value.bounding_box : undefined,
    ocr: typeof value?.text_recognition?.text === 'string' ? value.text_recognition : undefined
  };
}

function normalizedImage(part) {
  const value = part?.attachment;
  if (!isRecord(value) || typeof value.attachmentId !== 'string' || !IMAGE_TYPES.has(value.mediaType)) return undefined;
  return {
    attachmentId: value.attachmentId, mediaType: value.mediaType,
    bytes: Number(value.bytes ?? 0), width: Number(value.width ?? 0), height: Number(value.height ?? 0),
    name: typeof value.name === 'string' && value.name ? value.name : `图片.${value.mediaType === 'image/jpeg' ? 'jpg' : value.mediaType.slice(6)}`
  };
}

function originalItem(value) {
  if (!isRecord(value) || !IMAGE_TYPES.has(value.mediaType)) return undefined;
  const ref = value.attachment;
  if (!isRecord(ref) || typeof ref.attachmentId !== 'string') return undefined;
  const bytes = Number(ref.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return undefined;
  return {
    kind: 'original', id: ref.attachmentId, mediaType: value.mediaType, bytes,
    width: Number(value.width ?? 0), height: Number(value.height ?? 0),
    name: typeof ref.name === 'string' && ref.name ? ref.name : `图片.${value.mediaType === 'image/jpeg' ? 'jpg' : value.mediaType.slice(6)}`,
    attachment: { attachmentId: ref.attachmentId, name: typeof ref.name === 'string' && ref.name ? ref.name : 'image', bytes }
  };
}

export function imageFileUrl(item, download = false) {
  if (item?.kind !== 'original') return '';
  const query = new URLSearchParams({
    attachmentId: item.attachment.attachmentId,
    name: item.attachment.name,
    bytes: String(item.attachment.bytes),
    mediaType: item.mediaType,
    ...(download ? { download: '1' } : {})
  });
  return `${IMAGE_FILE_PATH}?${query}`;
}

export function mediaItems(block) {
  const meta = isRecord(block?.meta) ? block.meta : {};
  const originalValues = Array.isArray(meta.originals) ? meta.originals : [];
  const content = Array.isArray(block?.content) ? block.content : [];
  const normalizedParts = isLayerResult(block) && Array.isArray(meta.images)
    ? meta.images.map(attachment => ({ attachment })) : content.filter(part => isRecord(part) && part.type === 'image');
  const transparentRequested = argsOf(block).background === 'transparent';
  if (originalValues.length) {
    const items = [];
    const seen = new Set();
    const count = Math.max(originalValues.length, normalizedParts.length);
    for (let index = 0; index < count; index++) {
      const original = originalItem(originalValues[index]);
      const fallback = normalizedImage(normalizedParts[index]);
      const item = original ?? (fallback ? {
        kind: 'normalized', id: fallback.attachmentId, name: fallback.name, mediaType: fallback.mediaType,
        bytes: fallback.bytes, width: fallback.width, height: fallback.height, attachment: fallback
      } : undefined);
      if (!item) continue;
      const details = mediaResultDetails(originalValues[index], transparentRequested);
      const key = details.zIndex === undefined ? item.id : `layer:${details.zIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...item, ...details, key });
    }
    return items;
  }
  if (!content.length) return [];
  const seen = new Set();
  const images = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'image') continue;
    const ref = normalizedImage(part);
    if (!ref || seen.has(ref.attachmentId)) continue;
    seen.add(ref.attachmentId);
    images.push({
      kind: 'normalized', id: ref.attachmentId, key: ref.attachmentId, name: ref.name, mediaType: ref.mediaType,
      bytes: ref.bytes, width: ref.width, height: ref.height, attachment: ref
    });
  }
  return images;
}

export function mediaFallbackCount(block) {
  const originals = isRecord(block?.meta) && Array.isArray(block.meta.originals) ? block.meta.originals : [];
  return originals.filter(value => originalItem(value) === undefined).length;
}

export function mediaModel(block) {
  return isRecord(block?.meta) && typeof block.meta.model === 'string' ? block.meta.model : '';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(bytes < 10000 ? 1 : 0)} KB`;
  return `${(bytes / 1000000).toFixed(bytes < 10000000 ? 1 : 0)} MB`;
}

export function imageDimensions(item) {
  return item.width > 0 && item.height > 0 ? `${item.width}×${item.height} · ` : '';
}

export function triggerMediaDownload(url, name) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}
