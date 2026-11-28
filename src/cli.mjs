import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { delimiter, dirname, join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { arkCliRelease, ARKCLI_PACKAGE } from './arkcli-release.mjs';
import { assertPlan } from './state.mjs';
const require = createRequire(import.meta.url);
const maxBytes = 2 * 1024 * 1024;

async function executableFile(path) {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return false;
    throw error;
  }
}

function cliUnavailable(code, message) { return Object.assign(new Error(message), { code }); }

function packageManifest(loader, name) {
  try { return loader.resolve(`${name}/package.json`); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    return null;
  }
}

function packageBinaries(manifest, { name, filename }) {
  const optional = packageManifest(createRequire(manifest), name);
  return [optional && join(dirname(optional), 'bin', filename), join(dirname(manifest), 'bin', filename)];
}

export async function locateCli(explicit, { managed, env = process.env, home = homedir(), loader = require } = {}) {
  if (explicit) {
    if (!isAbsolute(explicit) || /\.(cmd|bat)$/i.test(explicit) || !await executableFile(explicit)) {
      throw cliUnavailable('ARKCLI_CONFIG', 'arkCliPath 必须指向可执行的官方 ArkCli 原生文件（绝对路径）');
    }
    return explicit;
  }
  const release = arkCliRelease();
  const windows = process.platform === 'win32';
  const command = windows ? 'arkcli.exe' : 'arkcli';
  const directories = (env.PATH ?? '').split(delimiter).map(part => part.replace(/^"(.*)"$/, '$1')).filter(isAbsolute);
  const userBin = windows ? null : join(home, '.local', 'bin');
  const candidates = [];
  if (release) {
    const wrapper = packageManifest(loader, ARKCLI_PACKAGE);
    const child = packageManifest(loader, release.name);
    if (wrapper) candidates.push(...packageBinaries(wrapper, release));
    if (child) candidates.push(join(dirname(child), 'bin', release.filename));
    const npmRoots = new Set([
      ...directories.map(dir => windows ? join(dir, 'node_modules') : join(dirname(dir), 'lib', 'node_modules')),
      ...[env.npm_config_prefix, env.NPM_CONFIG_PREFIX, !windows && join(home, '.local', 'share', 'arkcli-npm', 'volc'), windows && env.APPDATA && join(env.APPDATA, 'npm')]
        .filter(path => typeof path === 'string' && isAbsolute(path))
        .map(prefix => windows ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules'))
    ]);
    for (const root of npmRoots) {
      const manifest = join(root, ARKCLI_PACKAGE, 'package.json');
      candidates.push(...packageBinaries(manifest, release), join(root, release.name, 'bin', release.filename));
    }
  }
  candidates.push(...directories.map(dir => join(dir, command)), userBin && join(userBin, command), managed);
  for (const path of new Set(candidates)) if (path && await executableFile(path)) return path;
  throw cliUnavailable('ARKCLI_MISSING', '当前 DSH Host 未找到官方 ArkCli；请在账号设置安装或指定 arkCliPath');
}
export function cliEnvironment(home, ambient = process.env) {
  const env = { ...ambient, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') };
  // An explicit isolated identity must never inherit ambient cloud credentials.
  for (const key of Object.keys(env)) if (/^(ARK_|ARKCLI_|VOLC|AWS_)/i.test(key)) delete env[key];
  env.ARKCLI_NO_UPDATE_NOTIFIER = '1';
  env.ARKCLI_CALLER_TYPE = 'ai_agent';
  env.ARKCLI_CALLER_NAME = 'dsh-volcengine-provider';
  return env;
}
export function parseJsonOutput(text) {
  try { return JSON.parse(text.trim()); } catch { throw new Error('ArkCli 未返回有效 JSON；请核对 CLI 版本'); }
}
/**
 * 解析 ArkCli 失败输出里的结构化错误（`{"ok":false,"error":{...}}`）。
 * 只取分类所需字段；原始 message/hint 可能夹带凭据片段，不落盘、不回显。
 *
 * @param {unknown} output 子进程 stdout 或 stderr 文本
 * @returns {{type: string, message: string, hint: string}|null} 结构化错误或 null
 */
export function parseCliFailure(output) {
  if (typeof output !== 'string' || !output.trim()) return null;
  try {
    const data = JSON.parse(output.trim());
    if (!data || data.ok !== false || !data.error) return null;
    return {
      type: typeof data.error.type === 'string' ? data.error.type : '',
      message: typeof data.error.message === 'string' ? data.error.message : '',
      hint: typeof data.error.hint === 'string' ? data.error.hint : ''
    };
  } catch { return null; }
}
/**
 * 把 ArkCli 失败归类：`auth` 表示需要重新登录或重新确认官方协议；
 * 其余只区分网络/超时与未知，不把原始输出带到界面。
 *
 * @param {{type?: string, message?: string, hint?: string}|null} failure 结构化错误
 * @returns {'auth'|'network'|'unknown'} 失败类别
 */
export function classifyCliFailure(failure) {
  const text = `${failure?.type ?? ''} ${failure?.message ?? ''} ${failure?.hint ?? ''}`;
  if (!text.trim()) return 'unknown';
  if (/SSO|STS|auth\s*login|重新登录|协议校验|签署|oidc|oauth/i.test(text)) return 'auth';
  if (/timeout|timed\s*out|ETIMEDOUT|ECONN|EAI_AGAIN|ENOTFOUND|网络|连接失败/i.test(text)) return 'network';
  return 'unknown';
}
export class ArkCli {
  constructor({ executable, home, exec = execFile, spawnImpl = spawn }) { Object.assign(this, { executable, home, exec, spawnImpl }); }
  async run(args, { signal, timeout = 30000, plain = false } = {}) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      this.exec(this.executable, [...args, '--format', 'json'], { env: cliEnvironment(this.home), cwd: this.home, windowsHide: true, timeout, maxBuffer: maxBytes, signal, encoding: 'utf8' }, (error, stdout) => {
        if (error) {
          if (signal?.aborted) { reject(new Error('ArkCli 操作已取消')); return; }
          // CLI 的失败 JSON 通常在 stderr；execFile 的 error 同时带 stdout/stderr 原文。
          const failure = parseCliFailure(error.stderr) ?? parseCliFailure(error.stdout) ?? parseCliFailure(stdout);
          const wrapped = new Error('ArkCli 操作失败；请检查登录、网络和 CLI 版本（原始输出已隐藏）');
          wrapped.arkFailure = failure;
          const kind = classifyCliFailure(failure);
          wrapped.arkKind = kind === 'unknown' && (error.killed || error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR') ? 'network' : kind;
          reject(wrapped);
          return;
        }
        try { resolve(plain ? stdout.trim() : parseJsonOutput(stdout)); } catch (error) { reject(error); }
      });
    });
  }
  models(plan, profile, signal) {
    assertPlan(plan);
    return this.run(['plans', 'model-list', '--plan', plan, ...(profile ? ['--profile', profile] : [])], { signal });
  }
  whoami(signal) { return this.run(['auth', 'whoami'], { signal }); }
  status(signal) { return this.run(['auth', 'status'], { signal }); }
  apiKey(profile, signal) { return this.run(['profile', 'apikey', 'get', '--profile', profile, '--plain'], { signal, plain: true }); }
  usage(plan, profile, signal) {
    assertPlan(plan);
    return this.run(['usage', 'plan', '--product', plan, ...(profile ? ['--profile', profile] : [])], { signal });
  }
}
