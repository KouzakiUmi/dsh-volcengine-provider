import { execFile, spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { delimiter, dirname, join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { assertPlan } from './state.mjs';
const require = createRequire(import.meta.url);
const maxBytes = 2 * 1024 * 1024;
export async function locateCli(explicit) {
  if (explicit) {
    if (!isAbsolute(explicit) || /\.(cmd|bat)$/i.test(explicit)) throw new Error('arkCliPath 必须是官方原生可执行文件绝对路径');
    await access(explicit); return explicit;
  }
  const filename = process.platform === 'win32' ? 'arkcli-windows-amd64.exe' : `arkcli-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
  const candidates = [];
  try { candidates.push(join(dirname(require.resolve('@volcengine/ark-cli/package.json')), 'bin', filename)); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
  for (const path of (process.env.PATH ?? '').split(delimiter)) {
    if (!path) continue;
    candidates.push(join(path, process.platform === 'win32' ? 'arkcli.exe' : 'arkcli'));
    candidates.push(join(path, 'node_modules', '@volcengine', 'ark-cli', 'bin', filename));
  }
  for (const path of candidates) try { await access(path); return path; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  throw new Error('未找到官方 ArkCli；请安装后设置 arkCliPath（原生可执行文件）');
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
export class ArkCli {
  constructor({ executable, home, exec = execFile, spawnImpl = spawn }) { Object.assign(this, { executable, home, exec, spawnImpl }); }
  async run(args, { signal, timeout = 30000, plain = false } = {}) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      this.exec(this.executable, [...args, '--format', 'json'], { env: cliEnvironment(this.home), cwd: this.home, windowsHide: true, timeout, maxBuffer: maxBytes, signal, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(new Error(signal?.aborted ? 'ArkCli 操作已取消' : 'ArkCli 操作失败；请检查登录、网络和 CLI 版本（原始输出已隐藏）')); return; }
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
