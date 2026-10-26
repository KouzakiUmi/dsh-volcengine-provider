// dsh-volcengine-provider —— 设置页（Client 侧）
//
// 页面职责：
//   1. 账号管理：新增 / 编辑 / 删除账号。表单只填「凭据引用名」，页面永远拿不到明文密钥。
//   2. 双套餐卡片：Agent 套餐与编程套餐各自独立选择账号、拉取模型目录、刷新额度。
//   3. 网页登录：登录前先讲清副作用，登录中只展示状态与取消入口；
//      官方 CLI 在系统默认浏览器里完成授权，页面既不接触授权码，也不接触 token。
//   4. 模型管理：套餐启用开关、逐模型启用开关、模型参数编辑与恢复默认。
//      套餐与模型的停用只影响路由注册，不会清掉账号选择与已保存的参数。
//
// 数据通道：所有交互都经由 remote.volcengineProvider.invoke({op: ...}) 单一接口往返，
// 返回 {ok, value} 或 {ok:false, error}。协议里只可能出现凭据「引用名」，
// 不出现任何密钥本体，因此前端天然不会回显敏感值。
//
// 实现约束：React createElement（无 JSX）、无 Node 依赖、无第三方新增安装。

// DSH 的 ModuleLoader 在工厂里注入 require；构建产物即浏览器端 CommonJS 工厂。
const react = typeof require === "function" ? require("react") : globalThis.React;
const h = (type, props, ...children) => {
  // Inline theme styles must not hide the native disabled state.
  const control = ['button', 'input', 'select', 'textarea'].includes(type);
  const visibleProps = control && props?.disabled
    ? { ...props, style: { ...props.style, opacity: 0.5, cursor: 'not-allowed' } } : props;
  return react.createElement(type, visibleProps, ...children);
};

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 两张套餐卡片，各自独立。 */
const PLANS = ['agent-plan', 'coding-plan'];

const PLAN_TITLES = {
  'agent-plan': '火山方舟 · Agent 套餐',
  'coding-plan': '火山方舟 · 编程套餐'
};

const PLAN_HINTS = {
  'agent-plan': '展示 5 小时 / 周 / 月 / 日四个窗口，并按能力范围分组；AFP 为绝对额度单位。',
  'coding-plan': '展示 5 小时 / 周 / 月三个额度窗口，接口只给已用百分比。'
};

/** 额度窗口名的展示词。 */
const WINDOW_KIND_LABELS = { '5h': '5 小时', week: '每周', month: '每月', day: '每日' };

/** AFP 额度线的分组标签：不同分组不是同一条账本，必须分开显示。 */
const WINDOW_GROUP_LABELS = {
  text: '文本 / 向量模型额度',
  all: '全能力月度额度',
  'daily-capabilities': '每日能力限额'
};

/** 处于这三个状态时登录流程仍在进行，页面按秒轮询进度。 */
const LOGIN_ACTIVE_STATES = ['launching', 'waiting', 'verifying'];
// UI-only sentinel: never sent as an account ID to the host.
const NEW_LOGIN_ACCOUNT = '__new__';

const LOGIN_STATE_LABELS = {
  idle: '尚未开始登录。',
  launching: '正在启动官方登录窗口…',
  waiting: '请在官方窗口中完成登录。',
  verifying: '正在验证登录结果…',
  success: '登录成功，凭据已保存。',
  cancelled: '登录已取消。',
  error: '登录失败。'
};

/**
 * 官方授权链接的放行规则：主机 → 允许的路径前缀。
 * 用于兼容旧 Host 状态；当前 Host 由受控桥打开链接，不向 Client 下发登录 URL。
 * 用 Map 而不是普通对象，避免原型链上的键被误当成白名单。
 */
const SAFE_LOGIN_PATHS = new Map([
  ['ark.volcengine.com', /^(?:\/region:cn-beijing)?\/arkcli\/login\/?$/],
  ['signin.volcengine.com', /^\/authorize\//]
]);

/** 登录方式说明；未知取值直接显示后端给的原文。 */
const AUTH_MODE_LABELS = {
  oauth: 'OAuth 登录（官方 ArkCli）',
  sso: 'OAuth 登录（官方 ArkCli）',
  'arkcli-oauth': 'OAuth 登录（官方 ArkCli）',
  'arkcli-sso': 'OAuth 登录（官方 ArkCli）',
  references: '凭据引用名'
};

/** 模型目录来源标签；未知取值直接显示后端给的原文。 */
const CATALOG_SOURCE_LABELS = {
  'local-snapshot': '本地快照',
  snapshot: '本地快照',
  remote: '官方接口'
};

/**
 * Core 已有的思考档位候选。档位映射字典只接受这些键，其余一律按非法处理。
 * 与 dsh-provider-config 规范里的标准档位保持一致。
 */
const KNOWN_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 模型参数字段标签：保留技术字段名，方便和后端负载逐项对照。 */
const MODEL_FIELD_LABELS = {
  contextWindow: '上下文长度 contextWindow',
  maxTokens: '最大输出 token maxTokens',
  temperature: '温度 temperature'
};

/**
 * 思考模式文案。必须区分两种上游行为：
 *   原生 effort（adaptive）——档位原样交给上游，由上游决定思考量；
 *   固定预算（budget_tokens）——档位先映射成固定 token 预算。
 */
const ADAPTIVE_MODE_OPTIONS = [
  { value: 'inherit', label: '继承目录默认' },
  { value: 'true', label: '原生 effort 模式（adaptive）：档位交给上游决定思考量' },
  { value: 'false', label: '固定预算模式（budget_tokens）：档位映射为固定 token 预算' }
];

/**
 * 思考档位映射的说明。
 *
 * 语义边界必须讲清楚：reasoningEfforts=false 只是「不提供可选思考档位、按模型默认」，
 * 底层可能根本不发 thinking 字段，不能说成强制关闭思考；
 * 真正关闭思考是默认档位选 off、且映射里声明 off:null。
 */
const EFFORTS_HINT = '键是界面档位，值是发往上游的档位字符串；只有 off 可写 null（真正的关闭思考是默认档位选 off 且映射声明 off:null）；reasoningEfforts=false 只表示不提供可选思考档位，底层可能不发 thinking 字段，不等于强制关闭思考。';

/**
 * 固定预算模式上游真正消费的档位。
 * pi-ai 的预算模式只认 off/minimal/low/medium/high，xhigh 与 max 会被折叠成 high，
 * 且不消费映射值本身，所以预算模式下必须由界面拦住这两类写法。
 */
const BUDGET_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high'];

/** 两种思考模式对档位映射的不同要求，切换模式时要说清楚差别。 */
const ADAPTIVE_MODE_HINTS = {
  true: '原生 effort 模式：按 JSON 里声明的映射值原样发给上游。',
  false: `固定预算模式：上游只消费 ${BUDGET_EFFORTS.join('/')}，xhigh/max 会被折叠成 high，非 off 档位的映射值必须与档位同名；已有映射不会被自动删除，需要时请手工调整 JSON。`
};

/** 温度与输出 token 的已知约束：思考开启时上游可能忽略温度。 */
const TEMPERATURE_HINT = '开启思考时上游可能忽略温度；输出 token 还受思考预算与上下文长度约束。';

/**
 * 启动网页登录前必须让用户看到的影响说明。
 * 这几条是登录的真实副作用，缺一条就可能让人以为会覆盖本机 CLI 身份或删掉凭据。
 */
const LOGIN_CONFIRM_NOTES = [
  '登录使用官方 ArkCli 的方舟同设备授权页，由受控启动桥转交 Playwright 打开独立临时 Chrome；完成登录后由官方 CLI 自动接收回调并关闭窗口，无需复制授权码，也不使用日常 Chrome 的配置、扩展或密码管理器。',
  '登录得到的凭据保存在本插件为该账号准备的隔离目录里，不会改变你原有 CLI 的默认身份。',
  '取消登录或删除账号元数据都不会删除已经保存的凭据；需要清理时请自行处理该账号的隔离目录。',
  'OAuth 登录会绑定该账号可用的个人套餐，模型调用与额度查询使用对应套餐的登录身份，无需另外填写 AK/SK。'
];

/** 账号 ID、凭据引用名、Profile 名的取值规则（与 Host 端 state.mjs 保持一致）。 */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PROFILE_PATTERN = /^[\w.-]{1,80}$/;

/** 等待远端服务就绪的上限；超过即报错，不做无限轮询。 */
const SERVICE_DEADLINE_MS = 20000;
/** 登录进度轮询间隔。 */
const LOGIN_POLL_MS = 1000;

// ── 主题样式（只用设计令牌与继承，兼容深浅色） ───────────────────────────────

const style = {
  root: { display: 'flex', flexDirection: 'column', gap: 16 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  card: {
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '14px 16px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
    borderRadius: 'var(--dsw-radius-md, 8px)'
  },
  cardTitle: { margin: 0, fontSize: 14, fontWeight: 600 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px', minWidth: 180 },
  label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
  input: {
    width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '6px 8px',
    borderRadius: 'var(--dsw-radius-sm, 6px)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
    background: 'transparent', color: 'inherit', font: 'inherit'
  },
  btn: {
    padding: '6px 10px', borderRadius: 'var(--dsw-radius-sm, 6px)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
    background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit'
  },
  primary: {
    padding: '6px 10px', borderRadius: 'var(--dsw-radius-sm, 6px)',
    border: '1px solid var(--dsw-alias-brand-primary, rgba(59,130,246,.65))',
    background: 'var(--dsw-alias-button-primary-fill, rgba(59,130,246,.16))',
    color: 'var(--dsw-alias-label-primary-foreground, inherit)',
    cursor: 'pointer', font: 'inherit'
  },
  danger: {
    padding: '6px 10px', borderRadius: 'var(--dsw-radius-sm, 6px)',
    border: '1px solid var(--dsw-alias-state-error-primary, rgba(220,38,38,.55))',
    background: 'transparent',
    color: 'var(--dsw-alias-state-error-primary, #dc2626)',
    cursor: 'pointer', font: 'inherit'
  },
  muted: { margin: 0, lineHeight: 1.5, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)', overflowWrap: 'anywhere' },
  error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #dc2626)', overflowWrap: 'anywhere' },
  warn: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary, #b45309)', overflowWrap: 'anywhere' },
  success: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #16a34a)', overflowWrap: 'anywhere' },
  chip: {
    fontSize: 11, padding: '1px 8px', borderRadius: 999, whiteSpace: 'nowrap',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))'
  }
};

// ── 纯函数小工具 ─────────────────────────────────────────────────────────────

/**
 * 把后端消息里的授权码 / token 片段抹掉。
 * 协议本身不传这些值，这里只是前端侧的最后一道保险。
 *
 * @param {unknown} value 任意文本
 * @returns {string} 脱敏后的文本
 */
function redactSecrets(value) {
  if (typeof value !== 'string' || !value) return '';
  return value
    // 形如 code=… / access_token=… / authorization_code=… 的键值对一律抹掉值。
    .replace(/\b(code|access_token|id_token|refresh_token|authorization_code|token)\s*=\s*[^\s&"',;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

/**
 * 统一取出可读的错误文本。
 *
 * @param {unknown} error 抛出的值
 * @returns {string} 脱敏后的错误描述
 */
function describeError(error) {
  if (!error) return '未知错误。';
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof error.message === 'string'
        ? error.message
        : String(error);
  return redactSecrets(raw) || '未知错误。';
}

/**
 * 判断是否属于「设置已被别人改动」的保存冲突。
 *
 * @param {unknown} error 抛出的值
 * @returns {boolean} 是否为 revision 冲突
 */
function isRevisionConflict(error) {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof error?.message === 'string'
        ? error.message
        : String(error ?? '');
  return /设置已改变|请刷新后重试|revision|冲突/i.test(raw);
}

/**
 * 只放行官方授权链接，并且原样转交。
 *
 * 授权 URL 里的查询参数是 OAuth 流程的一部分，改写（哪怕只是删参数）都可能让授权失效，
 * 所以这里只做校验、不做任何重写：通过时直接返回原文。
 *
 * 放行规则：https、无用户名密码、无自定义端口、主机在白名单内，
 * 且 ark.volcengine.com 只允许 /arkcli/login 路径、signin.volcengine.com 只允许 /authorize/ 路径。
 *
 * @param {unknown} value 后端给出的链接
 * @returns {string|null} 可安全渲染的链接，不可信则返回 null
 */
function safeLoginUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  const allowedPath = SAFE_LOGIN_PATHS.get(url.hostname.toLowerCase());
  if (allowedPath === undefined) return null;
  if (!allowedPath.test(url.pathname)) return null;
  return value;
}

/**
 * 格式化时间戳。
 *
 * @param {unknown} value ISO 时间串
 * @returns {string} 本地时间
 */
function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value ?? '');
}

/**
 * 百分比保留一位小数。
 *
 * @param {number} value 数值
 * @returns {string} 文本
 */
function formatPercent(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return Number.isFinite(rounded) ? String(rounded) : '0';
}

/**
 * 归一化登录状态。
 *
 * @param {unknown} value 后端返回的登录对象
 * @returns {{jobId: string|null, accountId: string|null, state: string, message: string, url: string|null, authMode: string|null}} 登录状态
 */
function normalizeLogin(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    jobId: typeof source.jobId === 'string' ? source.jobId : null,
    accountId: typeof source.accountId === 'string' ? source.accountId : null,
    state: typeof source.state === 'string' ? source.state : 'idle',
    message: typeof source.message === 'string' ? redactSecrets(source.message) : '',
    url: typeof source.url === 'string' ? source.url : null,
    authMode: typeof source.authMode === 'string' ? source.authMode : null
  };
}

