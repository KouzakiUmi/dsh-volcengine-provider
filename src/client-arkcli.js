const ARKCLI_VIEW_STATES = ['ready', 'missing', 'installing', 'failed', 'unsupported', 'configured-error', 'check-error'];

function parseArkCliView(value) {
  if (!ARKCLI_VIEW_STATES.includes(value?.state) || typeof value.platform !== 'string'
    || !/^[\w-]{3,36}$/u.test(value.platform) || (value.version !== undefined
    && (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.version)))) throw new Error('ArkCli 状态格式错误');
  if (['missing', 'installing', 'failed'].includes(value.state) && !value.version) throw new Error('缺少 ArkCli 发行版本');
  if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 250)) throw new Error('ArkCli 提示格式错误');
  return value;
}

function useArkCliSetup(client, visible) {
  const [view, setView] = react.useState({ state: 'checking' });
  const [pending, setPending] = react.useState(false);
  const busy = react.useRef(null);
  react.useEffect(() => () => { busy.current = null; }, [client]);
  const command = react.useCallback(async (request) => {
    if (busy.current) return;
    const token = {};
    busy.current = token;
    setPending(true);
    try {
      const next = parseArkCliView(await client.invoke(request));
      if (busy.current === token) setView(next);
    } catch {
      let recovered;
      // A lost start/cancel reply may be followed by a working job; read its state before retrying.
      if (request.op !== 'arkCliStatus' && busy.current === token) {
        try { recovered = parseArkCliView(await client.invoke({ op: 'arkCliStatus' })); }
        catch { /* Show the status retry action. */ }
      }
      if (busy.current === token) setView(previous => recovered ?? (previous.state === 'installing'
        ? { ...previous, disconnected: true } : { state: 'offline' }));
    } finally {
      if (busy.current === token) { busy.current = null; setPending(false); }
    }
  }, [client]);
  const refresh = react.useCallback(() => command({ op: 'arkCliStatus' }), [command]);
  react.useEffect(() => { if (visible) void refresh(); }, [visible, refresh]);
  react.useEffect(() => {
    if (!visible || view.state !== 'installing' || pending) return undefined;
    const timer = setTimeout(refresh, view.disconnected ? 3500 : 1000);
    return () => clearTimeout(timer);
  }, [visible, view, pending, refresh]);
  return {
    view, pending, refresh,
    blocked: ['missing', 'failed', 'installing', 'unsupported', 'configured-error'].includes(view.state),
    install: () => command({ op: 'installArkCli', platform: view.platform, version: view.version }),
    cancel: () => command({ op: 'cancelArkCliInstall' })
  };
}

function ArkCliSetup({ setup, disabled }) {
  const { view, pending, refresh, install, cancel } = setup;
  if (view.state === 'ready') return view.source === 'managed'
    ? h('p', { style: style.muted, role: 'status' }, `ArkCli ${view.version} 已安装，可开始网页登录。`) : null;
  if (view.state === 'checking') return h('p', { style: style.muted, role: 'status' }, '正在检测 ArkCli…');
  const canInstall = ['missing', 'failed'].includes(view.state);
  const installing = view.state === 'installing';
  const help = {
    'missing': '当前 DSH Host 未找到 ArkCli；网页登录和拉取官方模型目录需要它。',
    'failed': view.message || 'ArkCli 安装未完成。',
    'unsupported': `当前 DSH Host（${view.platform}）没有匹配的一键安装包。可在宿主内安装 ArkCli，并通过 arkCliPath 指定原生文件。`,
    'configured-error': 'arkCliPath 未指向可执行的原生文件。请修正路径，或清空它后重新检测。',
    'check-error': '无法检测 ArkCli。请检查 DSH Host 的本地文件访问。',
    'offline': '暂时读不到 ArkCli 状态，请重新检测。',
    'installing': view.disconnected ? '正在重新读取 ArkCli 安装进度…' : `正在下载并校验 ArkCli ${view.version}…`
  };
  const button = (onClick, label, variant = style.btn) => h('button', {
    type: 'button', style: variant, disabled: disabled || pending, onClick
  }, label);
  return h('div', { className: 'vcp-confirm', 'aria-label': 'ArkCli 安装' },
    h('p', { style: style.muted, role: installing ? 'status' : 'alert' }, help[view.state]),
    canInstall ? h('p', { style: style.muted }, `将从 npm 下载官方 ${view.platform} 版 ${view.version} 到当前插件的数据目录，不修改全局 PATH。`) : null,
    h('div', { className: 'vcp-actions' },
      installing ? button(cancel, '取消安装') : null,
      canInstall ? button(install, view.state === 'failed' ? '重试安装 ArkCli' : '安装官方 ArkCli', style.primary) : null,
      installing ? null : button(refresh, pending ? '检测中…' : '重新检测 ArkCli')));
}
