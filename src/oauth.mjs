import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { cliEnvironment } from './cli.mjs';
import { authorizeInBrowser } from './oauth-browser.mjs';
import { createBrowserBridge, verifyBrowserBridgeCli } from './browser-bridge.mjs';
export { approvedLoginUrl } from './oauth-browser.mjs';

const ACTIVE = new Set(['launching', 'waiting', 'verifying']);
/** Owns CLI, its private URL-opener bridge and the isolated browser. */
export class ArkOAuth {
  constructor({ spawn, onSuccess, browserAuthorize = authorizeInBrowser, bridgeFactory = createBrowserBridge, verifyCli = verifyBrowserBridgeCli, timeoutMs = 300000 }) {
    Object.assign(this, { spawn, onSuccess, browserAuthorize, bridgeFactory, verifyCli, timeoutMs });
    this.current = null; this.disposed = false;
  }
  status() { return this.current ? structuredClone(this.current.public) : { jobId: null, state: 'idle', message: '' }; }
  start({ accountId, executable, home, homeId, revision }) {
    if (this.disposed) throw new Error('插件已卸载');
    if (this.current && ACTIVE.has(this.current.public.state)) throw new Error('已有登录正在进行，请先完成或取消');
    const job = { public: { jobId: randomUUID(), accountId, state: 'launching', message: '正在启动 ArkCli 官方同设备登录' }, home, homeId, revision, controller: new AbortController(), bytes: 0 };
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
  }
  async command(job, executable, args, env) {
    if (!this.alive(job)) throw new Error('登录已结束');
    return new Promise((resolve, reject) => {
      const child = this.spawn(executable, args, {
        cwd: job.home, env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], signal: job.controller.signal
      });
      job.process = child;
      const abort = () => reject(new Error('登录已结束'));
      job.controller.signal.addEventListener('abort', abort, { once: true });
      const collect = chunk => {
        if (!this.alive(job)) return;
        job.bytes += Buffer.byteLength(chunk);
        if (job.bytes > 1024 * 1024) this.finish(job, 'error', '登录输出异常，已停止');
      };
      child.stdout?.on('data', collect); child.stderr?.on('data', collect);
      child.once('error', () => { job.controller.signal.removeEventListener('abort', abort); reject(new Error('无法启动 ArkCli')); });
      child.once('close', code => {
        job.controller.signal.removeEventListener('abort', abort);
        if (job.process === child) job.process = undefined;
        if (code === 0 && this.alive(job)) resolve();
        else reject(new Error('ArkCli 登录未完成'));
      });
    });
  }
  async run(job, executable) {
    let bridge;
    try {
      await mkdir(job.home, { recursive: true, mode: 0o700 });
      if (!this.alive(job)) return;
      await this.verifyCli(executable, { env: cliEnvironment(job.home), cwd: job.home, signal: job.controller.signal });
      if (!this.alive(job)) return;
      bridge = await this.bridgeFactory({ signal: job.controller.signal, onLaunch: url => {
        if (!this.alive(job)) throw new Error('登录已结束');
        job.public.message = '请在独立 Chrome 窗口完成方舟官方登录，完成后会自动回调并关闭窗口';
        job.browserTask = Promise.resolve().then(() => this.browserAuthorize(url, job.controller.signal));
        void job.browserTask.then(
          () => { if (this.alive(job)) this.finish(job, 'error', '登录窗口已关闭，官方 CLI 尚未确认登录完成'); },
          () => { if (this.alive(job)) this.finish(job, 'error', '无法完成独立浏览器登录，请检查 Chrome 与本机权限'); }
        );
      } });
      if (!this.alive(job)) return;
      job.public.state = 'waiting'; job.public.message = '正在准备方舟官方同设备授权页面';
      // Force the official broker flow: no legacy/default-browser fallback, no
      // cross-device code page. Only this child's PATH contains the URL bridge.
      await this.command(job, executable, ['auth', 'login', '--login-mode', 'broker', '--credential-store', 'encrypted-file'], bridge.environment(cliEnvironment(job.home)));
      if (!this.alive(job)) return;
      if (!job.browserTask) throw new Error('CLI 未使用受控浏览器启动桥');
      job.public.state = 'verifying'; job.public.message = '正在核验登录身份与双订阅 profile';
      try {
        await this.onSuccess(job.public.accountId, job.revision, job.controller.signal, job.homeId);
        if (this.alive(job)) this.finish(job, 'success', 'OAuth 登录已完成；两套订阅分别绑定，额度状态请单独刷新');
      } catch { this.finish(job, 'error', 'OAuth 已结束，但订阅身份核验失败或账号设置已改变；请刷新后重试'); }
    } catch { this.finish(job, 'error', '官方同设备登录未完成；请检查 ArkCli broker 支持、浏览器启动桥或本机权限（原始输出已隐藏）'); }
    finally {
      await bridge?.close();
      await job.browserTask?.catch(() => {});
    }
  }
  cancel(jobId) {
    if (this.current?.public.jobId === jobId && ACTIVE.has(this.current.public.state)) this.finish(this.current, 'cancelled', '登录已取消；已由 CLI 写入的隔离凭据不会自动删除');
    return this.status();
  }
  dispose() { if (this.current && ACTIVE.has(this.current.public.state)) this.finish(this.current, 'cancelled', '插件已卸载'); this.disposed = true; }
}
