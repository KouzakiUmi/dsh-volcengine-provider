// volc_imagine 的会话图片渲染壳；数据解析与大图组件分别在同域模块中。
const MEDIA_STYLES = `
.vcp-media-card{display:grid;gap:12px;width:100%;max-width:720px;min-width:0;box-sizing:border-box;padding:14px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l4));border-radius:12px;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit}
.vcp-media-card *{box-sizing:border-box}.vcp-media-card :focus-visible,.vcp-media-lightbox :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:2px}
.vcp-media-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}.vcp-media-heading{display:grid;gap:3px;min-width:0}.vcp-media-title{font-size:14px;font-weight:650}.vcp-media-summary,.vcp-media-caption,.vcp-media-detail{display:flex;gap:6px;flex-wrap:wrap;min-width:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.vcp-media-status{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l4));border-radius:999px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-2));font-size:11px;color:var(--dsw-alias-label-secondary)}.vcp-media-status[data-tone=success]{color:var(--dsw-alias-state-success-primary)}.vcp-media-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.vcp-media-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:10px;min-width:0}.vcp-media-item{display:grid;gap:6px;min-width:0}.vcp-media-preview{display:grid;place-items:center;width:100%;min-height:160px;padding:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l4));border-radius:10px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);cursor:zoom-in;font:inherit}.vcp-media-preview:disabled{cursor:wait}.vcp-media-preview img{display:block;width:100%;height:auto;max-height:420px;object-fit:contain}
.vcp-media-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.vcp-media-action{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:5px 11px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3));border-radius:7px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-decoration:none;cursor:pointer}.vcp-media-action:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}.vcp-media-action:disabled{opacity:.55;cursor:not-allowed}.vcp-media-action[data-primary=true]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground)}
.vcp-media-kind{padding:1px 6px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l4));border-radius:999px;color:var(--dsw-alias-label-primary);font-size:10px}
.vcp-media-progress{width:100%;height:5px}.vcp-media-text{margin:0;max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:12px;line-height:1.6}.vcp-media-details{border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l4));padding-top:8px}.vcp-media-details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}.vcp-media-details-body{display:grid;gap:10px;padding-top:10px}.vcp-media-detail{display:grid;gap:4px}.vcp-media-detail strong{font-size:12px;color:var(--dsw-alias-label-primary)}.vcp-media-id{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;overflow-wrap:anywhere}
.vcp-media-lightbox{padding:0;border:0;border-radius:12px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);max-width:96vw;max-height:94vh;overflow:hidden}.vcp-media-lightbox::backdrop{background:var(--dsw-alias-backdrop,rgba(0,0,0,.72))}.vcp-media-lightbox-toolbar{position:absolute;top:8px;left:8px;right:8px;z-index:1;display:flex;align-items:center;gap:6px}.vcp-media-lightbox-toolbar button{min-width:32px;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1));color:inherit;cursor:pointer}.vcp-media-lightbox-close{margin-left:auto}.vcp-media-lightbox-viewport{width:min(94vw,1200px);height:min(88vh,800px);overflow:auto}.vcp-media-lightbox-viewport img{display:block;width:100%;height:100%;object-fit:contain}
 .vcp-media-preview img[data-transparent],.vcp-media-lightbox img[data-transparent]{background:repeating-conic-gradient(var(--dsw-alias-border-l3,var(--dsw-alias-border-l4)) 0% 25%,var(--dsw-alias-bg-layer-1) 0% 50%) 0 0/16px 16px}
 @media(max-width:420px){.vcp-media-card{padding:10px;gap:10px}.vcp-media-gallery{grid-template-columns:1fr}.vcp-media-preview{min-height:120px}}
@media(prefers-reduced-motion:reduce){.vcp-media-card *{scroll-behavior:auto!important;transition:none!important}}
`;

function installMediaStyles() {
  if (typeof document === 'undefined' || !document.head || !document.createElement) return () => {};
  const element = document.createElement('style');
  element.dataset.volcengineMedia = '';
  element.textContent = MEDIA_STYLES;
  document.head.append(element);
  let active = true;
  return () => { if (active) { active = false; element.remove(); } };
}

