// 图片大图查看器：原生 dialog、Esc 关闭、缩放与滚动查看。
export function MediaLightbox({ viewer, onClose }) {
  const dialog = react.useRef(null);
  const viewport = react.useRef(null);
  const [zoom, setZoom] = react.useState(1);
  react.useEffect(() => {
    const node = dialog.current;
    if (!node) return undefined;
    if (typeof node.showModal === 'function' && !node.open) node.showModal();
    const cancel = event => { event.preventDefault(); onClose(); };
    node.addEventListener('cancel', cancel);
    return () => {
      node.removeEventListener('cancel', cancel);
      if (node.open) node.close();
    };
  }, [onClose]);
  react.useEffect(() => {
    if (zoom !== 1 || !viewport.current) return;
    viewport.current.scrollLeft = 0;
    viewport.current.scrollTop = 0;
  }, [zoom]);
  return h('dialog', { ref: dialog, className: 'vcp-media-lightbox', 'aria-label': `查看大图：${viewer.label}`, onClose },
    h('div', { className: 'vcp-media-lightbox-toolbar' },
      h('button', { type: 'button', 'aria-disabled': zoom === 1, onClick: () => { if (zoom > 1) setZoom(value => Math.max(1, value - 0.5)); }, 'aria-label': '缩小' }, '−'),
      h('span', { role: 'status' }, `${Math.round(zoom * 100)}%`),
      h('button', { type: 'button', 'aria-disabled': zoom === 4, onClick: () => { if (zoom < 4) setZoom(value => Math.min(4, value + 0.5)); }, 'aria-label': '放大' }, '+'),
      h('button', { type: 'button', 'aria-disabled': zoom === 1, onClick: () => { if (zoom > 1) setZoom(1); } }, '重置'),
      h('a', { className: 'vcp-media-action', href: viewer.src, download: viewer.downloadName ?? viewer.label }, '下载'),
      h('button', { type: 'button', className: 'vcp-media-lightbox-close', onClick: onClose, 'aria-label': '关闭大图' }, '×')),
    h('div', { ref: viewport, className: 'vcp-media-lightbox-viewport' },
      h('div', { style: { width: `${zoom * 100}%`, height: `${zoom * 100}%` } },
        h('img', { src: viewer.src, alt: viewer.label, draggable: false, 'data-transparent': viewer.transparent || undefined }))));
}