/**
 * 账号 ID 冲突检查（新增时）。
 *
 * @param {string} id 账号 ID
 * @param {Array<{id: string}>} accounts 现有账号
 * @param {string|null} editingId 正在编辑的账号 ID
 * @returns {boolean} 是否重复
 */
function isDuplicateId(id, accounts, editingId) {
  if (editingId) return false;
  return accounts.some((item) => item && item.id === id);
}

/**
 * 表单校验：只校验引用名与展示字段，不涉及任何密钥本体。
 *
 * @param {object} draft 表单草稿
 * @param {Array<{id: string}>} accounts 现有账号
 * @param {string|null} editingId 正在编辑的账号 ID
 * @returns {string|null} 错误文案，通过校验时返回 null
 */
function validateAccountDraft(draft, accounts, editingId) {
  const id = String(draft?.id ?? '').trim();
  const label = String(draft?.label ?? '').trim();
  if (!ID_PATTERN.test(id)) return '账号 ID 须以小写字母开头，只能包含小写字母、数字与连字符。';
  if (isDuplicateId(id, accounts, editingId)) return '该账号 ID 已存在。';
  if (!label) return '请填写账号名称。';
  if (label.length > 80) return '账号名称过长（最多 80 个字符）。';
  for (const plan of PLANS) {
    const ref = String(draft?.apiKeyRefs?.[plan] ?? '').trim();
    if (ref && !REF_PATTERN.test(ref)) return `${PLAN_TITLES[plan]} 的推理凭据引用名不合法（只允许字母、数字与下划线，且以字母或下划线开头）。`;
  }
  // AK/SK 引用名是可选的：走 OAuth 登录的账号不需要它们；有值时才校验格式。
  const accessKeyRef = String(draft?.accessKeyRef ?? '').trim();
  if (accessKeyRef && !REF_PATTERN.test(accessKeyRef)) return 'AccessKey 引用名不合法。';
  const secretKeyRef = String(draft?.secretKeyRef ?? '').trim();
  if (secretKeyRef && !REF_PATTERN.test(secretKeyRef)) return 'SecretKey 引用名不合法。';
  const profile = String(draft?.cliProfile ?? '').trim();
  if (profile && !PROFILE_PATTERN.test(profile)) return 'ArkCli Profile 名称不合法。';
  return null;
}

/**
 * 把表单草稿整理成后端要的账号对象（只含引用名）。
 *
 * @param {object} draft 表单草稿
 * @returns {object} 账号负载
 */
function accountPayload(draft) {
  const apiKeyRefs = {};
  for (const plan of PLANS) {
    const ref = String(draft?.apiKeyRefs?.[plan] ?? '').trim();
    if (ref) apiKeyRefs[plan] = ref;
  }
  const payload = {
    id: String(draft?.id ?? '').trim(),
    label: String(draft?.label ?? '').trim(),
    apiKeyRefs,
    accessKeyRef: String(draft?.accessKeyRef ?? '').trim(),
    secretKeyRef: String(draft?.secretKeyRef ?? '').trim()
  };
  const profile = String(draft?.cliProfile ?? '').trim();
  if (profile) payload.cliProfile = profile;
  return payload;
}

/**
 * 空表单草稿。
 *
 * @returns {object} 草稿
 */
function emptyDraft() {
  return { id: '', label: '', apiKeyRefs: { 'agent-plan': '', 'coding-plan': '' }, accessKeyRef: '', secretKeyRef: '', cliProfile: '' };
}

/**
 * 由已有账号生成表单草稿。
 *
 * @param {object} account 后端账号对象
 * @returns {object} 草稿
 */
function draftFromAccount(account) {
  return {
    id: String(account?.id ?? ''),
    label: String(account?.label ?? ''),
    apiKeyRefs: {
      'agent-plan': String(account?.apiKeyRefs?.['agent-plan'] ?? ''),
      'coding-plan': String(account?.apiKeyRefs?.['coding-plan'] ?? '')
    },
    accessKeyRef: String(account?.accessKeyRef ?? ''),
    secretKeyRef: String(account?.secretKeyRef ?? ''),
    cliProfile: String(account?.cliProfile ?? '')
  };
}

// 身份只消费后端给出的安全摘要，不枚举或回显未知字段。
function accountName(account) {
  return account?.displayName || account?.label || account?.id || '未知账号';
}

function isOAuth(account) {
  return ['oauth', 'sso', 'arkcli-oauth', 'arkcli-sso'].includes(account?.authMode);
}

function planAuth(account, plan) {
  const oauth = isOAuth(account);
  const bound = Boolean(account?.oauthProfiles?.[plan]);
  const inference = oauth ? bound : Boolean(account?.hasApiKeys?.[plan]);
  const quota = typeof account?.hasQuotaAccess?.[plan] === 'boolean'
    ? account.hasQuotaAccess[plan]
    : oauth ? bound : Boolean(account?.hasQuotaKeys);
  return { oauth, bound, inference, quota };
}

function finiteQuotaNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function busyMessage(key) {
  if (!key) return '';
  const [operation, plan, model] = key.split(':');
  const target = PLAN_TITLES[plan] || '';
  const messages = {
    use: `正在为${target}启用所选账号…`, select: `正在切换${target}的账号…`, models: `正在拉取${target}的模型目录…`,
    quota: `正在查询${target}的额度…`, provider: `正在更新${target}的启用状态…`,
    model: `正在更新模型 ${model} 的启用状态…`, settings: `正在保存模型 ${model} 的参数…`,
    reset: `正在恢复模型 ${model} 的默认参数…`, login: '正在启动官方网页登录…',
    'cancel-login': '正在取消登录…', save: '正在保存账号…', delete: '正在删除账号…'
  };
  return messages[operation] || '正在处理…';
}

// ── 模型管理（客户端侧校验与载荷组装） ────────────────────────────────────────

/**
 * 读取套餐启用状态。旧快照没有 enabled 字段时按启用处理，避免升级后功能被静默关掉。
 *
 * @param {object} snapshot 整份快照
 * @param {string} plan 套餐标识
 * @returns {boolean} 是否启用
 */
function providerEnabledOf(snapshot, plan) {
  const value = snapshot?.enabled?.[plan];
  if (value === undefined || value === null) return true;
  return Boolean(value);
}

/**
 * 把思考档位映射整理成一句可读说明。
 *
 * @param {unknown} efforts 档位映射、false 或 undefined
 * @returns {string} 说明文本
 */
function effortSummary(efforts) {
  if (efforts === false) return '不提供可选思考档位';
  if (!efforts || typeof efforts !== 'object') return '继承目录默认';
  const entries = Object.entries(efforts);
  if (!entries.length) return '继承目录默认';
  return entries.map(([tier, value]) => (tier === 'off' && value === null ? 'off=关闭思考' : `${tier}=${String(value)}`)).join('、');
}

/**
 * 描述某个模型当前的参数覆盖。
 *
 * @param {object} model 目录里的模型对象
 * @returns {string} 说明文本
 */
function describeModelSettings(model) {
  const settings = model?.settings && typeof model.settings === 'object' ? model.settings : {};
  const parts = [];
  if (Number.isFinite(settings.contextWindow)) parts.push(`上下文长度 ${settings.contextWindow}`);
  if (Number.isFinite(settings.maxTokens)) parts.push(`最大输出 ${settings.maxTokens}`);
  if (Number.isFinite(settings.temperature)) parts.push(`温度 ${settings.temperature}`);
  if (Object.hasOwn(settings, 'reasoningEfforts')) parts.push(`思考档位 ${effortSummary(settings.reasoningEfforts)}`);
  if (Object.hasOwn(settings, 'defaultReasoning')) parts.push(`默认档位 ${settings.defaultReasoning === null ? '不强制' : String(settings.defaultReasoning)}`);
  if (Object.hasOwn(settings, 'forceAdaptiveThinking')) parts.push(settings.forceAdaptiveThinking ? '原生 effort 模式' : '固定预算模式');
  return parts.length ? parts.join('，') : '继承目录默认';
}