function useMediaUrlLoader(props) {
  const urls = react.useRef(new Map());
  const pending = react.useRef(new Map());
  const disposed = react.useRef(false);
  react.useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, []);
  return react.useCallback(async item => {
    if (item.kind === 'original') return imageFileUrl(item);
    if (typeof props.loadImage === 'function') return props.loadImage(item.attachment);
    const sessionId = props.sessionId;
    const binding = typeof sessionId === 'string' ? props.sessions?.binding?.(sessionId) : undefined;
    if (!binding?.session?.readAttachment) throw new Error('当前会话无法读取图片附件');
    const key = `${sessionId}\0${item.id}`;
    if (urls.current.has(key)) return urls.current.get(key);
    if (pending.current.has(key)) return pending.current.get(key);
    const request = (async () => {
      const result = await binding.session.readAttachment(item.id);
      if (result?.ok !== true || result.value?.attachment?.attachmentId !== item.id) throw new Error('图片附件读取失败');
      if (disposed.current) throw new Error('图片视图已卸载');
      const bytes = result.value.data.slice().buffer;
      const url = URL.createObjectURL(new Blob([bytes], { type: result.value.attachment.mediaType }));
      urls.current.set(key, url);
      return url;
    })().finally(() => pending.current.delete(key));
    pending.current.set(key, request);
    return request;
  }, [props.loadImage, props.sessionId, props.sessions]);
}

function MediaPreview({ item, load, onOpen }) {
  const [state, setState] = react.useState({ src: '', error: false, retry: 0 });
  react.useEffect(() => {
    let live = true;
    setState(previous => ({ ...previous, src: '', error: false }));
    load(item).then(src => { if (live) setState(previous => ({ ...previous, src })); })
      .catch(() => { if (live) setState(previous => ({ ...previous, error: true })); });
    return () => { live = false; };
  }, [item.id, load, state.retry]);
  if (state.error) return h('button', { type: 'button', className: 'vcp-media-preview', onClick: () => setState(previous => ({ ...previous, error: false, retry: previous.retry + 1 })) }, '图片加载失败，点击重试');
  if (!state.src) return h('div', { className: 'vcp-media-preview', role: 'status' }, '正在加载图片…');
  const label = mediaItemLabel(item);
  return h('button', { type: 'button', className: 'vcp-media-preview', title: '查看大图', 'aria-label': `查看大图：${label}`, onClick: () => onOpen(mediaViewer(item, state.src)) },
    h('img', { src: state.src, alt: label, loading: 'lazy', 'data-transparent': item.transparent || undefined, onError: () => setState(previous => ({ ...previous, error: true })) }));
}

function mediaViewer(item, src) {
  return { src, label: mediaItemLabel(item), downloadName: item.name, transparent: item.transparent };
}

function MediaAction({ label, onClick, primary = false }) {
  const [state, setState] = react.useState('idle');
  const alive = react.useRef(true);
  react.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return h('button', {
    type: 'button', className: 'vcp-media-action', 'data-primary': primary || undefined,
    disabled: state === 'pending', 'aria-busy': state === 'pending',
    onClick: () => {
      if (state === 'pending') return;
      setState('pending');
      Promise.resolve().then(onClick).then(() => { if (alive.current) setState('idle'); })
        .catch(() => { if (alive.current) setState('failed'); });
    }
  }, state === 'pending' ? '处理中…' : state === 'failed' ? '操作失败，重试' : label);
}

