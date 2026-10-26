import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { cliEnvironment } from './cli.mjs';

const ACTIVE = new Set(['launching', 'waiting', 'verifying']);
export function approvedLoginUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    if (url.hostname === 'ark.volcengine.com' && /\/arkcli\/login\/?$/.test(url.pathname)) return raw;
    if (url.hostname === 'signin.volcengine.com' && url.pathname.startsWith('/authorize/')) return raw;
  } catch { /* Not a URL. */ }
  return undefined;
}
/** Owns only the child CLI process; OAuth, nonce/PKCE and token storage stay in the official CLI. */
export class ArkOAuth {
  constructor({ spawn, onSuccess, timeoutMs = 300000 }) {
    Object.assign(this, { spawn, onSuccess, timeoutMs });
    this.current = null; this.disposed = false;
  }
  status() { return this.current ? structuredClone(this.current.public) : { jobId: null, state: 'idle', message: '' }; }
  start({ accountId, executable, home, revision }) {
    if (this.disposed) throw new Error('插件已卸载');
    if (this.current && ACTIVE.has(this.current.public.state)) throw new Error('已有登录正在进行，请先完成或取消');
    const job = { public: { jobId: randomUUID(), accountId, state: 'launching', message: '正在启动 ArkCli 官方 OAuth 登录窗口' }, home, revision, controller: new AbortController(), bytes: 0, tail: '' };
    this.current = job;
    job.timer = setTimeout(() => this.finish(job, 'error', '登录超时，请重新开始'), this.timeoutMs);
    void this.run(job, executable);
    return this.status();
  }
  alive(job) { return this.current === job && !this.disposed && !job.controller.signal.aborted; }
  finish(job, state, message) {
    if (!this.alive(job)) return;
    clearTimeout(job.timer);
    Object.assign(job.public, { state, message });
    delete job.public.url;
    job.controller.abort();
    if (job.process && job.process.exitCode === null) job.process.kill();
    job.tail = '';
  }
  async run(job, executable) {
    try {
      await mkdir(job.home, { recursive: true, mode: 0o700 });
      if (!this.alive(job)) return;
      // The native CLI owns browser launch and the loopback callback. No hand-built nonce or token endpoint.
      const child = this.spawn(executable, ['auth', 'login', 'volc-sso'], {
        cwd: job.home, env: cliEnvironment(job.home), windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], signal: job.controller.signal
      });
      job.process = child;
      job.public.state = 'waiting';
      job.public.message = '请在 ArkCli 打开的官方网页完成授权；凭据仅保存在本插件的隔离账号目录';
      const collect = chunk => {
        if (!this.alive(job)) return;
        job.bytes += Buffer.byteLength(chunk);
        if (job.bytes > 1024 * 1024) { this.finish(job, 'error', '登录输出异常，已停止'); return; }
        // Only a strictly allowlisted authorize URL crosses the Host boundary. Never forward raw CLI output.
        job.tail = (job.tail + chunk.toString('utf8')).slice(-16384);
        for (const match of job.tail.matchAll(/https:\/\/(?:(?!https:\/\/)[^\s<>"'\u001b])+/g)) {
          const url = approvedLoginUrl(match[0]);
          if (url) job.public.url = url;
        }
      };
      child.stdout?.on('data', collect); child.stderr?.on('data', collect);
      child.once('error', () => this.finish(job, 'error', '无法启动 ArkCli OAuth，请检查可执行文件和本机权限'));
      child.once('close', code => {
        void (async () => {
          if (!this.alive(job)) return;
          if (code !== 0) { this.finish(job, 'error', 'ArkCli 登录未完成；未读取或显示其原始输出'); return; }
          job.public.state = 'verifying'; job.public.message = '正在核验登录身份与双订阅 profile';
          try {
            await this.onSuccess(job.public.accountId, job.revision, job.controller.signal);
            if (this.alive(job)) this.finish(job, 'success', 'OAuth 登录已完成；两套订阅分别绑定，额度状态请单独刷新');
          } catch { this.finish(job, 'error', 'OAuth 已结束，但订阅身份核验失败或账号设置已改变；请刷新后重试'); }
        })();
      });
    } catch { this.finish(job, 'error', '无法启动 ArkCli 登录；请检查本机安装与权限'); }
  }
  cancel(jobId) {
    if (this.current?.public.jobId === jobId && ACTIVE.has(this.current.public.state)) this.finish(this.current, 'cancelled', '登录已取消；已由 CLI 写入的隔离凭据不会自动删除');
    return this.status();
  }
  dispose() { if (this.current && ACTIVE.has(this.current.public.state)) this.finish(this.current, 'cancelled', '插件已卸载'); this.disposed = true; }
}