/**
 * 描述某个模型最终生效的参数。
 *
 * @param {object} model 目录里的模型对象
 * @returns {string} 说明文本，空串表示后端没有给出生效值
 */
function describeEffective(model) {
  const effective = model?.effective && typeof model.effective === 'object' ? model.effective : null;
  if (!effective) return '';
  const parts = [];
  if (Number.isFinite(effective.contextWindow)) parts.push(`上下文长度 ${effective.contextWindow}`);
  if (Number.isFinite(effective.maxTokens)) parts.push(`最大输出 ${effective.maxTokens}`);
  if (Number.isFinite(effective.temperature)) parts.push(`温度 ${effective.temperature}`);
  if (Object.hasOwn(effective, 'reasoningEfforts')) parts.push(`思考档位 ${effortSummary(effective.reasoningEfforts)}`);
  if (Object.hasOwn(effective, 'defaultReasoning')) parts.push(`默认档位 ${effective.defaultReasoning === null ? '不强制' : String(effective.defaultReasoning)}`);
  if (Object.hasOwn(effective, 'forceAdaptiveThinking')) parts.push(effective.forceAdaptiveThinking ? '原生 effort 模式' : '固定预算模式');
  return parts.join('，');
}

/**
 * 由模型对象生成参数草稿。草稿只保存原始覆盖值：留空即表示继承目录默认。
 *
 * @param {object} model 目录里的模型对象
 * @returns {object} 草稿
 */
function modelDraftFrom(model) {
  const settings = model?.settings && typeof model.settings === 'object' ? model.settings : {};
  const efforts = settings.reasoningEfforts;
  let effortsMode = 'inherit';
  let effortsText = '';
  if (efforts === false) effortsMode = 'none';
  else if (efforts && typeof efforts === 'object') {
    effortsMode = 'map';
    effortsText = JSON.stringify(efforts);
  }
  const defaultReasoning = settings.defaultReasoning === undefined
    ? 'inherit'
    : settings.defaultReasoning === null
      ? 'none'
      : String(settings.defaultReasoning);
  const adaptive = settings.forceAdaptiveThinking === undefined
    ? 'inherit'
    : settings.forceAdaptiveThinking === true
      ? 'true'
      : 'false';
  return {
    contextWindow: settings.contextWindow === undefined ? '' : String(settings.contextWindow),
    maxTokens: settings.maxTokens === undefined ? '' : String(settings.maxTokens),
    temperature: settings.temperature === undefined ? '' : String(settings.temperature),
    effortsMode,
    effortsText,
    defaultReasoning,
    adaptive
  };
}

/**
 * 取目录里生效的档位映射（草稿未覆盖时使用）。
 *
 * @param {object} model 目录里的模型对象
 * @returns {unknown} 档位映射、false 或 undefined
 */
function inheritedEfforts(model) {
  // Inheriting removes saved overrides: the effective object still contains those overrides.
  return model?.defaults?.reasoningEfforts;
}

/**
 * 列出当前草稿下可用的思考档位。
 *
 * 自定义映射优先；映射非法时回退到目录里的有效档位，保证界面仍可操作。
 *
 * @param {object} draft 参数草稿
 * @param {object} model 目录里的模型对象
 * @returns {Array<string>} 档位列表
 */
function draftTiers(draft, model) {
  const mode = draft?.effortsMode ?? 'inherit';
  if (mode === 'none') return [];
  if (mode === 'map') {
    try {
      const parsed = JSON.parse(String(draft?.effortsText ?? '').trim() || 'null');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
    } catch {
      // 非法 JSON：交由校验环节报错，这里回退到目录里的有效档位。
    }
  }
  const inherited = inheritedEfforts(model);
  if (inherited && typeof inherited === 'object') return Object.keys(inherited);
  return [];
}

/**
 * 把参数草稿整理成后端负载，并做基础格式校验。
 *
 * 这里只做格式层面的兜底：后端仍会独立校验同一份负载，
 * 前端校验的目的是不让明显非法的值发出去、并在界面上直接说明原因。
 *
 * @param {object} draft 参数草稿
 * @param {object} model 目录里的模型对象
 * @returns {{settings: object|null, error: string|null}} 负载或错误说明
 */
function parseModelSettings(draft, model) {
  const problems = [];
  const settings = {};
  const text = (key) => String(draft?.[key] ?? '').trim();

  for (const key of ['contextWindow', 'maxTokens']) {
    const raw = text(key);
    if (!raw) continue; // 空值＝继承目录默认，不写进负载。
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      problems.push(`${MODEL_FIELD_LABELS[key]} 须为正整数。`);
      continue;
    }
    settings[key] = value;
  }

  const temperature = text('temperature');
  if (temperature) {
    const value = Number(temperature);
    if (!Number.isFinite(value) || value < 0 || value > 1) problems.push('温度 temperature 须为 0 到 1 之间的数值。');
    else settings.temperature = value;
  }

  const effortsMode = draft?.effortsMode ?? 'inherit';
  // 生效中的档位映射：自定义映射用草稿里的值，继承时用目录里的有效值。
  let effortsMap = null;
  if (effortsMode === 'none') {
    settings.reasoningEfforts = false;
  } else if (effortsMode === 'map') {
    const effortProblems = [];
    let parsed = null;
    try {
      parsed = JSON.parse(text('effortsText') || 'null');
    } catch {
      effortProblems.push('思考档位映射必须是合法 JSON。');
    }
    if (!effortProblems.length) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) effortProblems.push('思考档位映射必须是 JSON 对象。');
    }
    if (!effortProblems.length) {
      const entries = Object.entries(parsed);
      if (entries.some(([tier]) => !KNOWN_EFFORTS.includes(tier))) effortProblems.push(`思考档位只接受 Core 已有档位：${KNOWN_EFFORTS.join(' / ')}。`);
      if (entries.some(([tier, value]) => value === null && tier !== 'off')) effortProblems.push('只有 off 档位允许为 null。');
      if (entries.some(([tier, value]) => tier !== 'off' && (typeof value !== 'string' || !value.trim()))) effortProblems.push('除 off 外的档位必须映射到非空字符串。');
      if (!entries.some(([tier]) => tier !== 'off')) effortProblems.push('至少要声明一个非 off 档位。');
    }
    if (effortProblems.length) problems.push(...effortProblems);
    else {
      settings.reasoningEfforts = parsed;
      effortsMap = parsed;
    }
  } else {
    const inherited = inheritedEfforts(model);
    if (inherited && typeof inherited === 'object') effortsMap = inherited;
  }

  // 固定预算模式的上游只消费 off/minimal/low/medium/high，且不消费映射值本身：
  // xhigh/max 会被折叠成 high，非同名的映射值也不会生效。
  if ((draft?.adaptive ?? 'inherit') === 'false' && effortsMap) {
    const badTiers = Object.keys(effortsMap).filter((tier) => !BUDGET_EFFORTS.includes(tier));
    const badValues = Object.entries(effortsMap)
      .filter(([tier, value]) => tier !== 'off' && value !== tier)
      .map(([tier]) => tier);
    const badOff = Object.entries(effortsMap)
      .filter(([tier, value]) => tier === 'off' && value !== null)
      .map(([tier]) => tier);
    const suffix = effortsMode === 'map'
      ? '；请手工调整 JSON 映射（不会自动删除已有映射）'
      : '；当前档位映射来自目录默认，请改为自定义 JSON 映射';
    if (badTiers.length || badValues.length) {
      problems.push(`预算模式仅支持 ${BUDGET_EFFORTS.join('/')}，非 off 映射值与档位同名${suffix}`);
    }
    if (badOff.length) problems.push(`预算模式下 off 档位只能为空值（null）${suffix}`);
  }

  const defaultReasoning = draft?.defaultReasoning ?? 'inherit';
  if (defaultReasoning === 'none') {
    settings.defaultReasoning = null;
  } else if (defaultReasoning !== 'inherit') {
    if (!draftTiers(draft, model).includes(defaultReasoning)) problems.push('默认思考档位必须是有效档位，且要与档位映射一致。');
    else settings.defaultReasoning = defaultReasoning;
  }

  const adaptive = draft?.adaptive ?? 'inherit';
  if (adaptive === 'true') settings.forceAdaptiveThinking = true;
  else if (adaptive === 'false') settings.forceAdaptiveThinking = false;

  if (problems.length) return { settings: null, error: problems.join(' ') };
  return { settings, error: null };
}

// ── 展示组件 ─────────────────────────────────────────────────────────────────

/**
 * 一条额度窗口的摘要：剩余百分比、绝对额度、重置时间、范围。
 *
 * @param {object} window 窗口对象
 * @returns {object} 渲染用的 {text, tone}
 */
function windowSummary(window) {
  const parts = [];
  let tone = 'muted';
  const used = finiteQuotaNumber(window?.percent);
  if (used !== null) {
    const remaining = Math.max(0, Math.min(100, 100 - used));
    parts.push(`剩余 ${formatPercent(remaining)}%`);
    if (remaining <= 0) tone = 'error';
    else if (remaining <= 10) tone = 'warn';
  }
  const detail = window?.detail;
  if (detail && finiteQuotaNumber(detail.used) !== null && finiteQuotaNumber(detail.limit) !== null) {
    parts.push(`已用 ${detail.used} / ${detail.limit} ${detail.unit ?? ''}`.trim());
  }
  if (window?.resetsAt) parts.push(`重置于 ${formatTime(window.resetsAt)}`);
  if (detail?.scope) parts.push(`范围 ${detail.scope}`);
  return { text: parts.join(' · ') || '额度数据暂不可用', tone };
}

/**
 * 额度窗口列表：按分组（group）分块展示，不同额度线不混在一起。
 *
 * @param {object} props 组件属性
 * @returns {object} 元素树
 */