function MediaDetails({ block, items }) {
  const prompt = promptOf(block);
  const text = textOf(block);
  const model = mediaModel(block);
  return h('details', { className: 'vcp-media-details' },
    h('summary', null, '提示词与技术信息'),
    h('div', { className: 'vcp-media-details-body' },
      prompt ? h('section', { className: 'vcp-media-detail' }, h('strong', null, '提示词'), h('pre', { className: 'vcp-media-text', tabIndex: 0 }, prompt)) : null,
      model ? h('div', { className: 'vcp-media-detail' }, h('strong', null, '模型'), h('span', null, model)) : null,
      items.map(item => h('div', { key: item.key, className: 'vcp-media-detail' },
        h('strong', null, item.zIndex !== undefined ? mediaItemLabel(item) : item.kind === 'original' ? '原始文件附件' : '会话图片附件'),
        h('span', null, `${item.name} · ${imageDimensions(item)}${item.mediaType} · ${formatBytes(item.bytes)}`),
        h('span', { className: 'vcp-media-id' }, `attachmentId: ${item.id}`))),
      text ? h('section', { className: 'vcp-media-detail' }, h('strong', null, '工具结果'), h('pre', { className: 'vcp-media-text', tabIndex: 0 }, text)) : null));
}

const MEDIA_PAGE_SIZE = 8;

function LayerDetails({ item }) {
  if (!item.description && !item.bounds && !item.ocr) return null;
  return h('details', { className: 'vcp-media-details' },
    h('summary', null, item.ocr ? '图层信息与富文本 OCR' : '图层信息'),
    item.description ? h('p', { className: 'vcp-media-caption' }, item.description) : null,
    Array.isArray(item.bounds?.absolute) ? h('p', { className: 'vcp-media-caption' }, `底图像素坐标：[${item.bounds.absolute.join(', ')}]`) : null,
    Array.isArray(item.bounds?.normalized) ? h('p', { className: 'vcp-media-caption' }, `归一化坐标：[${item.bounds.normalized.join(', ')}]`) : null,
    item.ocr ? h('pre', { className: 'vcp-media-text', tabIndex: 0 }, JSON.stringify(item.ocr, null, 2)) : null);
}

function mediaDownload(item, load, label, primary = false) {
  return item.kind === 'original'
    ? h('a', { key: `download:${item.key}`, className: 'vcp-media-action', 'data-primary': primary || undefined,
      href: imageFileUrl(item, true), download: item.attachment.name }, label)
    : h(MediaAction, { key: `download:${item.key}`, primary, label: '下载预览图', onClick: async () => triggerMediaDownload(await load(item), item.name) });
}

function MediaGallery({ items, load, onOpen }) {
  return h('div', { className: 'vcp-media-gallery' }, items.map(item => h('div', { key: item.key, className: 'vcp-media-item' },
    h(MediaPreview, { item, load, onOpen }),
    h('div', { className: 'vcp-media-caption' },
      h('span', { className: 'vcp-media-kind' }, item.zIndex !== undefined ? mediaItemLabel(item) : item.kind === 'original' ? '原图' : '预览（规范化）'),
      h('span', null, `${imageDimensions(item)}${item.mediaType} · ${formatBytes(item.bytes)}`)),
    item.zIndex !== undefined ? h('div', { className: 'vcp-media-actions' }, mediaDownload(item, load, item.zIndex === 0 ? '下载底图' : `下载图层 ${item.zIndex}`)) : null,
    h(LayerDetails, { item }))));
}

function MediaPagination({ page, last, setPage }) {
  if (!last) return null;
  return h('nav', { className: 'vcp-media-actions', 'aria-label': '图层分页' },
    h('button', { type: 'button', className: 'vcp-media-action', disabled: page === 0, onClick: () => setPage(page - 1) }, '上一页'),
    h('span', { className: 'vcp-media-caption', 'aria-live': 'polite' }, `第 ${page + 1} / ${last + 1} 页`),
    h('button', { type: 'button', className: 'vcp-media-action', disabled: page === last, onClick: () => setPage(page + 1) }, '下一页'));
}

