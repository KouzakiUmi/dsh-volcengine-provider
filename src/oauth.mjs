import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { cliEnvironment } from './cli.mjs';
import { extractLoginUrl } from './login-url.mjs';

const ACTIVE = new Set(['launching', 'waiting', 'verifying']);
/** 官方 SSO 页面给出的一次性授权码文本（字母数字与 + / = - _ 字符），限制长度，避免把任意文本塞进 CLI argv。 */
const CODE_PATTERN = /^[A-Za-z0-9+/=_-]{8,4096}$/;

/**
 * 拥有官方 CLI 的无浏览器两段式登录任务。
 * 插件不启动浏览器、不拦截系统 opener、不接触 token 端点；授权码只在内存中
 * 交给 CLI 子进程，不写入状态、日志或下发给设置页。
 */
export class ArkOAuth {
  constructor({ spawn, onSuccess, timeoutMs = 300000 }) {
    Object.assign(this, { spawn, onSuccess, timeoutMs });
    this.current = null; this.disposed = false;
  }
  status() {
    return this.current
      ? structuredClone(this.current.public)
      : { jobId: null, accountId: null, state: 'idle', message: '', url: null };
  }
  start({ accountId, executable, home, homeId, revision }) {
    if (this.disposed) throw new Error('插件已卸载');
    if (this.current && ACTIVE.has(this.current.public.state)) throw new Error('已有登录正在进行，请先完成或取消');
    const job = {
      public: { jobId: randomUUID(), accountId, state: 'launching', message: '正在启动官方无浏览器登录', url: null },
      home, homeId, revision, controller: new AbortController(), bytes: 0
    };
    this.current = job;
    job.timer = setTimeout(() => this.finish(job, 'error', '登录超时，请重新开始'), this.timeoutMs);
    job.done = this.run(job, executable);
    return this.status();
  }
  alive(job) { return this.current === job && !this.disposed && !job.controller.signal.aborted; }
  finish(job, state, message) {
    if (!this.alive(job)) return;
    clearTimeout(job.timer);
    Object.assign(job.public, { state, message });
    job.controller.abort();
    if (job.process && job.process.exitCode === null) job.process.kill();
    job.codeResolve?.();
  }
  /** 运行一条官方 CLI 命令，收集受限长度的输出文本（Phase 1 需要解析登录链接）。 */
  async command(job, executable, args, env) {
    if (!this.alive(job)) throw new Error('登录已结束');
    return new Promise((resolve, reject) => {
      const child = this.spawn(executable, args, {
        cwd: job.home, env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], signal: job.controller.signal
      });
      job.process = child;
      let output = '';
      const abort = () => reject(new Error('登录已结束'));
      job.controller.signal.addEventListener('abort', abort, { once: true });
      const collect = chunk => {
        if (!this.alive(job)) return;
        job.bytes += Buffer.byteLength(chunk);
        if (job.bytes > 1024 * 1024) { this.finish(job, 'error', '登录输出异常，已停止'); return; }
        output += chunk.toString('utf8');
      };
      child.stdout?.on('data', collect); child.stderr?.on('data', collect);
      child.once('error', () => { job.controller.signal.removeEventListener('abort', abort); reject(new Error('无法启动 ArkCli')); });
      child.once('close', code => {
        job.controller.signal.removeEventListener('abort', abort);
        if (job.process === child) job.process = undefined;
        if (code === 0 && this.alive(job)) resolve(output);
        else reject(new Error('ArkCli 命令未完成'));
      });
    });
  }
  waitForCode(job) {
    return new Promise((resolve, reject) => {
      job.codeResolve = resolve;
      job.controller.signal.addEventListener('abort', () => reject(new Error('登录已结束')), { once: true });
    });
  }
  submitCode(jobId, code) {
    const job = this.current;
    if (!job || job.public.jobId !== jobId || job.public.state !== 'waiting') throw new Error('当前没有等待授权码的登录任务');
    const trimmed = typeof code === 'string' ? code.trim() : code;
    if (typeof trimmed !== 'string' || !CODE_PATTERN.test(trimmed)) throw new Error('授权码格式不正确');
    job.code = trimmed;
    job.codeResolve?.();
    return this.status();
  }
  async run(job, executable) {
    try {
      await mkdir(job.home, { recursive: true, mode: 0o700 });
      if (!this.alive(job)) return;
      const env = cliEnvironment(job.home);
      // Phase 1：官方 CLI 打印登录链接，并把 PKCE session 落盘到隔离目录后退出。
      const phase1 = await this.command(job, executable, ['auth', 'login', '--no-browser', '--credential-store', 'encrypted-file'], env);
      if (!this.alive(job)) return;
      const url = extractLoginUrl(phase1);
      if (!url) throw new Error('CLI 未输出可核验的官方登录链接');
      job.public.url = url;
      job.public.state = 'waiting';
      job.public.message = '请在任意设备的浏览器打开官方登录链接完成 SSO，把页面显示的授权码粘贴到下方提交';
      if (!this.alive(job)) return;
      // 授权码只经 RPC 存到本 job 内存，不进 public 状态、不落盘。
      const code = await this.waitForCode(job).then(() => job.code);
      if (!this.alive(job) || !code) return;
      // Phase 2：官方 CLI 用落盘 session + 授权码完成交换，凭据仍由 encrypted-file 管理。
      await this.command(job, executable, ['auth', 'login', '--no-browser', '--code', code, '--credential-store', 'encrypted-file'], env);
      job.code = undefined;
      if (!this.alive(job)) return;
      job.public.state = 'verifying';
      job.public.message = '正在核验登录身份与双订阅 profile';
      try {
        await this.onSuccess(job.public.accountId, job.revision, job.controller.signal, job.homeId);
        if (this.alive(job)) this.finish(job, 'success', 'OAuth 登录已完成；两套订阅分别绑定，额度状态请单独刷新');
      } catch { this.finish(job, 'error', 'OAuth 已结束，但订阅身份核验失败或账号设置已改变；请刷新后重试'); }
    } catch { this.finish(job, 'error', '官方无浏览器登录未完成；请检查 ArkCli 的 --no-browser 支持、授权码与本机权限（原始输出已隐藏）'); }
  }
  cancel(jobId) {
    if (this.current?.public.jobId === jobId && ACTIVE.has(this.current.public.state)) this.finish(this.current, 'cancelled', '登录已取消；已由 CLI 写入的隔离凭据不会自动删除');
    return this.status();
  }
  dispose() { if (this.current && ACTIVE.has(this.current.public.state)) this.finish(this.current, 'cancelled', '插件已卸载'); this.disposed = true; }
}