function QuotaWindows({ quota }) {
  if (!quota) return h('p', { style: style.muted }, '尚未查询额度，点击「刷新额度」获取当前账号的数据。');
  if (quota.state === 'no-key') {
    // no-key 有两种成因：OAuth 账号没绑定该套餐，或引用名账号缺 AK/SK。
    // 先显示后端给的原因，再补一条网页登录的出路。
    const detail = quota.error ? describeError(quota.error) : '该账号暂无可用的额度鉴权凭据。';
    const hint = /登录/.test(detail) ? '' : ' 可用该账号的「网页登录」完成 OAuth 绑定后重试。';
    return h('p', { style: style.warn }, `额度查询不可用：${detail}${hint}`);
  }
  if (quota.state === 'error') {
    return h('p', { role: 'alert', style: style.error }, `额度查询失败：${describeError(quota.error)}`);
  }
  const windows = Array.isArray(quota.windows) ? quota.windows : [];
  if (!windows.length) return h('p', { style: style.muted }, '该账号没有可展示的额度窗口（可能未订阅此套餐）。');
  const groups = [];
  for (const item of windows) {
    const key = typeof item?.group === 'string' ? item.group : '';
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      group = { key, label: key ? (WINDOW_GROUP_LABELS[key] ?? key) : '', windows: [] };
      groups.push(group);
    }
    group.windows.push(item);
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    groups.map((group, index) => h('div', { key: group.key || `g${index}`, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      group.label ? h('div', { style: { fontSize: 12, fontWeight: 600 } }, group.label) : null,
      group.windows.map((item, position) => {
        const summary = windowSummary(item);
        const percent = finiteQuotaNumber(item?.percent);
        const label = WINDOW_KIND_LABELS[item?.kind] ?? item?.kind ?? '窗口';
        return h('div', { key: `${item?.kind ?? 'w'}-${position}`, style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } },
            h('span', { style: { flexShrink: 0, whiteSpace: 'nowrap' } }, label),
            h('span', { style: { textAlign: 'right', minWidth: 0, ...style[summary.tone] } }, summary.text)),
          percent !== null ? h('progress', {
            max: 100, value: Math.max(0, Math.min(100, 100 - percent)),
            'aria-label': `${label}剩余额度`, 'aria-valuetext': `剩余 ${formatPercent(Math.max(0, Math.min(100, 100 - percent)))}%`,
            style: { width: '100%', height: 8, accentColor: summary.tone === 'error' ? 'var(--dsw-alias-state-error-primary, #dc2626)' : summary.tone === 'warn' ? 'var(--dsw-alias-state-warn-primary, #b45309)' : 'var(--dsw-alias-brand-primary, #3b82f6)' }
          }) : null);
      })
    ))
  );
}

/**
 * 模型参数编辑面板。
 *
 * 空数字＝继承目录默认；档位映射可整段关闭（false）或自定义 JSON；
 * 默认档位分「继承 / 不强制 / 有效档位」三态；思考模式分「继承 / 原生 effort / 固定预算」。
 *
 * @param {object} props 组件属性
 * @returns {object} 元素树
 */
function ModelSettingsEditor({ model, draft, error, disabled, onChange, onSave, onCancel }) {
  const stackedField = { ...style.field, flex: '0 0 auto', minWidth: 0 };
  const effortsMode = draft?.effortsMode ?? 'inherit';
  const tiers = draftTiers(draft, model);
  const numberField = (key, label) => h('label', { style: style.field },
    h('span', { style: style.label }, label),
    h('input', {
      type: 'text', inputMode: 'numeric', style: style.input, value: draft?.[key] ?? '', disabled,
      'aria-label': label, placeholder: '留空表示继承目录默认', autoComplete: 'off', spellCheck: false,
      onChange: (event) => onChange({ [key]: event.target.value })
    }));
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))', borderRadius: 'var(--dsw-radius-sm, 6px)' } },
    h('div', { style: { fontWeight: 600, fontSize: 13 } }, `模型参数：${model?.name || model?.id}`),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      numberField('contextWindow', MODEL_FIELD_LABELS.contextWindow),
      numberField('maxTokens', MODEL_FIELD_LABELS.maxTokens),
      numberField('temperature', MODEL_FIELD_LABELS.temperature)),
    h('p', { style: style.muted }, TEMPERATURE_HINT),
    h('label', { style: stackedField },
      h('span', { style: style.label }, '思考档位映射 reasoningEfforts'),
      h('select', {
        style: style.input, value: effortsMode, disabled, 'aria-label': '思考档位映射 reasoningEfforts',
        onChange: (event) => onChange({ effortsMode: event.target.value })
      },
        h('option', { value: 'inherit' }, '继承目录默认'),
        h('option', { value: 'none' }, '不提供可选思考档位（false）'),
        h('option', { value: 'map' }, '自定义 JSON 映射'))),
    effortsMode === 'none'
      ? h('p', { style: style.muted }, 'reasoningEfforts=false 表示不提供可选思考档位（按模型默认）；底层可能不发 thinking 字段，不等于强制关闭思考。真正关闭思考需要把默认档位设为 off 且映射声明 off:null。')
      : null,
    effortsMode === 'map'
      ? h('label', { style: stackedField },
        h('span', { style: style.label }, 'JSON 映射'),
        h('textarea', {
          style: { ...style.input, minHeight: 64 }, value: draft?.effortsText ?? '', disabled,
          'aria-label': 'JSON 映射', spellCheck: false, autoComplete: 'off',
          onChange: (event) => onChange({ effortsText: event.target.value })
        }))
      : null,
    effortsMode === 'map' ? h('p', { style: style.muted }, EFFORTS_HINT) : null,
    h('label', { style: stackedField },
      h('span', { style: style.label }, '默认思考档位 defaultReasoning'),
      h('select', {
        style: style.input, value: draft?.defaultReasoning ?? 'inherit', disabled,
        'aria-label': '默认思考档位 defaultReasoning',
        onChange: (event) => onChange({ defaultReasoning: event.target.value })
      },
        h('option', { value: 'inherit' }, '继承目录默认'),
        h('option', { value: 'none' }, '不强制默认档位（null）'),
        tiers.map((tier) => h('option', { key: tier, value: tier }, tier)))),
    h('label', { style: stackedField },
      h('span', { style: style.label }, '思考模式 forceAdaptiveThinking'),
      h('select', {
        style: style.input, value: draft?.adaptive ?? 'inherit', disabled,
        'aria-label': '思考模式 forceAdaptiveThinking',
        onChange: (event) => onChange({ adaptive: event.target.value })
      },
        ADAPTIVE_MODE_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
    ADAPTIVE_MODE_HINTS[draft?.adaptive] ? h('p', { style: style.muted }, ADAPTIVE_MODE_HINTS[draft.adaptive]) : null,
    error ? h('p', { role: 'alert', style: style.error }, error) : null,
    h('div', { style: style.row },
      h('button', { type: 'button', style: style.primary, disabled, onClick: onSave }, '保存参数'),
      h('button', { type: 'button', style: style.btn, disabled, onClick: onCancel }, '取消'))
  );
}

/**
 * 目录里的单个模型：启用开关 + 参数入口。
 *
 * 停用的模型同样可以编辑参数；重新启用时后端会保留已保存的参数。
 *
 * @param {object} props 组件属性
 * @returns {object} 元素树
 */
function ModelRow({ model, disabled, routingError, editor, draftError, onToggle, onOpenEditor, onCloseEditor, onChangeDraft, onSave, onReset }) {
  const enabled = model?.enabled !== false;
  const editing = editor?.modelId === model?.id;
  const effective = describeEffective(model);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))', borderRadius: 'var(--dsw-radius-sm, 6px)' } },
    h('div', { style: style.row },
      h('input', {
        type: 'checkbox', checked: enabled, disabled,
        'aria-label': `启用模型 ${model?.id ?? ''}`,
        onChange: (event) => onToggle(model, Boolean(event.target.checked))
      }),
      h('span', { style: { fontWeight: 500 } }, model?.name || model?.id),
      h('span', { style: style.chip }, model?.id),
      model?.capabilityUnverified ? h('span', { style: style.chip }, '能力未核实') : null,
      enabled ? null : h('span', { style: style.chip }, '已停用'),
      h('button', { type: 'button', style: style.btn, disabled, 'aria-label': `模型参数 ${model?.id ?? ''}`, onClick: () => (editing ? onCloseEditor() : onOpenEditor(model)) }, editing ? '收起参数' : '参数'),
      h('button', { type: 'button', style: style.btn, disabled, 'aria-label': `恢复默认 ${model?.id ?? ''}`, title: '清除全部参数覆盖并恢复模型启用状态', onClick: () => onReset(model) }, enabled ? '恢复默认' : '恢复默认并启用')),
    h('p', { style: style.muted }, `当前参数：${describeModelSettings(model)}`),
    effective ? h('p', { style: routingError ? style.warn : style.muted }, `${routingError ? '已保存配置（路由尚未生效）' : '生效值'}：${effective}`) : null,
    editing
      ? h(ModelSettingsEditor, {
        model, draft: editor.draft, error: draftError, disabled,
        onChange: onChangeDraft, onSave: () => onSave(model), onCancel: onCloseEditor
      })
      : null
  );
}

/**
 * 一张套餐卡片。
 *
 * 套餐启用状态、账号选择、模型开关与模型参数彼此独立：
 * 停用套餐只影响路由注册，不会清掉账号选择，也不会删掉已保存的模型参数。
 *
 * @param {object} props 组件属性
 * @returns {object} 元素树
 */