function VolcImagineToolView(rawProps) {
  const props = mediaViewProps(rawProps);
  const block = props.block;
  const settled = isSettledMediaBlock(props);
  const failed = settled && block?.isError === true;
  const items = settled ? mediaItems(block) : [];
  const fallbackCount = settled ? mediaFallbackCount(block) : 0;
  const prompt = promptOf(block);
  const layered = isLayerResult(block);
  const load = useMediaUrlLoader(props);
  const [viewer, setViewer] = react.useState(null);
  const [copied, setCopied] = react.useState(false);
  const [selectedPage, setPage] = react.useState(0);
  const lastPage = layered ? Math.max(0, Math.ceil(items.length / MEDIA_PAGE_SIZE) - 1) : 0;
  const page = Math.min(selectedPage, lastPage);
  const visible = layered ? items.slice(page * MEDIA_PAGE_SIZE, (page + 1) * MEDIA_PAGE_SIZE) : items;
  const closeViewer = react.useCallback(() => setViewer(null), []);
  react.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const tone = failed ? 'error' : !settled ? 'busy' : items.length ? 'success' : 'neutral';
  const title = layered ? (failed ? '图层拆分失败' : settled ? 'Seedream 图层拆分' : '正在拆分图层…')
    : failed ? '图片生成失败' : settled ? 'Seedream 图片' : prompt ? '正在生成图片…' : '正在接收生图参数…';
  const status = failed ? '失败' : settled ? items.length ? '已完成' : '无图片' : layered ? '拆分中' : '生成中';
  return h('div', { className: 'vcp-media-root', style: { display: 'contents' } },
    h('section', { className: 'vcp-media-card', 'data-testid': 'volc-imagine-card', 'aria-label': title },
      h('header', { className: 'vcp-media-head' },
        h('div', { className: 'vcp-media-heading' }, h('strong', { className: 'vcp-media-title' }, title),
          h('div', { className: 'vcp-media-summary' }, h('span', null, '火山方舟'), mediaModel(block) ? h('span', null, mediaModel(block)) : null,
            items.length ? h('span', null, layered ? `1 张底图 · ${items.length - 1} 个图层` : items[0].kind === 'original' ? '原始文件' : '会话预览') : null)),
        h('span', { className: 'vcp-media-status', 'data-tone': tone, role: 'status' }, status)),
      !settled ? h('div', null, h('progress', { className: 'vcp-media-progress', 'aria-label': layered ? '图层拆分进度' : '图片生成进度' })) : null,
      !settled && prompt ? h('pre', { className: 'vcp-media-text', tabIndex: 0 }, prompt) : null,
      settled && failed ? h('pre', { className: 'vcp-media-text', role: 'alert', tabIndex: 0 }, textOf(block) || '图片工具调用失败。') : null,
      fallbackCount ? h('p', { className: 'vcp-media-caption', role: 'status' }, `${fallbackCount} 张原图不可用，已回退到会话预览。`) : null,
      settled && !failed && items.length ? h(MediaGallery, { items: visible, load, onOpen: setViewer }) : null,
      settled && !failed ? h(MediaPagination, { page, last: lastPage, setPage }) : null,
      settled && !failed && !items.length ? h('pre', { className: 'vcp-media-text', tabIndex: 0 }, textOf(block) || '工具未返回可显示的图片。') : null,
      settled && !failed && items.length ? h('div', { className: 'vcp-media-actions' },
        !layered ? items.map(item => h(MediaAction, { key: `view:${item.key}`, label: items.length === 1 ? '查看大图' : `查看 ${item.name}`, onClick: async () => setViewer(mediaViewer(item, await load(item))) })) : null,
        !layered ? items.map(item => mediaDownload(item, load, items.length === 1 ? '下载原图' : `下载 ${item.name}`, true)) : null,
        prompt ? h(MediaAction, { label: copied ? '已复制提示词' : '复制提示词', onClick: async () => { await navigator.clipboard.writeText(prompt); setCopied(true); } }) : null) : null,
      settled ? h(MediaDetails, { block, items: visible }) : null),
    viewer ? h(MediaLightbox, { viewer, onClose: closeViewer }) : null);
}

export function applyVolcMediaViews(ctx) {
  ctx.effect(installMediaStyles, 'dsh-volcengine-provider: 图片卡片样式');
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'volc_imagine'
  }, VolcImagineToolView));
}
