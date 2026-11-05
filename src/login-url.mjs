/**
 * 官方登录链接放行规则（不依赖浏览器）。
 *
 * 无浏览器两段式登录由官方 CLI 打印链接，Host 只把通过白名单的链接交给
 * 设置页展示；CLI 输出里的其它文字一律不下发。放宽到两段式 SSO 链接，
 * 不再要求 broker 同设备会话专有的 callbackPort / nonce / sessionId 参数。
 */
const ALLOWED = new Map([
  ['ark.volcengine.com', /^(?:\/region:cn-beijing)?\/arkcli\/login\/?$/],
  ['signin.volcengine.com', /^\/authorize\//]
]);

export function approvedLoginUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const pattern = ALLOWED.get(url.hostname);
    if (!pattern || !pattern.test(url.pathname)) return undefined;
    if (raw.length > 2048) return undefined;
    return raw;
  } catch { return undefined; }
}

/** 从官方 CLI 输出里提取第一个通过白名单的 https 链接。 */
export function extractLoginUrl(text) {
  for (const match of String(text).matchAll(/https:\/\/[^\s<>"'`]+/g)) {
    const candidate = match[0].replace(/[.,;:!?)\]}]+$/, '');
    const url = approvedLoginUrl(candidate);
    if (url) return url;
  }
  return undefined;
}