function PlanCard({ plan, snapshot, rawQuota, busy, quotaBusy, onSelect, onModels, onQuota, onToggleProvider, onToggleModel, onSaveModelSettings, onResetModelSettings }) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const activeId = snapshot?.active?.[plan] ?? null;
  const account = accounts.find((item) => item?.id === activeId) ?? null;
  const catalog = (Array.isArray(snapshot?.catalogs) ? snapshot.catalogs : [])
    .find((item) => item?.plan === plan && item?.accountId === activeId) ?? null;
  const route = snapshot?.routes?.[plan] ?? null;
  const appliedAccount = snapshot?.appliedAccounts?.[plan];
  // 额度是按账号查的：账号换了就不要再展示上一个账号的窗口。
  const quota = rawQuota && rawQuota.accountId === activeId ? rawQuota : null;
  const disabled = busy !== null;
  const auth = planAuth(account, plan);
  const canPullModels = Boolean(account && (auth.oauth ? auth.bound : account.cliProfile));
  // 旧快照没有 enabled 字段时按启用处理。
  const providerEnabled = providerEnabledOf(snapshot, plan);
  // 旧快照的目录没有 models 明细：安全地当作「没有列表」展示。
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const enabledCount = Number.isFinite(catalog?.enabledCount)
    ? catalog.enabledCount
    : models.filter((item) => item?.enabled !== false).length;

  // 参数编辑状态：同一时刻只展开一个模型，避免把卡片撑得过长。
  const [storedEditor, setEditor] = react.useState(null);
  const [modelsOpen, setModelsOpen] = react.useState(false);
  const [draftError, setDraftError] = react.useState(null);
  // 渲染与提交时立即隔离旧账号草稿，effect 再清掉本地状态。
  const editor = storedEditor?.accountId === activeId ? storedEditor : null;
  react.useEffect(() => {
    setEditor(null);
    setDraftError(null);
    setModelsOpen(false);
  }, [activeId]);

  const editedModel = editor ? models.find((item) => item?.id === editor.modelId) ?? null : null;
  const editedSignature = JSON.stringify(editedModel?.settings ?? null);

  // 保存或恢复默认后，后端会给出新的覆盖值；此时把草稿对齐到最新状态。
  react.useEffect(() => {
    if (!editor || !editedModel) return;
    setEditor((previous) => {
      if (!previous || previous.modelId !== editedModel.id) return previous;
      if (previous.synced === editedSignature) return previous;
      return { ...previous, draft: modelDraftFrom(editedModel), synced: editedSignature };
    });
  }, [editor?.modelId, editedModel, editedSignature]);

  const openEditor = (model) => {
    setEditor({ accountId: activeId, modelId: model.id, draft: modelDraftFrom(model), synced: JSON.stringify(model?.settings ?? null) });
    setDraftError(null);
  };

  const closeEditor = () => {
    setEditor(null);
    setDraftError(null);
  };

  const changeDraft = (patch) => {
    setEditor((previous) => {
      if (!previous) return previous;
      const draft = { ...previous.draft, ...patch };
      if (patch.effortsMode !== undefined && !['inherit', 'none'].includes(draft.defaultReasoning)
        && !draftTiers(draft, editedModel).includes(draft.defaultReasoning)) draft.defaultReasoning = 'inherit';
      return { ...previous, draft };
    });
    setDraftError(null);
  };

  // 校验不通过时不发 RPC：只在界面上说明原因。
  const saveEditor = (model) => {
    if (!editor || !activeId) return;
    const parsed = parseModelSettings(editor.draft, model);
    if (parsed.error) {
      setDraftError(parsed.error);
      return;
    }
    setDraftError(null);
    onSaveModelSettings(plan, activeId, model.id, parsed.settings);
  };

  const resetModel = (model) => {
    if (!activeId) return;
    onResetModelSettings(plan, activeId, model.id);
  };

  return h('section', { style: style.card },
    h('h3', { style: style.cardTitle }, PLAN_TITLES[plan]),
    account ? h('p', { style: { margin: 0, fontSize: 13 } }, `${snapshot?.routingError ? '所选账号' : '当前账号'}：${accountName(account)}`) : null,
    snapshot?.routingError ? h('p', { style: style.warn }, appliedAccount === undefined
      ? '实际生效账号暂不可确认，请排除路由错误后重试。'
      : appliedAccount ? `实际生效账号：${accountName(appliedAccount)}（${appliedAccount.id}），路由更新尚未完成。` : '该套餐当前没有已生效的模型路由。') : null,
    h('div', { style: style.row },
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
        h('input', {
          type: 'checkbox', checked: providerEnabled, disabled,
          'aria-label': `启用${PLAN_TITLES[plan]}`,
          onChange: (event) => onToggleProvider(plan, Boolean(event.target.checked))
        }),
        h('span', null, '启用该套餐')),
      providerEnabled
        ? h('span', { style: style.chip }, !account ? '待选择账号' : !auth.inference ? '待完成鉴权' : '套餐已启用')
        : h('span', { style: style.chip }, '已停用：不注册模型路由（账号选择与模型参数保留）')),
    h('div', { style: style.row },
      h('label', { style: style.label }, '使用账号'),
      h('select', {
        style: { ...style.input, width: 'auto', minWidth: 160 },
        value: activeId ?? '',
        'aria-label': `${PLAN_TITLES[plan]}使用账号`,
        disabled: disabled,
        onChange: (event) => onSelect(plan, event.target.value || null)
      },
        h('option', { value: '' }, '未选择'),
        accounts.map((item) => h('option', { key: item.id, value: item.id }, `${accountName(item)}${item.label && item.label !== accountName(item) ? ` · 备注：${item.label}` : ''}（${item.id}）`)))),
    h('div', { style: style.row },
      h('button', { type: 'button', style: style.btn, disabled: disabled || !canPullModels, onClick: () => onModels(plan) }, busy === `models:${plan}` ? '正在拉取模型…' : '拉取模型'),
      h('button', { type: 'button', style: style.btn, disabled: disabled || quotaBusy || !auth.quota, onClick: () => onQuota(plan) }, quotaBusy ? '正在刷新额度…' : quota?.state === 'error' ? '重试额度查询' : '刷新额度')),
    account ? h('div', { style: style.row },
      h('span', { style: style.chip }, `鉴权来源：${auth.oauth ? '官方网页登录（OAuth）' : '凭据引用'}`),
      h('span', { style: style.chip }, auth.oauth ? `套餐绑定：${auth.bound ? '已绑定' : '未绑定'}` : `推理凭据：${auth.inference ? '已配置' : '未配置'}`),
      h('span', { style: style.chip }, `额度鉴权：${auth.oauth ? (auth.quota ? 'OAuth 已就绪' : 'OAuth 未就绪') : auth.quota ? 'AK/SK 已配置' : '未配置'}`)) : null,
    !account ? h('p', { style: style.muted }, '该套餐尚未选择账号，请选择已登录的账号。') : null,
    account && auth.oauth && !auth.bound
      ? h('p', { style: style.warn }, '此账号尚未绑定该套餐，暂不能拉取模型或查询额度。请先确认已订阅此个人套餐，再到上方账号区重新网页登录更新绑定。')
      : null,
    account && !auth.oauth && !canPullModels
      ? h('p', { style: style.muted }, '当前可使用本地模型快照；远端目录需要官方网页登录或该账号隔离目录内的 CLI Profile，配置前无法拉取。') : null,
    account && !auth.oauth && !auth.inference
      ? h('p', { style: style.warn }, '该账号尚未配置此套餐的推理凭据，请在账号高级配置中填写引用名，或使用网页登录。')
      : null,
    account && !auth.quota && (!auth.oauth || auth.bound)
      ? h('p', { style: style.warn }, auth.oauth ? '该套餐的登录身份暂不可查询额度，请重新登录后重试。' : '该账号缺少 AK/SK 凭据引用，额度窗口无法查询。')
      : null,
    h('details', null,
      h('summary', { style: style.muted }, '套餐高级信息'),
      h('p', { style: style.muted }, PLAN_HINTS[plan]),
      account ? h('p', { style: style.muted }, `本地账号 ID：${account.id}${auth.oauth && auth.bound ? ` · 套餐 Profile：${account.oauthProfiles[plan]}` : ''}`) : null,
      route ? h('p', { style: style.muted }, `模型路由：${route}`) : null,
      catalog ? h('p', { style: style.muted }, `模型目录：${catalog.count} 个模型（来源 ${CATALOG_SOURCE_LABELS[catalog.source] ?? catalog.source}${catalog.updatedAt ? `，更新于 ${formatTime(catalog.updatedAt)}` : ''}）。`) : null),
    catalog?.error ? h('p', { role: 'alert', style: style.error }, describeError(catalog.error)) : null,
    models.length
      ? h('details', { open: modelsOpen },
        h('summary', {
          style: { cursor: 'pointer', fontSize: 13 },
          onClick: (event) => {
            // 自己接管开合，避免浏览器原生开合与受控状态打架。
            if (event?.preventDefault) event.preventDefault();
            setModelsOpen((previous) => !previous);
          }
        }, `模型列表（已启用 ${enabledCount} / 共 ${models.length}）`),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
          models.map((model, index) => h(ModelRow, {
            key: model?.id ?? `model-${index}`,
            model, disabled, routingError: snapshot?.routingError, editor, draftError,
            onToggle: (item, enabled) => onToggleModel(plan, activeId, item.id, enabled),
            onOpenEditor: openEditor,
            onCloseEditor: closeEditor,
            onChangeDraft: changeDraft,
            onSave: saveEditor,
            onReset: resetModel
          }))))
      : h('p', { style: style.muted }, catalog
        ? '该目录暂无模型明细（旧缓存可能没有模型列表，重新拉取模型后可用）。'
        : !account ? '选择账号后显示该套餐的模型目录。' : '模型目录：尚未拉取。'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, 'aria-busy': Boolean(quotaBusy) },
      h('h4', { style: { margin: 0, fontSize: 13 } }, '套餐额度'),
      quotaBusy ? h('p', { role: 'status', style: style.muted }, `正在查询${PLAN_TITLES[plan]}的额度…`) : null,
      quota?.updatedAt ? h('p', { style: style.muted }, `额度更新时间：${formatTime(quota.updatedAt)}`) : null,
      !account ? h('p', { style: style.muted }, '请先登录或添加账号，再为此套餐选择账号。')
        : !quota && !auth.quota ? h('p', { style: style.muted }, '完成此套餐的登录绑定或额度鉴权配置后，即可查询额度。')
        : h(QuotaWindows, { quota }))
  );
}

/**
 * 账号区：账号列表、新增 / 编辑表单、删除二次确认、网页登录状态。
 *
 * @param {object} props 组件属性
 * @returns {object} 元素树
 */
