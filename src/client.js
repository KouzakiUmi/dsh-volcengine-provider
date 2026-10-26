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
const h = (...args) => react.createElement(...args);

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
 * 与 Host 端 oauth.mjs 的 approvedLoginUrl 保持同一套规则；
 * 用 Map 而不是普通对象，避免原型链上的键被误当成白名单。
 */
const SAFE_LOGIN_PATHS = new Map([
  ['ark.volcengine.com', /^\/arkcli\/login\/?$/],
  ['signin.volcengine.com', /^\/authorize\//]
]);

/** 登录方式说明；未知取值直接显示后端给的原文。 */
const AUTH_MODE_LABELS = {
  oauth: 'OAuth 登录（官方 volc-sso）',
  sso: 'OAuth 登录（官方 volc-sso）',
  'arkcli-oauth': 'OAuth 登录（官方 volc-sso）',
  'arkcli-sso': 'OAuth 登录（官方 volc-sso）',
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
  '登录会走官方 CLI 的 volc-sso 授权流程，在系统默认浏览器中打开官方登录页；本插件不读取浏览器 Cookie，只接收官方回调的结果。',
  '登录得到的凭据保存在本插件为该账号准备的隔离目录里，不会改变你原有 CLI 的默认身份。',
  '取消登录或删除账号元数据都不会删除已经保存的凭据；需要清理时请自行处理该账号的隔离目录。',
  '额度查询需要的 AK/SK 与登录互不影响：即使还没有 AK/SK，也可以完成 OAuth 登录。'
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
  muted: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
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
  const effective = model?.effective?.reasoningEfforts;
  if (effective !== undefined) return effective;
  const defaults = model?.defaults?.reasoningEfforts;
  if (defaults !== undefined) return defaults;
  return undefined;
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
  return [...KNOWN_EFFORTS];
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
  const used = Number(window?.percent);
  if (Number.isFinite(used)) {
    const remaining = Math.max(0, 100 - used);
    parts.push(`剩余 ${formatPercent(remaining)}%`);
    if (remaining <= 0) tone = 'error';
    else if (remaining <= 10) tone = 'warn';
  }
  const detail = window?.detail;
  if (detail && Number.isFinite(Number(detail.used)) && Number.isFinite(Number(detail.limit))) {
    parts.push(`已用 ${detail.used} / ${detail.limit} ${detail.unit ?? ''}`.trim());
  }
  if (window?.resetsAt) parts.push(`重置于 ${formatTime(window.resetsAt)}`);
  if (detail?.scope) parts.push(`范围 ${detail.scope}`);
  return { text: parts.join(' · '), tone };
}

/**
 * 额度窗口列表：按分组（group）分块展示，不同额度线不混在一起。
 *
 * @param {object} props 组件属性
 * @returns {object} 元素树
 */
function QuotaWindows({ quota }) {
  if (!quota) return h('p', { style: style.muted }, '尚未查询额度。');
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
        return h('div', { key: `${item?.kind ?? 'w'}-${position}`, style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 } },
          h('span', null, WINDOW_KIND_LABELS[item?.kind] ?? item?.kind ?? '窗口'),
          h('span', { style: { textAlign: 'right', ...style[summary.tone] } }, summary.text));
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
function ModelRow({ model, disabled, editor, draftError, onToggle, onOpenEditor, onCloseEditor, onChangeDraft, onSave, onReset }) {
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
      h('button', { type: 'button', style: style.btn, disabled, 'aria-label': `恢复默认 ${model?.id ?? ''}`, onClick: () => onReset(model) }, '恢复默认')),
    h('p', { style: style.muted }, `当前参数：${describeModelSettings(model)}`),
    effective ? h('p', { style: style.muted }, `生效值：${effective}`) : null,
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
function PlanCard({ plan, snapshot, rawQuota, busy, onSelect, onModels, onQuota, onToggleProvider, onToggleModel, onSaveModelSettings, onResetModelSettings }) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const activeId = snapshot?.active?.[plan] ?? null;
  const account = accounts.find((item) => item?.id === activeId) ?? null;
  const catalog = (Array.isArray(snapshot?.catalogs) ? snapshot.catalogs : [])
    .find((item) => item?.plan === plan && item?.accountId === activeId) ?? null;
  const route = snapshot?.routes?.[plan] ?? null;
  // 额度是按账号查的：账号换了就不要再展示上一个账号的窗口。
  const quota = rawQuota && rawQuota.accountId === activeId ? rawQuota : null;
  const disabled = busy !== null;
  const hasInference = !!(account && account?.hasApiKeys?.[plan]);
  const hasQuotaKeys = !!(account && account?.hasQuotaKeys);
  // 旧快照没有 enabled 字段时按启用处理。
  const providerEnabled = providerEnabledOf(snapshot, plan);
  // 旧快照的目录没有 models 明细：安全地当作「没有列表」展示。
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const enabledCount = Number.isFinite(catalog?.enabledCount)
    ? catalog.enabledCount
    : models.filter((item) => item?.enabled !== false).length;

  // 参数编辑状态：同一时刻只展开一个模型，避免把卡片撑得过长。
  const [editor, setEditor] = react.useState(null);
  const [modelsOpen, setModelsOpen] = react.useState(false);
  const [draftError, setDraftError] = react.useState(null);

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
  }, [editor?.modelId, editedSignature]);

  const openEditor = (model) => {
    setEditor({ modelId: model.id, draft: modelDraftFrom(model), synced: JSON.stringify(model?.settings ?? null) });
    setDraftError(null);
  };

  const closeEditor = () => {
    setEditor(null);
    setDraftError(null);
  };

  const changeDraft = (patch) => {
    setEditor((previous) => (previous ? { ...previous, draft: { ...previous.draft, ...patch } } : previous));
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
    h('p', { style: style.muted }, PLAN_HINTS[plan]),
    h('div', { style: style.row },
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
        h('input', {
          type: 'checkbox', checked: providerEnabled, disabled,
          'aria-label': `启用${PLAN_TITLES[plan]}`,
          onChange: (event) => onToggleProvider(plan, Boolean(event.target.checked))
        }),
        h('span', null, '启用该套餐')),
      providerEnabled
        ? h('span', { style: style.chip }, '套餐已启用')
        : h('span', { style: style.chip }, '已停用：不注册模型路由（账号选择与模型参数保留）')),
    h('div', { style: style.row },
      h('label', { style: style.label }, '使用账号'),
      h('select', {
        style: { ...style.input, width: 'auto', minWidth: 160 },
        value: activeId ?? '',
        disabled: disabled,
        onChange: (event) => onSelect(plan, event.target.value || null)
      },
        h('option', { value: '' }, '未选择'),
        accounts.map((item) => h('option', { key: item.id, value: item.id }, `${item.label}（${item.id}）`)))),
    h('div', { style: style.row },
      h('button', { type: 'button', style: style.btn, disabled: disabled || !activeId, onClick: () => onModels(plan) }, '拉取模型'),
      h('button', { type: 'button', style: style.btn, disabled: disabled || !activeId, onClick: () => onQuota(plan) }, '刷新额度')),
    h('div', { style: style.row },
      h('span', { style: style.chip }, `推理凭据：${hasInference ? '已配置' : '未配置'}`),
      // OAuth 账号的额度鉴权来自登录绑定，不是 AK/SK，所以这里按鉴权来源说。
      h('span', { style: style.chip }, `额度鉴权：${account?.authMode === 'oauth' ? 'OAuth' : hasQuotaKeys ? 'AK/SK 已配置' : '未配置'}`),
      route ? h('span', { style: style.chip }, `模型路由：${route}`) : null),
    !account ? h('p', { style: style.muted }, '该套餐尚未选择账号。') : null,
    account && !hasInference
      ? h('p', { style: style.warn }, `该账号没有为${PLAN_TITLES[plan]}配置推理凭据引用，模型调用会失败。`)
      : null,
    account && !hasQuotaKeys
      ? h('p', { style: style.warn }, account.authMode === 'oauth'
        ? '该账号走 OAuth 登录，但当前没有可用的额度鉴权；请先完成网页登录并绑定对应套餐。'
        : '该账号缺少 AK/SK 凭据引用，额度窗口无法查询。')
      : null,
    catalog
      ? h('p', { style: style.muted }, `模型目录：${catalog.count} 个模型（来源 ${CATALOG_SOURCE_LABELS[catalog.source] ?? catalog.source}${catalog.updatedAt ? `，更新于 ${formatTime(catalog.updatedAt)}` : ''}）。`)
      : h('p', { style: style.muted }, '模型目录：尚未拉取。'),
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
            model, disabled, editor, draftError,
            onToggle: (item, enabled) => onToggleModel(plan, activeId, item.id, enabled),
            onOpenEditor: openEditor,
            onCloseEditor: closeEditor,
            onChangeDraft: changeDraft,
            onSave: saveEditor,
            onReset: resetModel
          }))))
      : h('p', { style: style.muted }, catalog
        ? '该目录暂无模型明细（旧缓存可能没有模型列表，重新拉取模型后可用）。'
        : '模型目录：尚未拉取。'),
    h(QuotaWindows, { quota })
  );
}

