import { locateCli } from './cli.mjs';
import { arkCliRelease } from './arkcli-release.mjs';
import { installManagedArkCli, managedArkCliPath } from './arkcli-install.mjs';

// One runtime per Host plugin instance, shared by discovery, login, maintenance and settings.
export class ArkCliRuntime {
  constructor({ statePath, explicit, signal, locate = locateCli, install = installManagedArkCli, onInstalled = () => {} }) {
    Object.assign(this, { explicit, signal, locate, install, onInstalled });
    this.release = arkCliRelease();
    this.managed = managedArkCliPath(statePath, this.release);
  }
  async executable({ refresh = false } = {}) {
    if (refresh) this.resolving = undefined;
    const attempt = this.resolving ??= this.locate(this.explicit, { managed: this.managed });
    try { return await attempt; }
    catch (error) {
      if (this.resolving === attempt) this.resolving = undefined;
      throw error;
    }
  }
  view(state, extra = {}) {
    return {
      state,
      platform: this.release?.target ?? `${process.platform}-${process.arch}`,
      ...(this.release ? { version: this.release.version } : {}),
      ...extra
    };
  }
  async status() {
    if (this.job) return this.view('installing');
    try {
      const path = await this.executable({ refresh: true });
      if (this.job) return this.view('installing');
      return this.view('ready', { source: path === this.managed ? 'managed' : this.explicit ? 'configured' : 'host' });
    } catch (error) {
      if (this.job) return this.view('installing');
      if (error.code === 'ARKCLI_CONFIG') return this.view('configured-error');
      if (error.code !== 'ARKCLI_MISSING') return this.view('check-error');
      if (!this.release) return this.view('unsupported');
      return this.failure ? this.view('failed', { message: this.failure }) : this.view('missing');
    }
  }
  async start({ version, platform }) {
    if (!this.release || version !== this.release.version || platform !== this.release.target) {
      throw new Error('ArkCli 平台或版本已变化，请重新检测后再安装。');
    }
    const current = await this.status();
    if (this.job || !['missing', 'failed'].includes(current.state)) return this.job ? this.view('installing') : current;
    this.signal?.throwIfAborted();
    this.failure = undefined;
    const controller = new AbortController();
    this.job = controller;
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    void Promise.resolve().then(() => this.install({ destination: this.managed, release: this.release, signal })).then(() => {
      this.resolving = undefined;
      this.onInstalled();
    }).catch(error => {
      this.failure = error.code === 'ARKCLI_INSTALL' ? error.message : 'ArkCli 安装失败，请重试。';
    }).finally(() => { this.job = undefined; });
    return this.view('installing');
  }
  cancel() {
    this.job?.abort();
    return this.status();
  }
}