function AccountPanel({ snapshot, editor, confirmDelete, loginConfirm, login, busy, onNew, onEdit, onCancelEdit, onChangeDraft, onSave, onRequestDelete, onConfirmDelete, onCancelDelete, onRequestLogin, onConfirmLogin, onCancelLoginConfirm, onCancelLogin, onUsePlan }) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const disabled = busy !== null;
  const loginActive = LOGIN_ACTIVE_STATES.includes(login.state);
  const loginUrl = safeLoginUrl(login.url);
  // 登录方式挂在账号上（OAuth 绑定 / 凭据引用名），不是整个设置的属性。
  const loginAccount = accounts.find((item) => item?.id === login.accountId) ?? null;
  const authMode = loginAccount?.authMode ?? login.authMode ?? null;

  return h('section', { style: style.card },
    h('h3', { style: style.cardTitle }, '账号管理'),
    h('p', { style: style.muted }, '账号以官方登录身份区分，本地备注仅用于帮助识别。每个套餐可独立选择账号。'),
    accounts.length
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        accounts.map((account) => h('div', { key: account.id, style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))', borderRadius: 'var(--dsw-radius-sm, 6px)' } },
          h('div', { style: style.row },
            h('strong', { style: { fontWeight: 600 } }, accountName(account)),
            account.authMode ? h('span', { style: style.chip }, `凭据来源：${AUTH_MODE_LABELS[account.authMode] ?? account.authMode}`) : null),
          account.label ? h('p', { style: style.muted }, `本地备注：${account.label}`) : null,
          account.identity?.accountId ? h('p', { style: style.muted }, `官方账号 ID：${account.identity.accountId}`) : null,
          account.identity?.userId ? h('p', { style: style.muted }, `官方用户 ID：${account.identity.userId}`) : null,
          isOAuth(account) && !account.identity ? h('p', { style: style.muted }, '官方身份摘要暂不可用，完成网页登录后更新。') : null,
          account.loggedAt ? h('p', { style: style.muted }, `最近登录：${formatTime(account.loggedAt)}`) : null,
          account.credentialError ? h('p', { role: 'alert', style: style.error }, `凭据状态：${describeError(account.credentialError)}`) : null,
          h('div', { style: style.row }, PLANS.map((plan) => h('span', { key: plan, style: style.chip },
            `${plan === 'agent-plan' ? 'Agent' : '编程'}套餐：${snapshot?.active?.[plan] === account.id ? (providerEnabledOf(snapshot, plan) ? '当前使用' : '已选择 · 已停用') : '未选用'}${isOAuth(account) ? ` · ${account.oauthProfiles?.[plan] ? '已绑定' : '未绑定'}` : ''}`))),
          h('div', { style: style.row }, PLANS.map(plan => {
            const selected = snapshot?.active?.[plan] === account.id;
            if (!planAuth(account, plan).inference || (selected && providerEnabledOf(snapshot, plan))) return null;
            return h('button', { key: plan, type: 'button', style: style.primary, disabled: disabled || loginActive,
              onClick: () => onUsePlan(plan, account.id) }, `${selected ? '启用' : '用于'} ${plan === 'agent-plan' ? 'Agent' : '编程'}套餐`);
          })),
          h('details', null,
            h('summary', { style: style.muted }, '账号高级配置与标识'),
            h('p', { style: style.muted }, `本地账号 ID：${account.id}`),
            isOAuth(account)
              ? PLANS.map((plan) => account.oauthProfiles?.[plan] ? h('p', { key: plan, style: style.muted }, `${plan === 'agent-plan' ? 'Agent' : '编程'}套餐 Profile：${account.oauthProfiles[plan]}`) : null)
              : h('div', null,
                h('p', { style: style.muted }, `Agent 套餐推理引用：${account.apiKeyRefs?.['agent-plan'] || '未配置'}`),
                h('p', { style: style.muted }, `编程套餐推理引用：${account.apiKeyRefs?.['coding-plan'] || '未配置'}`),
                h('p', { style: style.muted }, `AK 引用：${account.accessKeyRef || '未配置'} · SK 引用：${account.secretKeyRef || '未配置'}`)),
            account.cliProfile ? h('p', { style: style.muted }, `ArkCli Profile：${account.cliProfile}`) : null),
          h('div', { style: style.row },
            h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onRequestLogin(account.id) }, loginActive ? '登录进行中…' : '网页登录'),
            h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onEdit(account) }, '编辑'),
            confirmDelete === account.id
              ? h('button', { type: 'button', style: style.danger, disabled: disabled || loginActive, onClick: () => onConfirmDelete(account.id) }, '确认删除')
              : h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onRequestDelete(account.id) }, '删除'),
            confirmDelete === account.id
              ? h('button', { type: 'button', style: style.btn, disabled: disabled, onClick: onCancelDelete }, '取消')
              : null),
          loginConfirm === account.id
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))', borderRadius: 'var(--dsw-radius-sm, 6px)' } },
              h('div', { style: { fontWeight: 600, fontSize: 13 } }, `开始网页登录：${accountName(account)}`),
              h('ul', { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
                LOGIN_CONFIRM_NOTES.map((note, index) => h('li', { key: index, style: style.muted }, note))),
              h('div', { style: style.row },
                h('button', { type: 'button', style: style.primary, disabled: disabled, onClick: () => onConfirmLogin(account.id) }, '确认并打开官方登录页'),
                h('button', { type: 'button', style: style.btn, disabled: disabled, onClick: onCancelLoginConfirm }, '取消')))
            : null)))
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('p', { style: style.muted }, '还没有账号。可直接网页登录，确认后会自动创建本地账号，无需填写账号 ID 或密钥引用。'),
        h('div', { style: style.row },
          h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onRequestLogin(NEW_LOGIN_ACCOUNT) }, '网页登录')),
        loginConfirm === NEW_LOGIN_ACCOUNT ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('strong', null, '创建账号并开始网页登录'),
          h('ul', { style: { margin: 0, paddingLeft: 18 } },
            LOGIN_CONFIRM_NOTES.map((note, index) => h('li', { key: index, style: style.muted }, note))),
          h('div', { style: style.row },
            h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onConfirmLogin(NEW_LOGIN_ACCOUNT) }, '确认并打开官方登录页'),
            h('button', { type: 'button', style: style.btn, disabled, onClick: onCancelLoginConfirm }, '取消'))) : null),
    h('div', { style: style.row },
      accounts.length ? h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onRequestLogin(NEW_LOGIN_ACCOUNT) }, '登录其他账号') : null,
      h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive || editor !== null, onClick: onNew }, '新增账号')),
    accounts.length > 0 && loginConfirm === NEW_LOGIN_ACCOUNT ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('strong', null, '创建独立账号并网页登录'),
      h('p', { style: style.muted }, '使用新的本地账号保存登录结果，不覆盖已有账号或更改当前套餐选择。请在普通浏览器的官方页面确认实际授权身份。'),
      h('ul', { style: { margin: 0, paddingLeft: 18 } }, LOGIN_CONFIRM_NOTES.map((note, index) => h('li', { key: index, style: style.muted }, note))),
      h('div', { style: style.row },
        h('button', { type: 'button', style: style.primary, disabled: disabled || loginActive, onClick: () => onConfirmLogin(NEW_LOGIN_ACCOUNT) }, '确认并打开官方登录页'),
        h('button', { type: 'button', style: style.btn, disabled, onClick: onCancelLoginConfirm }, '取消'))) : null,
    editor ? h(AccountForm, { editor, busy: busy ?? (loginActive ? 'login-active' : null), onChangeDraft, onSave, onCancel: onCancelEdit }) : null,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
      h('div', { style: { fontWeight: 600, fontSize: 13 } }, '网页登录'),
      loginAccount ? h('p', { style: style.muted }, `当前登录账号：${accountName(loginAccount)}（${loginAccount.id}）`) : null,
      authMode ? h('p', { style: style.muted }, `凭据来源：${AUTH_MODE_LABELS[authMode] ?? authMode}`) : null,
      h('p', { style: style.muted }, LOGIN_STATE_LABELS[login.state] ?? login.state),
      login.message ? h('p', { style: style.muted }, login.message) : null,
      loginUrl ? h('a', { href: loginUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 12, color: 'var(--dsw-alias-link, inherit)' } }, '打开官方授权页面') : null,
      loginActive
        ? h('button', { type: 'button', style: style.btn, disabled: disabled || !login.jobId, onClick: onCancelLogin }, login.jobId ? '取消登录' : '同步状态后可取消登录')
        : null)
  );
}

/**
 * 账号表单：只接受凭据引用名。
 *
 * @param {object} props 组件属性
 * @returns {object} 元素树
 */
function AccountForm({ editor, busy, onChangeDraft, onSave, onCancel }) {
  const draft = editor.draft;
  const disabled = busy !== null;
  const field = (label, key, placeholder) => h('label', { style: style.field },
    h('span', { style: style.label }, label),
    h('input', {
      type: 'text', style: style.input, value: draft[key] ?? '',
      // 编辑态下账号 ID 是主键，改名会造成指向漂移，所以锁定。
      disabled: disabled || (key === 'id' && editor.mode === 'edit'),
      placeholder: placeholder ?? '', autoComplete: 'off', spellCheck: false,
      onChange: (event) => onChangeDraft({ [key]: event.target.value })
    }));
  const apiKeyField = (plan, label, placeholder) => h('label', { style: style.field },
    h('span', { style: style.label }, label),
    h('input', {
      type: 'text', style: style.input, value: draft.apiKeyRefs?.[plan] ?? '', disabled,
      placeholder, autoComplete: 'off', spellCheck: false,
      onChange: (event) => onChangeDraft({ apiKeyRefs: { [plan]: event.target.value } })
    }));
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))', borderRadius: 'var(--dsw-radius-sm, 6px)' } },
    h('div', { style: { fontWeight: 600, fontSize: 13 } }, editor.mode === 'edit' ? `编辑账号：${editor.id}` : '新增账号'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      field('账号 ID（小写字母开头）', 'id', 'default'),
      field('本地备注', 'label', '例如：个人账号')),
    h('p', { style: style.muted }, '保存后点击「网页登录」绑定官方账号；使用 OAuth 时无需填写下方的凭据引用。'),
    h('details', null,
      h('summary', { style: style.muted }, '高级配置：凭据引用与 CLI Profile'),
      isOAuth(editor) ? h('p', { style: style.warn }, '此账号当前使用 OAuth，编辑引用不会切换鉴权方式。模型调用与额度查询仍使用已绑定的套餐身份。') : null,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      apiKeyField('agent-plan', 'Agent 套餐推理凭据引用名', '例如：ARKCLI_AGENT_PLAN_API_KEY'),
      apiKeyField('coding-plan', '编程套餐推理凭据引用名', '例如：ARKCLI_CODING_PLAN_API_KEY')),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      field('AccessKey 引用名（可选）', 'accessKeyRef', '例如：VOLC_ACCESSKEY'),
      field('SecretKey 引用名（可选）', 'secretKeyRef', '例如：VOLC_SECRETKEY')),
    h('p', { style: style.muted }, 'AK/SK 引用名只用于查询管控面额度；用「网页登录」完成 OAuth 的账号不需要填写这两项。'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      field('ArkCli Profile（可选）', 'cliProfile', '留空表示不使用'))),
    h('div', { style: style.row },
      h('button', { type: 'button', style: style.primary, disabled: disabled, onClick: onSave }, busy === 'save' ? '保存中…' : '保存'),
      h('button', { type: 'button', style: style.btn, disabled: disabled, onClick: onCancel }, '取消'))
  );
}

/**
 * 设置页主体。
 *
 * @param {object} props 组件属性（client 由 apply 注入）
 * @returns {object} 元素树
 */
