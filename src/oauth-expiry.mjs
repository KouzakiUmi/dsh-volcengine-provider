// OAuth 登录态到期元数据：只解读官方 CLI 签发的 refresh_token JWT 的 exp claim。
// 官方 SSO 的 refresh_token 有效期固定（实测 48 小时）、续期不轮换不延长，
// 因此它的 exp 就是登录态的权威到期时间。token 本体与其他 claim 不落盘、不返回、不进日志。
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 解读 JWT 的到期时间；只取 exp claim，任何非法输入返回 null。
 *
 * @param {unknown} token refresh_token 文本
 * @returns {number|null} 到期毫秒时间戳；无法解读时 null
 */
export function refreshTokenExpiry(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = payload?.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch { return null; }
}

/**
 * 从账号隔离 CLI home 读取登录态到期时间。目录缺失、文件损坏或字段缺失返回 null，不抛错；
 * 多个身份目录时取最晚到期（正常只有一个 active 身份）。
 *
 * @param {string} home 隔离 CLI home 绝对路径
 * @returns {Promise<number|null>} 到期毫秒时间戳；未知时 null
 */
export async function readOAuthExpiry(home) {
  const dir = join(home, '.arkcli', 'identities');
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return null; }
  let latest = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let data;
    try { data = JSON.parse(await readFile(join(dir, entry.name, 'token.json'), 'utf8')); }
    catch { continue; } // 单个身份文件不可读时跳过，不影响其他身份。
    const expiry = refreshTokenExpiry(data?.refresh_token);
    if (expiry !== null && (latest === null || expiry > latest)) latest = expiry;
  }
  return latest;
}