/**
 * 账号区：账号列表、新增 / 编辑表单、删除二次确认、网页登录状态。
 *
 * @param {object} props 组件属性
 * @returns {object} 元素树
 */
function AccountPanel({ snapshot, editor, confirmDelete, loginConfirm, login, busy, onNew, onEdit, onCancelEdit, onChangeDraft, onSave, onRequestDelete, onConfirmDelete, onCancelDelete, onRequestLogin, onConfirmLogin, onCancelLoginConfirm, onCancelLogin }) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const disabled = busy !== null;
  const loginActive = LOGIN_ACTIVE_STATES.includes(login.state);
  const loginUrl = safeLoginUrl(login.url);
  // 登录方式挂在账号上（OAuth 绑定 / 凭据引用名），不是整个设置的属性。
  const loginAccount = accounts.find((item) => item?.id === login.accountId) ?? null;
  const authMode = loginAccount?.authMode ?? accounts[0]?.authMode ?? snapshot?.authMode ?? login.authMode ?? null;

  return h('section', { style: style.card },
    h('h3', { style: style.cardTitle }, '账号与凭据引用'),
    h('p', { style: style.muted }, '这里只保存凭据在凭据服务里的「引用名」，不保存也不回显任何密钥本体。'),
    accounts.length
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        accounts.map((account) => h('div', { key: account.id, style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))', borderRadius: 'var(--dsw-radius-sm, 6px)' } },
          h('div', { style: style.row },
            h('strong', { style: { fontWeight: 600 } }, account.label),
            h('span', { style: style.chip }, account.id),
            account.authMode ? h('span', { style: style.chip }, `凭据来源：${AUTH_MODE_LABELS[account.authMode] ?? account.authMode}`) : null,
            account.cliProfile ? h('span', { style: style.chip }, `ArkCli Profile：${account.cliProfile}`) : null),
          h('div', { style: style.row },
            h('span', { style: style.muted }, `Agent 套餐推理引用：${account.apiKeyRefs?.['agent-plan'] ?? '未配置'}`),
            h('span', { style: style.muted }, `编程套餐推理引用：${account.apiKeyRefs?.['coding-plan'] ?? '未配置'}`)),
          h('div', { style: style.row },
            h('span', { style: style.muted }, `AK 引用：${account.accessKeyRef || '未配置'}`),
            h('span', { style: style.muted }, `SK 引用：${account.secretKeyRef || '未配置'}`)),
          h('div', { style: style.row },
            h('button', { type: 'button', style: style.btn, disabled: disabled || loginActive, onClick: () => onRequestLogin(account.id) }, loginActive ? '登录进行中…' : '网页登录'),
            h('button', { type: 'button', style: style.btn, disabled: disabled, onClick: () => onEdit(account) }, '编辑'),
            confirmDelete === account.id
              ? h('button', { type: 'button', style: style.danger, disabled: disabled, onClick: () => onConfirmDelete(account.id) }, '确认删除')
              : h('button', { type: 'button', style: style.btn, disabled: disabled, onClick: () => onRequestDelete(account.id) }, '删除'),
            confirmDelete === account.id
              ? h('button', { type: 'button', style: style.btn, disabled: disabled, onClick: onCancelDelete }, '取消')
              : null),
          loginConfirm === account.id
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))', borderRadius: 'var(--dsw-radius-sm, 6px)' } },
              h('div', { style: { fontWeight: 600, fontSize: 13 } }, `开始网页登录：${account.label}`),
              h('ul', { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
                LOGIN_CONFIRM_NOTES.map((note, index) => h('li', { key: index, style: style.muted }, note))),
              h('div', { style: style.row },
                h('button', { type: 'button', style: style.primary, disabled: disabled, onClick: () => onConfirmLogin(account.id) }, '确认并打开官方登录页'),
                h('button', { type: 'button', style: style.btn, disabled: disabled, onClick: onCancelLoginConfirm }, '取消')))
            : null)))
      : h('p', { style: style.muted }, '还没有账号，请先新增一个。'),
    h('div', { style: style.row },
      h('button', { type: 'button', style: style.btn, disabled: disabled || editor !== null, onClick: onNew }, '新增账号')),
    editor ? h(AccountForm, { editor, busy, onChangeDraft, onSave, onCancel: onCancelEdit }) : null,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
      h('div', { style: { fontWeight: 600, fontSize: 13 } }, '网页登录'),
      loginAccount ? h('p', { style: style.muted }, `当前登录账号：${loginAccount.label}（${loginAccount.id}）`) : null,
      authMode ? h('p', { style: style.muted }, `凭据来源：${AUTH_MODE_LABELS[authMode] ?? authMode}`) : null,
      h('p', { style: style.muted }, LOGIN_STATE_LABELS[login.state] ?? login.state),
      login.message ? h('p', { style: style.muted }, login.message) : null,
      loginUrl ? h('a', { href: loginUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 12, color: 'var(--dsw-alias-link, inherit)' } }, '打开官方授权页面') : null,
      loginActive
        ? h('button', { type: 'button', style: style.btn, disabled: disabled || !login.jobId, onClick: onCancelLogin }, '取消登录')
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
      field('账号名称', 'label', '例如：团队账号')),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      apiKeyField('agent-plan', 'Agent 套餐推理凭据引用名', '例如：ARKCLI_AGENT_PLAN_API_KEY'),
      apiKeyField('coding-plan', '编程套餐推理凭据引用名', '例如：ARKCLI_CODING_PLAN_API_KEY')),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      field('AccessKey 引用名（可选）', 'accessKeyRef', '例如：VOLC_ACCESSKEY'),
      field('SecretKey 引用名（可选）', 'secretKeyRef', '例如：VOLC_SECRETKEY')),
    h('p', { style: style.muted }, 'AK/SK 引用名只用于查询管控面额度；用「网页登录」完成 OAuth 的账号不需要填写这两项。'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      field('ArkCli Profile（可选）', 'cliProfile', '留空表示不使用')),
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
  const [busy, setBusy] = react.useState(null);
  const [notice, setNotice] = react.useState(null);
  const [quotas, setQuotas] = react.useState({});
  const [editor, setEditor] = react.useState(null);
  const [confirmDelete, setConfirmDelete] = react.useState(null);
  const [loginConfirm, setLoginConfirm] = react.useState(null);
  const [login, setLogin] = react.useState({ jobId: null, state: 'idle', message: '', url: null, authMode: null });

  const aliveRef = react.useRef(true);
  const busyRef = react.useRef(null);
  const handledLoginRef = react.useRef(null);

  react.useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  /** 把一次 read 返回的整份快照落到状态里。 */
  const applySnapshot = react.useCallback((value) => {
    if (!aliveRef.current || !value) return;
    setSnapshot(value);
    const incoming = value.login ? normalizeLogin(value.login) : null;
    if (incoming) {
      setLogin((previous) => (previous.jobId === incoming.jobId ? previous : incoming));
    }
  }, []);

  /** 重新读取全部状态。 */
  const refresh = react.useCallback(async () => {
    try {
      const value = await client.invoke({ op: 'read' });
      if (!aliveRef.current) return;
      applySnapshot(value);
      setLoadError(null);
    } catch (error) {
      if (!aliveRef.current) return;
      setLoadError(describeError(error));
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
    setNotice({ ok: false, text: `${prefix}：${describeError(error)}` });
  };

  const selectAccount = (plan, accountId) => run(`select:${plan}`, async () => {
    if (!snapshot?.revision) return;
    try {
      const value = await client.invoke({ op: 'select', revision: snapshot.revision, plan, accountId });
      applySnapshot(value);
      setNotice({ ok: true, text: `已切换${PLAN_TITLES[plan]}的账号。` });
    } catch (error) {
      await reportSaveError(error, '切换账号失败');
    }
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

  const pullQuota = (plan) => run(`quota:${plan}`, async () => {
    const accountId = snapshot?.active?.[plan] ?? null;
    if (!accountId) return;
    try {
      const value = await client.invoke({ op: 'quota', plan, accountId, force: true });
      if (!aliveRef.current) return;
      setQuotas((previous) => ({ ...previous, [plan]: value }));
    } catch (error) {
      if (!aliveRef.current) return;
      setQuotas((previous) => ({ ...previous, [plan]: { accountId, plan, state: 'error', windows: [], error: describeError(error) } }));
    }
  });

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
      setNotice({ ok: true, text: `模型 ${modelId} 的参数已恢复默认。` });
    } catch (error) {
      await reportSaveError(error, `恢复模型 ${modelId} 的默认参数失败`);
    }
  });

  const startLogin = (accountId) => run('login', async () => {
    if (!snapshot?.revision) return;
    try {
      const value = await client.invoke({ op: 'startLogin', revision: snapshot.revision, accountId });
      if (aliveRef.current) setLogin(normalizeLogin(value));
    } catch (error) {
      if (aliveRef.current) {
        setNotice({ ok: false, text: `启动登录失败：${describeError(error)}` });
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
      setConfirmDelete(null);
      setNotice({ ok: true, text: '账号已删除。' });
    } catch (error) {
      await reportSaveError(error, '删除账号失败');
    }
  });

  // 登录进行中：每秒轮询一次状态；流程结束即停止轮询。
  react.useEffect(() => {
    if (!LOGIN_ACTIVE_STATES.includes(login.state) || !login.jobId) return undefined;
    let alive = true;
    let timer = null;
    const poll = async () => {
      try {
        const value = await client.invoke({ op: 'loginStatus' });
        if (!alive) return;
        const next = normalizeLogin(value);
        setLogin(next);
        if (LOGIN_ACTIVE_STATES.includes(next.state)) timer = setTimeout(poll, LOGIN_POLL_MS);
      } catch (error) {
        if (!alive) return;
        setLogin((previous) => ({ ...previous, state: 'error', message: describeError(error) }));
      }
    };
    timer = setTimeout(poll, LOGIN_POLL_MS);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [client, login.jobId, login.state]);

  // 登录成功后刷新一次整页状态。
  react.useEffect(() => {
    if (login.state !== 'success') return;
    if (handledLoginRef.current === login.jobId) return;
    handledLoginRef.current = login.jobId;
    void refresh();
  }, [login.state, login.jobId, refresh]);

  const openNew = () => {
    setEditor({ mode: 'new', id: null, draft: emptyDraft() });
    setNotice(null);
  };

  const openEdit = (account) => {
    setEditor({ mode: 'edit', id: account.id, draft: draftFromAccount(account) });
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

  return h('div', { style: style.root },
    h('header', null,
      h('h2', { style: style.title }, '火山方舟 Provider'),
      h('p', { style: style.muted }, '管理火山方舟 Agent 套餐与编程套餐的账号、模型目录与额度。页面只保存凭据引用名。')),
    loadError ? h('p', { role: 'alert', style: style.error }, `读取状态失败：${loadError}`) : null,
    snapshot?.routingError ? h('p', { role: 'alert', style: style.error }, describeError(snapshot.routingError)) : null,
    notice
      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('p', { role: notice.ok ? 'status' : 'alert', style: notice.ok ? style.success : style.error }, notice.text),
        notice.refresh
          ? h('button', { type: 'button', style: style.btn, disabled: busyAccount, onClick: () => { setNotice(null); void refresh(); } }, '刷新')
          : null)
      : null,
    !snapshot
      ? h('p', { style: style.muted }, '正在读取方舟账号状态…')
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        h(PlanCard, {
          plan: 'agent-plan', snapshot, rawQuota: quotas['agent-plan'], busy,
          onSelect: selectAccount, onModels: pullModels, onQuota: pullQuota,
          onToggleProvider: toggleProvider, onToggleModel: toggleModel,
          onSaveModelSettings: saveModelSettings, onResetModelSettings: resetModelSettings
        }),
        h(PlanCard, {
          plan: 'coding-plan', snapshot, rawQuota: quotas['coding-plan'], busy,
          onSelect: selectAccount, onModels: pullModels, onQuota: pullQuota,
          onToggleProvider: toggleProvider, onToggleModel: toggleModel,
          onSaveModelSettings: saveModelSettings, onResetModelSettings: resetModelSettings
        }),
        h(AccountPanel, {
          snapshot, editor, confirmDelete, loginConfirm, login, busy,
          onNew: openNew, onEdit: openEdit, onCancelEdit: () => setEditor(null),
          onChangeDraft: changeDraft, onSave: saveAccount,
          onRequestDelete: (accountId) => setConfirmDelete(accountId),
          onConfirmDelete: (accountId) => { void removeAccount(accountId); },
          onCancelDelete: () => setConfirmDelete(null),
          onRequestLogin: requestLogin,
          onConfirmLogin: confirmLogin,
          onCancelLoginConfirm: () => setLoginConfirm(null),
          onCancelLogin: () => { void cancelLogin(); }
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