function VolcengineProviderSection({ client }) {
  const [snapshot, setSnapshot] = react.useState(null);
  const [loadError, setLoadError] = react.useState(null);
  const [loading, setLoading] = react.useState(true);
  const [busy, setBusy] = react.useState(null);
  const [notice, setNotice] = react.useState(null);
  const [quotas, setQuotas] = react.useState({});
  const [quotaBusy, setQuotaBusy] = react.useState({});
  const quotaPendingRef = react.useRef(new Map());
  const [editor, setEditor] = react.useState(null);
  const [confirmDelete, setConfirmDelete] = react.useState(null);
  const [loginConfirm, setLoginConfirm] = react.useState(null);
  const [login, setLogin] = react.useState({ jobId: null, state: 'idle', message: '', url: null, authMode: null });

  const aliveRef = react.useRef(true);
  const busyRef = react.useRef(null);
  const handledLoginRef = react.useRef(null);
  const readSequenceRef = react.useRef(0);
  const quotaEpochRef = react.useRef(0);
  const accountFingerprintRef = react.useRef(null);

  react.useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  /** 把一次 read 返回的整份快照落到状态里。 */
  const applySnapshot = react.useCallback((value) => {
    if (!aliveRef.current || !value) return;
    // 写操作的新快照使更早发起的 read 失效，避免迟到响应覆盖新状态。
    readSequenceRef.current += 1;
    const fingerprint = JSON.stringify({ active: value.active, accounts: (value.accounts ?? []).map(account => ({
      id: account.id, authMode: account.authMode, loggedAt: account.loggedAt, identity: account.identity,
      profiles: account.oauthProfiles, apiKeyRefs: account.apiKeyRefs, accessKeyRef: account.accessKeyRef,
      secretKeyRef: account.secretKeyRef, hasApiKeys: account.hasApiKeys, hasQuotaAccess: account.hasQuotaAccess
    })) });
    if (accountFingerprintRef.current !== fingerprint) {
      accountFingerprintRef.current = fingerprint;
      quotaEpochRef.current += 1;
      setQuotaBusy({});
      setQuotas({});
    }
    setSnapshot(value);
    setEditor(previous => previous?.mode === 'edit' && !(value.accounts ?? []).some(account => account.id === previous.id) ? null : previous);
    setLoading(false);
    const incoming = value.login ? normalizeLogin(value.login) : null;
    if (incoming) setLogin(incoming);
  }, []);

  /** 重新读取全部状态。 */
  const refresh = react.useCallback(async () => {
    const sequence = ++readSequenceRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const value = await client.invoke({ op: 'read' });
      if (!aliveRef.current || sequence !== readSequenceRef.current) return;
      applySnapshot(value);
      setLoading(false);
      return value;
    } catch (error) {
      if (!aliveRef.current || sequence !== readSequenceRef.current) return;
      setLoadError(describeError(error));
      setLoading(false);
    }
  }, [client, applySnapshot]);

  react.useEffect(() => { void refresh(); }, [refresh]);

  // 统一的忙态闸门：同一时刻只跑一个写操作，避免 revision 互相打架。
  const run = async (key, task) => {
    if (busyRef.current) return;
    busyRef.current = key;
    setBusy(key);
    try {
      await task();
    } finally {
      busyRef.current = null;
      if (aliveRef.current) setBusy(null);
    }
  };

  /** 保存类操作出错时的统一提示：冲突时额外给出刷新入口。 */
  const reportSaveError = async (error, prefix) => {
    if (isRevisionConflict(error)) {
      setNotice({ ok: false, text: '设置已在别处被改动，本次操作没有生效；请刷新后重试。', refresh: true });
      await refresh();
      return;
    }
    setNotice({ ok: false, text: `${prefix}：${describeError(error)}。正在重新读取已保存状态，请核对实际生效账号。`, refresh: true });
    await refresh();
  };

  const selectAccount = (plan, accountId) => run(`select:${plan}`, async () => {
    if (!snapshot?.revision) return;
    try {
      const value = await client.invoke({ op: 'select', revision: snapshot.revision, plan, accountId });
      applySnapshot(value);
      setQuotas((previous) => ({ ...previous, [plan]: null }));
      setNotice({ ok: true, text: `已切换${PLAN_TITLES[plan]}的账号。` });
    } catch (error) {
      await reportSaveError(error, '切换账号失败');
    }
  });

  // Explicit onboarding action: use the verified account and enable only the requested plan.
  const usePlan = (plan, accountId) => run(`use:${plan}`, async () => {
    let current = snapshot;
    if (!current?.revision) return;
    try {
      if (current.active?.[plan] !== accountId) {
        current = await client.invoke({ op: 'select', revision: current.revision, plan, accountId });
        applySnapshot(current);
      }
      if (!providerEnabledOf(current, plan)) {
        current = await client.invoke({ op: 'setProviderEnabled', revision: current.revision, plan, enabled: true });
        applySnapshot(current);
      }
      setNotice({ ok: true, text: `已为${PLAN_TITLES[plan]}启用此账号，可在套餐卡片查看模型与额度。` });
    } catch (error) { await reportSaveError(error, '启用套餐失败'); }
  });

  const pullModels = (plan) => run(`models:${plan}`, async () => {
    const accountId = snapshot?.active?.[plan] ?? null;
    if (!snapshot?.revision || !accountId) return;
    try {
      const value = await client.invoke({ op: 'models', revision: snapshot.revision, plan, accountId });
      applySnapshot(value);
      setNotice({ ok: true, text: `已拉取${PLAN_TITLES[plan]}的模型目录。` });
    } catch (error) {
      await reportSaveError(error, '拉取模型失败');
    }
  });

  const pullQuota = async (plan) => {
    const accountId = snapshot?.active?.[plan] ?? null;
    const epoch = quotaEpochRef.current;
    if (!accountId || quotaPendingRef.current.get(plan) === epoch) return;
    quotaPendingRef.current.set(plan, epoch);
    setQuotaBusy(previous => ({ ...previous, [plan]: true }));
    try {
      const value = await client.invoke({ op: 'quota', plan, accountId, force: true });
      if (!aliveRef.current || epoch !== quotaEpochRef.current) return;
      setQuotas((previous) => ({ ...previous, [plan]: value }));
    } catch (error) {
      if (!aliveRef.current || epoch !== quotaEpochRef.current) return;
      setQuotas((previous) => ({ ...previous, [plan]: { accountId, plan, state: 'error', windows: [], error: describeError(error), updatedAt: new Date().toISOString() } }));
    } finally {
      if (quotaPendingRef.current.get(plan) === epoch) {
        quotaPendingRef.current.delete(plan);
        if (aliveRef.current) setQuotaBusy(previous => ({ ...previous, [plan]: false }));
      }
    }
  };

  // 套餐启停：只改启用状态，不动账号选择，也不动模型参数。
  const toggleProvider = (plan, enabled) => run(`provider:${plan}`, async () => {
    if (!snapshot?.revision) return;
    try {
      const value = await client.invoke({ op: 'setProviderEnabled', plan, enabled, revision: snapshot.revision });
      applySnapshot(value);
      setNotice({ ok: true, text: `${PLAN_TITLES[plan]}已${enabled ? '启用' : '停用'}（账号选择与模型参数保留）。` });
    } catch (error) {
      await reportSaveError(error, `${enabled ? '启用' : '停用'}${PLAN_TITLES[plan]}失败`);
    }
  });

  // 逐模型启停：停用只影响模型是否进入目录，参数照旧保留。
  const toggleModel = (plan, accountId, modelId, enabled) => run(`model:${plan}:${modelId}`, async () => {
    if (!snapshot?.revision || !accountId) return;
    try {
      const value = await client.invoke({ op: 'setModelEnabled', accountId, plan, modelId, enabled, revision: snapshot.revision });
      applySnapshot(value);
      setNotice({ ok: true, text: `模型 ${modelId} 已${enabled ? '启用' : '停用'}。` });
    } catch (error) {
      await reportSaveError(error, `切换模型 ${modelId} 失败`);
    }
  });

  // 保存模型参数：整份覆盖，空值表示继承目录默认。
  const saveModelSettings = (plan, accountId, modelId, settings) => run(`settings:${plan}:${modelId}`, async () => {
    if (!snapshot?.revision || !accountId) return;
    try {
      const value = await client.invoke({ op: 'saveModelSettings', accountId, plan, modelId, settings, revision: snapshot.revision });
      applySnapshot(value);
      setNotice({ ok: true, text: `模型 ${modelId} 的参数已保存。` });
    } catch (error) {
      await reportSaveError(error, `保存模型 ${modelId} 的参数失败`);
    }
  });

  // 恢复默认：清掉该模型的覆盖值，回到目录默认（含启用状态）。
  const resetModelSettings = (plan, accountId, modelId) => run(`reset:${plan}:${modelId}`, async () => {
    if (!snapshot?.revision || !accountId) return;
    try {
      const value = await client.invoke({ op: 'resetModelSettings', accountId, plan, modelId, revision: snapshot.revision });
      applySnapshot(value);
      setNotice({ ok: true, text: `模型 ${modelId} 的参数与启用状态已恢复目录默认。` });
    } catch (error) {
      await reportSaveError(error, `恢复模型 ${modelId} 的默认参数失败`);
    }
  });

  const startLogin = (accountId) => run('login', async () => {
    if (!snapshot?.revision) return;
    try {
      let revision = snapshot.revision;
      if (accountId === NEW_LOGIN_ACCOUNT) {
        const accounts = snapshot.accounts ?? [];
        let index = 1;
        while (accounts.some(account => account.id === `account-${index}`)) index++;
        accountId = `account-${index}`;
        const saved = await client.invoke({ op: 'saveAccount', revision, account: { id: accountId, label: '方舟账号', apiKeyRefs: {}, accessKeyRef: '', secretKeyRef: '' } });
        applySnapshot(saved);
        revision = saved.revision;
        setEditor(null);
      }
      const value = await client.invoke({ op: 'startLogin', revision, accountId });
      if (aliveRef.current) setLogin(normalizeLogin(value));
    } catch (error) {
      if (!aliveRef.current) return;
      const latest = await refresh();
      if (!latest) {
        setLogin({ jobId: null, accountId, state: 'launching', message: '启动结果暂无法确认，正在自动同步登录状态；确认前请勿重复登录或修改账号。' });
        setNotice(null);
      } else if (LOGIN_ACTIVE_STATES.includes(latest?.login?.state)) {
        setNotice({ ok: true, text: '检测到登录仍在进行，已恢复进度；请继续官方授权或取消登录。' });
      } else if (isRevisionConflict(error)) {
        setNotice({ ok: false, text: '设置已在别处被改动，已刷新；请重新确认登录。', refresh: true });
      } else {
        setNotice({ ok: false, text: `启动登录失败：${describeError(error)}。已创建的本地账号会保留，可在该账号上重试。`, refresh: true });
      }
    }
  });

  // 登录前先把副作用讲清楚，确认后才让后端打开官方窗口。
  const requestLogin = (accountId) => {
    setLoginConfirm(accountId);
    setNotice(null);
  };

  const confirmLogin = (accountId) => {
    setLoginConfirm(null);
    void startLogin(accountId);
  };

  const cancelLogin = () => run('cancel-login', async () => {
    const jobId = login.jobId;
    if (!jobId) return;
    try {
      const value = await client.invoke({ op: 'cancelLogin', jobId });
      if (aliveRef.current) setLogin(normalizeLogin(value));
    } catch (error) {
      if (aliveRef.current) setNotice({ ok: false, text: `取消登录失败：${describeError(error)}` });
    }
  });

  const saveAccount = () => run('save', async () => {
    if (!editor) return;
    const problem = validateAccountDraft(editor.draft, snapshot?.accounts ?? [], editor.mode === 'edit' ? editor.id : null);
    if (problem) {
      setNotice({ ok: false, text: problem });
      return;
    }
    try {
      const value = await client.invoke({ op: 'saveAccount', revision: snapshot.revision, account: accountPayload(editor.draft) });
      applySnapshot(value);
      quotaEpochRef.current += 1;
      setQuotaBusy({});
      setQuotas({});
      setEditor(null);
      setNotice({ ok: true, text: '账号已保存。' });
    } catch (error) {
      await reportSaveError(error, '保存账号失败');
    }
  });

  const removeAccount = (accountId) => run('delete', async () => {
    try {
      const value = await client.invoke({ op: 'removeAccount', revision: snapshot.revision, accountId });
      applySnapshot(value);
      setEditor(previous => previous?.id === accountId ? null : previous);
      setLoginConfirm(previous => previous === accountId ? null : previous);
      setConfirmDelete(null);
      setNotice({ ok: true, text: '账号已删除；官方 CLI 凭据目录仍保留。' });
    } catch (error) {
      await reportSaveError(error, '删除账号失败');
    }
  });

  // 登录进行中：每秒轮询一次状态；流程结束即停止轮询。
  react.useEffect(() => {
    if (!LOGIN_ACTIVE_STATES.includes(login.state)) return undefined;
    let alive = true;
    let timer = null;
    let failures = 0;
    const poll = async () => {
      try {
        // If the start response was lost, recover the host job and account snapshot together.
        const value = await client.invoke({ op: login.jobId ? 'loginStatus' : 'read' });
        if (!alive) return;
        const next = normalizeLogin(login.jobId ? value : value.login);
        if (!login.jobId) {
          applySnapshot(value);
          if (next.state === 'idle') setNotice({ ok: false, text: '连接已恢复，未检测到进行中的登录，请重新发起。' });
        }
        failures = 0;
        setLogin(next);
        if (LOGIN_ACTIVE_STATES.includes(next.state)) timer = setTimeout(poll, LOGIN_POLL_MS);
      } catch (error) {
        if (!alive) return;
        // A transport failure does not mean the host login stopped: retain cancellation and the write lock.
        setLogin((previous) => ({ ...previous, message: `暂时无法查询登录进度：${describeError(error)}。将自动重试，${previous.jobId ? '仍可取消登录' : '同步状态后可取消登录'}。` }));
        timer = setTimeout(poll, Math.min(10000, ++failures * 2000));
      }
    };
    timer = setTimeout(poll, LOGIN_POLL_MS);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [client, login.jobId, login.state, applySnapshot]);

  // 登录成功后刷新一次整页状态。
  react.useEffect(() => {
    if (login.state !== 'success') return;
    const identity = `${login.accountId ?? ''}:${login.jobId ?? ''}`;
    if (handledLoginRef.current === identity) return;
    handledLoginRef.current = identity;
    // 同一账号重新登录也可能换了官方身份；失效所有额度及在途旧响应。
    quotaEpochRef.current += 1;
    setQuotaBusy({});
    setQuotas({});
    void refresh();
  }, [login.state, login.accountId, login.jobId, refresh]);

  const openNew = () => {
    setEditor({ mode: 'new', id: null, draft: emptyDraft() });
    setNotice(null);
  };

  const openEdit = (account) => {
    setEditor({ mode: 'edit', id: account.id, authMode: account.authMode, draft: draftFromAccount(account) });
    setNotice(null);
  };

  const changeDraft = (patch) => {
    setEditor((previous) => {
      if (!previous) return previous;
      const draft = { ...previous.draft, ...patch };
      if (patch.apiKeyRefs) draft.apiKeyRefs = { ...previous.draft.apiKeyRefs, ...patch.apiKeyRefs };
      return { ...previous, draft };
    });
  };

  const busyAccount = busy !== null;
  const loginActive = LOGIN_ACTIVE_STATES.includes(login.state);
  const planBusy = busy ?? (loginActive ? 'login-active' : null);

  return h('div', { style: style.root },
    h('header', null,
      h('div', { style: { ...style.row, justifyContent: 'space-between' } },
        h('h2', { style: style.title }, '火山方舟 Provider'),
        h('button', { type: 'button', style: style.btn, disabled: busyAccount || loading, onClick: () => { void refresh(); } }, loading ? '正在刷新状态…' : '刷新状态')),
      h('p', { style: style.muted }, '登录或添加账号，再为 Agent 套餐与编程套餐分别选择账号、管理模型并查看额度。')),
    loading && snapshot ? h('p', { role: 'status', style: style.muted }, '正在更新账号与套餐状态…') : null,
    busy ? h('p', { role: 'status', 'aria-live': 'polite', style: style.muted }, busyMessage(busy)) : null,
    loginActive ? h('p', { role: 'status', style: style.muted }, '登录期间暂不能修改账号与套餐，请完成登录或取消后继续。') : null,
    loadError ? h('div', null,
      h('p', { role: 'alert', style: style.error }, `读取状态失败：${loadError}`),
      h('button', { type: 'button', style: style.btn, disabled: busyAccount || loading, onClick: () => { void refresh(); } }, '重试读取状态')) : null,
    snapshot?.routingError ? h('p', { role: 'alert', style: style.error }, describeError(snapshot.routingError)) : null,
    notice
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('p', { role: notice.ok ? 'status' : 'alert', style: notice.ok ? style.success : style.error }, notice.text),
        notice.refresh
          ? h('button', { type: 'button', style: style.btn, disabled: busyAccount, onClick: () => { setNotice(null); void refresh(); } }, '刷新')
          : null)
      : null,
    !snapshot
      ? (loading ? h('p', { role: 'status', style: style.muted }, '正在读取方舟账号状态…') : null)
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h(AccountPanel, {
          snapshot, editor, confirmDelete, loginConfirm, login, busy,
          onNew: openNew, onEdit: openEdit, onCancelEdit: () => setEditor(null),
          onChangeDraft: changeDraft, onSave: saveAccount,
          onRequestDelete: (accountId) => setConfirmDelete(accountId),
          onConfirmDelete: (accountId) => { void removeAccount(accountId); },
          onCancelDelete: () => setConfirmDelete(null),
          onRequestLogin: requestLogin,
          onUsePlan: usePlan,
          onConfirmLogin: confirmLogin,
          onCancelLoginConfirm: () => setLoginConfirm(null),
          onCancelLogin: () => { void cancelLogin(); }
        }),
        h(PlanCard, {
          plan: 'agent-plan', snapshot, rawQuota: quotas['agent-plan'], busy: planBusy, quotaBusy: Boolean(quotaBusy['agent-plan']),
          onSelect: selectAccount, onModels: pullModels, onQuota: pullQuota,
          onToggleProvider: toggleProvider, onToggleModel: toggleModel,
          onSaveModelSettings: saveModelSettings, onResetModelSettings: resetModelSettings
        }),
        h(PlanCard, {
          plan: 'coding-plan', snapshot, rawQuota: quotas['coding-plan'], busy: planBusy, quotaBusy: Boolean(quotaBusy['coding-plan']),
          onSelect: selectAccount, onModels: pullModels, onQuota: pullQuota,
          onToggleProvider: toggleProvider, onToggleModel: toggleModel,
          onSaveModelSettings: saveModelSettings, onResetModelSettings: resetModelSettings
        })));
}

// ── 插件装配 ─────────────────────────────────────────────────────────────────

/**
 * 注册设置页并挂载远端。
 *
 * @param {object} ctx Client 上下文
 * @returns {void}
 */
export function apply(ctx) {
  const runtime = { disposed: false, service: null, unmount: null, timers: new Set(), waiters: new Set() };

  /** 读取已挂载的远端服务；未就绪返回 null。 */
  const lookupService = () => {
    try {
      const candidate = ctx.get('remote.volcengineProvider');
      return candidate && typeof candidate.invoke === 'function' ? candidate : null;
    } catch {
      return null;
    }
  };

  // 1) 挂载远端定义。挂载失败不拖垮设置页，具体错误在调用时给出。
  try {
    Promise.resolve(ctx.remote.$mount(arkRemote)).then((unmount) => {
      if (runtime.disposed) {
        if (typeof unmount === 'function') unmount();
      } else runtime.unmount = unmount;
    }, () => {});
  } catch {
    // 忽略：invoke 时会报「远端服务未就绪」。
  }

  // 2) 等待远端服务就绪：优先依赖注入（服务一到即回调），不可用时退到有上限的短轮询。
  try {
    ctx.inject(['remote.volcengineProvider'], (scope) => {
      const candidate = scope?.remote?.volcengineProvider ?? scope?.['remote.volcengineProvider'] ?? null;
      if (candidate && typeof candidate.invoke === 'function') runtime.service = candidate;
    });
  } catch {
    // 没有 inject 时走下面的兜底轮询。
  }

  /** 带上限地等到远端服务可用。 */
  const resolveService = async () => {
    if (runtime.disposed) throw new Error('设置页已卸载。');
    if (runtime.service) return runtime.service;
    const direct = lookupService();
    if (direct) {
      runtime.service = direct;
      return direct;
    }
    const deadline = Date.now() + SERVICE_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (runtime.disposed) throw new Error('设置页已卸载。');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          runtime.timers.delete(timer);
          runtime.waiters.delete(waiter);
          resolve();
        }, 200);
        // 卸载时把等待放行，让挂起的调用自己收尾，而不是永远挂着。
        const waiter = { timer, resolve };
        runtime.timers.add(timer);
        runtime.waiters.add(waiter);
      });
      const candidate = lookupService();
      if (candidate) {
        runtime.service = candidate;
        return candidate;
      }
    }
    throw new Error('火山方舟远端服务未就绪，请稍后重试。');
  };

  /** 唯一的数据出口：调用远端并把 {ok,value|error} 规整成值或异常。 */
  const invoke = async (request) => {
    const service = await resolveService();
    const result = await service.invoke(request);
    if (!result || typeof result !== 'object') throw new Error('远端返回了无法识别的响应。');
    if (result.ok) return result.value;
    const error = result.error;
    if (error instanceof Error) throw error;
    if (error && typeof error === 'object' && typeof error.message === 'string') throw new Error(error.message);
    throw new Error(typeof error === 'string' && error ? error : '远端调用失败。');
  };

  const client = { invoke };

  // 3) 注册设置页分区。
  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'volcengine-provider',
      order: 24,
      label: () => '火山方舟 Provider',
      inject: () => ({ client })
    }, VolcengineProviderSection));
  } catch (error) {
    console.error('[dsh-volcengine-provider] 设置页注册失败:', error);
  }

  // 4) 生命周期清理：定时器、远端挂载。
  ctx.effect(() => () => {
    runtime.disposed = true;
    for (const waiter of runtime.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    runtime.waiters.clear();
    for (const timer of runtime.timers) clearTimeout(timer);
    runtime.timers.clear();
    if (typeof runtime.unmount === 'function') {
      try { runtime.unmount(); } catch { /* 卸载失败不影响其它插件 */ }
    }
    runtime.unmount = null;
  }, 'dsh-volcengine-provider: 清理客户端资源');
}

export const name = 'dsh-volcengine-provider';
export const inject = ['slots', 'remote'];
