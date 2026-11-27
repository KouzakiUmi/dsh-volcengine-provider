import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StateStore, account, assertBudgetCompatibleEfforts, assertModelId, assertPlan, normalizeModelSettings, normalizeIdentity, PLANS, ROUTES, revision } from './state.mjs';
import { catalogStatus, effectiveModel, getModelRows, normalizeCatalog, overrideKeys } from './catalog.mjs';
import { ArkCli, locateCli } from './cli.mjs';
import { ArkOAuth } from './oauth.mjs';
import { fetchUsage, parseAgentUsage, parseCodingUsage } from './quota.mjs';
import { defaultMediaState, mediaToolEnabled, normalizeMediaState } from './media.mjs';
import { QuotaSnapshotStore } from './snapshot.mjs';
import { readOAuthExpiry } from './oauth-expiry.mjs';

// 中间层参数：额度由 Host 定期采集，Client 只读快照。
const QUOTA_TTL = 60000;
const QUOTA_BACKOFF_MAX = 8;
const CATALOG_TTL = 15 * 60000;
const COLLECT_TICK = 15000;

export function planProfiles(status) {
  if (!Array.isArray(status?.profiles_summary)) throw new Error('CLI 身份摘要缺少 profiles_summary，请核对 ArkCli 版本');
  const profiles = {};
  for (const plan of PLANS) {
    const rows = status.profiles_summary.filter(p => p.type === plan);
    if (rows.length > 1) throw new Error('同一订阅存在多个 profile，请在 CLI 中确认后再登录绑定');
    if (rows.length === 1) {
      if (typeof rows[0].name !== 'string' || !rows[0].name || rows[0].name.length > 200) throw new Error('CLI profile 名称格式错误');
      profiles[plan] = rows[0].name;
    }
  }
  if (!Object.keys(profiles).length) throw new Error('登录身份没有可用的个人 Agent/Coding 套餐 profile');
  return profiles;
}
/** 目录中必须已有该模型：设置不得凭空造出目录里不存在的模型。 */
function modelRow(state, accountId, plan, modelId) {
	const row = getModelRows(state, accountId, plan).find(item => item.id === modelId);
	if (!row) throw new Error('模型不在当前目录中，请先刷新模型目录');
	return row;
}

export class ArkController {
  constructor({ statePath, arkCliPath, resolveRef, cliFactory, fetchImpl, spawnImpl = spawn }) {
    this.store = new StateStore(statePath); this.arkCliPath = arkCliPath;
    this.resolveRef = resolveRef; this.cliFactory = cliFactory; this.fetchImpl = fetchImpl;
    this.life = new AbortController(); this.disposed = false; this.cache = new Map(); this.inflight = new Map();
    this.inferenceCache = new Map(); this.inferenceInflight = new Map(); this.cacheGeneration = 0;
    this.identityCache = new Map(); this.identityInflight = new Map();
    this.expiryCache = new Map();
    // 失败负缓存与按账号串行锁：凭据/登录失效时避免反复 spawn ArkCli 拖慢宿主。
    this.inferenceFailure = new Map(); this.executablePromise = undefined; this.quotaQueue = new Map();
    // 中间层：Host 定期采集的额度快照（内存 + 同目录原子落盘），Client 只读不触发采集。
    this.quotaSnapshots = new QuotaSnapshotStore({ path: join(dirname(statePath), 'quota-snapshot.json') });
    this.quotaFailures = new Map(); this.catalogFailures = new Map(); this.catalogInflight = new Map();
    this.collectorTimer = null; this.collecting = false;
    this.oauth = new ArkOAuth({ spawn: spawnImpl, onSuccess: (id, rev, signal, homeId) => this.bindLogin(id, rev, signal, homeId) });
    this.onChange = async () => {}; this.operations = Promise.resolve();
  }
  owner(id) {
    if (typeof id !== 'string') throw new Error('请选择账号');
    const owner = this.store.current.accounts.find(a => a.id === id);
    if (!owner) throw new Error('账号不存在');
    return owner;
  }
  /** 账号隔离 CLI home：新绑定用会话目录，旧绑定沿用账号根目录。 */
  homeFor(owner, binding = this.store.current.oauth?.[owner.id]) {
    const root = join(dirname(this.store.path), 'accounts', owner.id);
    return binding?.homeId ? join(root, 'sessions', binding.homeId) : root;
  }
  async cli(owner, binding = this.store.current.oauth?.[owner.id]) {
    const home = this.homeFor(owner, binding);
    if (this.cliFactory) return this.cliFactory(owner, home);
    // 定位可执行文件的 PATH/require 探测只做一次；失败不缓存，保证装上 CLI 后能恢复。
    this.executablePromise ??= locateCli(this.arkCliPath);
    let executable;
    try { executable = await this.executablePromise; }
    catch (error) { this.executablePromise = undefined; throw error; }
    return new ArkCli({ executable, home });
  }
  /** 同一账号的额度查询串行执行：两个套餐同时刷新时不并发 spawn 多个 ArkCli。 */
  async withQuotaLock(id, task) {
    const previous = this.quotaQueue.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(() => {}, () => {});
    this.quotaQueue.set(id, settled);
    try { return await next; }
    finally { if (this.quotaQueue.get(id) === settled) this.quotaQueue.delete(id); }
  }
  /**
   * 清身份与推理缓存。额度快照默认保留（采集器会按 TTL 刷新）；
   * 凭据引用变化、重新登录、卸载这类身份级事件传 quotas: true 一并作废。
   * 失败退避表随身份/凭据事件一起清：修正凭据或重新登录后不能让旧的
   * 退避继续抑制额度（最长 8 分钟）与目录（最长 1 小时）的自动重采。
   */
  clearCaches({ quotas = false, persist = true } = {}) {
    this.cacheGeneration++;
    this.cache.clear(); this.inflight.clear(); this.inferenceCache.clear(); this.inferenceInflight.clear();
    this.identityCache.clear(); this.identityInflight.clear(); this.inferenceFailure.clear();
    this.expiryCache.clear(); this.quotaFailures.clear(); this.catalogFailures.clear();
    if (quotas) {
      this.quotaSnapshots.entries.clear();
      // 卸载时只清内存，不再排队落盘：避免与调用方删除数据目录竞争。
      if (persist) this.quotaSnapshots.save();
    }
  }
  async inferenceKey(owner, plan, selection = { binding: this.store.current.oauth?.[owner.id] }) {
    if (this.disposed) throw new Error('插件已卸载');
    const binding = selection.binding;
    if (binding) {
      const profile = binding.profiles[plan];
      if (!profile) return undefined; // Never borrow a different identity/key pool after OAuth binding.
      const cacheKey = revision({ accountId: owner.id, plan, profile, loggedAt: binding.loggedAt, homeId: binding.homeId });
      // 同一失败在 20 秒内直接复用：登录/协议失效时不要再为每条请求 spawn 一次 ArkCli。
      const failure = this.inferenceFailure.get(cacheKey);
      if (failure && Date.now() - failure.at < 20000) throw failure.error;
      const cached = this.inferenceCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 30000) return cached.value;
      if (this.inferenceInflight.has(cacheKey)) return this.inferenceInflight.get(cacheKey);
      const generation = this.cacheGeneration;
      const task = (async () => {
        try {
          const key = await (await this.cli(owner, binding)).apiKey(profile, this.life.signal);
          if (typeof key !== 'string' || !key || /\s/.test(key) || key.length > 4096) throw new Error('ArkCli 未返回有效推理凭据');
          if (this.disposed || this.life.signal.aborted) throw new Error('插件已卸载');
          if (generation === this.cacheGeneration) this.inferenceCache.set(cacheKey, { at: Date.now(), value: key });
          return key;
        } catch (error) {
          if (this.disposed || this.life.signal.aborted) throw error;
          const wrapped = new Error(error?.arkKind === 'auth'
            ? '方舟登录凭据需要重新确认：请在插件设置页重新网页登录（ArkCli SSO）后重试'
            : '方舟推理凭据获取失败：请检查登录状态、网络与 ArkCli 版本');
          wrapped.cause = error;
          wrapped.arkKind = error?.arkKind ?? 'unknown';
          if (generation === this.cacheGeneration) this.inferenceFailure.set(cacheKey, { at: Date.now(), error: wrapped });
          throw wrapped;
        } finally { if (this.inferenceInflight.get(cacheKey) === task) this.inferenceInflight.delete(cacheKey); }
      })();
      this.inferenceInflight.set(cacheKey, task);
      return task;
    }
    const ref = owner.apiKeyRefs[plan];
    return ref ? await this.resolveRef(ref) : undefined;
  }
  async identityFor(owner, binding) {
    if (!binding) return undefined;
    if (binding.identity) return normalizeIdentity(binding.identity);
    // Older metadata discarded whoami. Recover only the public identity, without rewriting credentials.
    const key = revision({ id: owner.id, binding });
    if (this.identityCache.has(key)) return this.identityCache.get(key);
    if (this.identityInflight.has(key)) return this.identityInflight.get(key);
    const generation = this.cacheGeneration;
    const task = (async () => {
      await Promise.resolve();
      try {
        const signal = AbortSignal.any([this.life.signal, AbortSignal.timeout(3000)]);
        const raw = await (await this.cli(owner, binding)).whoami(signal);
        if (raw?.logged_in !== true) return undefined;
        const identity = normalizeIdentity({ name: raw.name, userId: raw.user_id, accountId: raw.account_id });
        if (!this.disposed && generation === this.cacheGeneration) this.identityCache.set(key, identity);
        return identity;
      } catch { return undefined; }
      finally { if (this.identityInflight.get(key) === task) this.identityInflight.delete(key); }
    })();
    this.identityInflight.set(key, task);
    return task;
  }
  async read() {
    const state = this.store.current;
    if (!state) throw new Error(this.routingError || '无法读取账号元数据；原文件未覆盖');
    const accounts = await Promise.all(state.accounts.map(async owner => {
      const oauth = state.oauth[owner.id];
      const hasApiKeys = {};
      let credentialError = false;
      const available = async ref => {
        if (!ref) return false;
        try { return Boolean(await this.resolveRef(ref)); }
        catch { credentialError = true; return false; }
      };
      for (const plan of PLANS) hasApiKeys[plan] = oauth ? Boolean(oauth.profiles[plan]) : await available(owner.apiKeyRefs[plan]);
      const hasQuotaKeys = oauth ? Object.keys(oauth.profiles).length > 0 : Boolean(await available(owner.accessKeyRef) && await available(owner.secretKeyRef));
      const identity = await this.identityFor(owner, oauth);
      const hasQuotaAccess = Object.fromEntries(PLANS.map(plan => [plan, oauth ? Boolean(oauth.profiles[plan]) : hasQuotaKeys]));
      return { ...owner, displayName: identity?.name || (identity?.accountId ? `方舟账号 ${identity.accountId}` : owner.label),
        ...(identity ? { identity } : {}), ...(oauth ? { oauthProfiles: { ...oauth.profiles }, loggedAt: oauth.loggedAt, oauthExpiresAt: await this.oauthExpiry(owner, oauth) } : {}),
        ...(credentialError ? { credentialError: '凭据服务检查失败；可编辑引用或稍后刷新重试。' } : {}),
        hasApiKeys, hasQuotaKeys, hasQuotaAccess, authMode: oauth ? 'oauth' : 'references' };
    }));
    return {
      revision: revision(state), accounts, active: { ...state.active }, enabled: { ...state.enabled }, routes: ROUTES,
      ...(this.routingError ? { routingError: this.routingError } : {}),
      ...(this.appliedAccounts ? { appliedAccounts: structuredClone(this.appliedAccounts) } : {}),
      catalogs: state.accounts.flatMap(a => PLANS.map(plan => {
        const status = catalogStatus(state, a.id, plan);
        const models = getModelRows(state, a.id, plan);
        return {
          accountId: a.id, plan,
          count: status.broken ? 0 : status.count,
          enabledCount: models.filter(model => model.enabled).length,
          source: status.source,
          ...(status.broken ? { error: '模型缓存损坏，请重新拉取模型' } : {}),
          ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
          models
        };
      })), login: this.oauth.status(),
      media: { ...state.media },
      // 中间层：额度快照随 read 一起下发，设置页首屏不需要再发查询请求。
      quotas: this.snapshotView().quotas
    };
  }
  /**
   * OAuth 登录态到期时间（ISO 字符串）：只读 refresh_token 的 exp 元数据，按绑定缓存；
   * 官方 SSO 续期不延长 refresh_token，该值即登录态权威到期。未知时 null。
   */
  async oauthExpiry(owner, binding) {
    if (!binding) return null;
    const key = revision({ id: owner.id, homeId: binding.homeId ?? null, loggedAt: binding.loggedAt });
    if (this.expiryCache.has(key)) return this.expiryCache.get(key);
    const expiry = await readOAuthExpiry(this.homeFor(owner, binding));
    const value = expiry === null ? null : new Date(expiry).toISOString();
    if (!this.disposed) this.expiryCache.set(key, value);
    return value;
  }
  async bindLogin(id, rev, signal, homeId) {
    const owner = this.owner(id);
    const cli = await this.cli(owner, homeId ? { homeId } : undefined);
    const identity = await cli.whoami(signal);
    if (identity?.logged_in !== true) throw new Error('CLI 未确认 OAuth 登录身份');
    const profiles = planProfiles(await cli.status(signal));
    if (signal.aborted || this.disposed) throw new Error('登录已取消');
    const summary = normalizeIdentity({ name: identity.name, userId: identity.user_id, accountId: identity.account_id });
    await this.store.mutate(rev, next => {
      next.oauth[id] = { profiles, loggedAt: new Date().toISOString(), identity: summary, ...(homeId ? { homeId } : {}) };
      // A new login may be a different cloud identity; its old remote catalog is no longer authoritative.
      for (const plan of PLANS) delete next.catalogs[`${id}:${plan}`];
      return next;
    }, { signal });
    this.clearCaches({ quotas: true });
    // Identity was already verified and committed. A routing failure is a separate, visible state.
    try { await this.onChange(); }
    catch { this.routingError ??= '登录身份已保存，但模型路由更新失败；此前可用路由仍保留。'; }
  }
  /** 账号+套餐的采集指纹：身份、绑定或凭据引用变化后旧快照自动失效。 */
  quotaFingerprint(id) {
    const owner = this.store.current?.accounts.find(a => a.id === id);
    if (!owner) return null;
    return revision({ owner, binding: this.store.current.oauth?.[id] });
  }
  /** 中间层视图：Client 只读这里，不触发任何上游请求。 */
  snapshotView() {
    const quotas = {};
    for (const [key, entry] of Object.entries(this.quotaSnapshots.map())) {
      const [id] = key.split(':');
      const fingerprint = this.quotaFingerprint(id);
      if (!fingerprint) continue;
      if (!this.quotaSnapshots.get(key, fingerprint)) continue;
      quotas[key] = entry;
    }
    return { revision: revision(this.store.current), quotas };
  }
  /**
   * Client 读额度：有中间层快照就直接返回，过期只在后台补采，读取本身不等上游。
   * force=true 才清掉快照并立即重采（对应「刷新额度」）。
   */
  async quota(plan, id, force) {
    assertPlan(plan); this.owner(id);
    const key = `${id}:${plan}`;
    const fingerprint = this.quotaFingerprint(id);
    if (force) this.quotaSnapshots.delete(key);
    const entry = force ? undefined : this.quotaSnapshots.get(key, fingerprint);
    if (entry) {
      if (Date.now() - entry.at >= QUOTA_TTL) void this.collectQuota(plan, id).catch(() => {});
      return structuredClone(entry.value);
    }
    // 手动刷新要能突破退避：force 时忽略失败退避，立即重采。
    return this.collectQuota(plan, id, { force });
  }
  /** 取上次成功值作底：刷新失败时保留窗口，只附加失败原因。 */
  mergeQuotaSnapshot(key, fingerprint, value) {
    const previous = this.quotaSnapshots.get(key, fingerprint)?.value;
    if (value.state !== 'ok' && previous?.state === 'ok' && Array.isArray(previous.windows) && previous.windows.length) {
      return { ...previous, refreshError: value.error ?? '额度更新失败', errorKind: value.errorKind, refreshFailedAt: value.updatedAt };
    }
    return value;
  }
  /** 真正拉取一次额度并写入中间层；失败按次数退避，避免登录失效时反复 spawn CLI。 */
  collectQuota(plan, id, { force = false } = {}) {
    assertPlan(plan);
    const owner = this.owner(id);
    const binding = this.store.current.oauth[id];
    const fingerprint = this.quotaFingerprint(id);
    const key = `${id}:${plan}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const failure = this.quotaFailures.get(key);
    // 退避期内不重试（手动刷新例外）：没有快照时返回上次失败结论，也不 spawn CLI。
    if (!force && failure && failure.until > Date.now()) {
      const cached = this.quotaSnapshots.get(key, fingerprint)?.value ?? failure.value;
      if (cached) return Promise.resolve(structuredClone(cached));
    }
    const task = this.withQuotaLock(id, async () => {
      await Promise.resolve();
      let value;
      const base = { accountId: id, plan, updatedAt: new Date().toISOString() };
      try {
        let parsed;
        if (binding) {
          const profile = binding.profiles[plan];
          if (!profile) value = { ...base, state: 'no-key', windows: [], error: '此 OAuth 账号未绑定该订阅' };
          else {
            const cli = await this.cli(owner, binding);
            const action = plan === 'agent-plan' ? 'usage.get_afp_usage' : 'usage.get_coding_plan_usage';
            // 额度查询是后台刷新：给比默认更短的超时，避免 CLI 卡住时占着账号串行锁。
            const raw = await cli.run(['api', action, '--params', '{}', '--profile', profile], { signal: this.life.signal, timeout: 15000 });
            // Raw OpenAPI owns the AFP daily window; usage plan intentionally omits it.
            const payload = plan === 'agent-plan' && raw && !raw.Result && ['AFPFiveHour', 'AFPWeekly', 'AFPMonthly', 'AFPDaily'].some(field => Object.hasOwn(raw, field)) ? { Result: raw } : raw;
            parsed = (plan === 'agent-plan' ? parseAgentUsage : parseCodingUsage)(payload);
          }
        } else {
          const accessKeyId = owner.accessKeyRef ? await this.resolveRef(owner.accessKeyRef) : undefined;
          const secretAccessKey = owner.secretKeyRef ? await this.resolveRef(owner.secretKeyRef) : undefined;
          if (!accessKeyId || !secretAccessKey) value = { ...base, state: 'no-key', windows: [], error: '额度查询需要 IAM AK/SK，不是推理 API Key；也可使用网页登录' };
          else parsed = await fetchUsage(plan, { accessKeyId, secretAccessKey }, { ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), signal: this.life.signal });
        }
        if (!value) {
          const { plan: planName, ...usage } = parsed;
          value = { ...base, state: parsed.windows.length ? 'ok' : 'error', ...usage, ...(planName ? { planName } : {}), ...(!parsed.windows.length ? { error: '接口未返回可展示的额度窗口；未确认订阅或额度状态' } : {}) };
        }
      } catch (error) {
        // 登录/协议失效时给出可操作结论；失败也进中间层与退避表，轮询重试不再反复 spawn ArkCli。
        const kind = error?.arkKind ?? 'unknown';
        value = {
          ...base,
          state: kind === 'auth' ? 'no-key' : 'error',
          windows: [],
          errorKind: kind,
          error: kind === 'auth'
            ? 'OAuth 登录凭据需要重新确认：请在账号区重新网页登录（ArkCli SSO）后重试'
            : kind === 'network'
              ? '额度查询超时或网络不可用；稍后会自动重试'
              : '额度读取失败；请检查该账号的鉴权、权限、网络及 CLI 版本'
        };
      }
      const merged = this.mergeQuotaSnapshot(key, fingerprint, value);
      if (!this.disposed) this.quotaSnapshots.set(key, fingerprint, merged);
      if (merged.state === 'ok') this.quotaFailures.delete(key);
      else {
        const count = Math.min((this.quotaFailures.get(key)?.count ?? 0) + 1, 3);
        this.quotaFailures.set(key, { count, until: Date.now() + QUOTA_TTL * Math.min(2 ** count, QUOTA_BACKOFF_MAX), value: structuredClone(merged) });
      }
      if (this.inflight.get(key) === task) this.inflight.delete(key);
      return structuredClone(merged);
    });
    this.inflight.set(key, task);
    return task;
  }
  /** 采集模型目录并写回状态文件；失败退避，冲突交给下一轮重试。 */
  collectCatalog(plan, id) {
    assertPlan(plan);
    const owner = this.owner(id);
    const binding = this.store.current.oauth[id];
    const profile = binding ? binding.profiles[plan] : owner.cliProfile;
    const key = `${id}:${plan}`;
    if (!profile) return Promise.resolve(undefined);
    const running = this.catalogInflight.get(key);
    if (running) return running;
    const failure = this.catalogFailures.get(key);
    if (failure && failure.until > Date.now()) return Promise.resolve(undefined);
    const task = (async () => {
      try {
        const catalog = normalizeCatalog(plan, await (await this.cli(owner)).models(plan, profile, this.life.signal));
        if (this.disposed) return undefined;
        // 采集写入可能撞上用户编辑：跳过后下一轮再试，不覆盖别人刚保存的设置。
        await this.store.mutate(revision(this.store.current), next => { next.catalogs[key] = catalog; return next; });
        this.catalogFailures.delete(key);
        try { await this.onChange(); }
        catch { this.routingError ??= '模型路由更新失败；设置已同步，实际路由仍为此前账号。'; }
        return catalog;
      } catch (error) {
        // 与用户编辑撞 revision 不是故障：跳过这一轮，不进入长退避。
        if (!/设置已改变/.test(String(error?.message ?? ''))) {
          const count = Math.min((this.catalogFailures.get(key)?.count ?? 0) + 1, 4);
          this.catalogFailures.set(key, { count, until: Date.now() + CATALOG_TTL * Math.min(2 ** (count - 1), 4) });
        }
        throw error;
      } finally { if (this.catalogInflight.get(key) === task) this.catalogInflight.delete(key); }
    })();
    this.catalogInflight.set(key, task);
    return task;
  }
  /** 一轮采集：只处理已启用且有选中账号的套餐；额度每 QUOTA_TTL、目录每 CATALOG_TTL 刷新。 */
  async collectOnce() {
    if (this.disposed || this.collecting || !this.store.current) return;
    this.collecting = true;
    try {
      const state = this.store.current;
      const jobs = [];
      for (const plan of PLANS) {
        if (state.enabled?.[plan] === false) continue;
        const id = state.active?.[plan];
        if (!id || !state.accounts.some(a => a.id === id)) continue;
        const fingerprint = this.quotaFingerprint(id);
        const quota = this.quotaSnapshots.get(`${id}:${plan}`, fingerprint);
        if (!quota || Date.now() - quota.at >= QUOTA_TTL) jobs.push(this.collectQuota(plan, id).catch(() => {}));
        const catalog = state.catalogs?.[`${id}:${plan}`];
        const updatedAt = catalog?.updatedAt ? Date.parse(catalog.updatedAt) : NaN;
        if (!Number.isFinite(updatedAt) || Date.now() - updatedAt >= CATALOG_TTL) jobs.push(this.collectCatalog(plan, id).catch(() => {}));
      }
      this.quotaSnapshots.prune(key => {
        const [id] = key.split(':');
        return Boolean(this.quotaFingerprint(id));
      });
      await Promise.allSettled(jobs);
    } finally { this.collecting = false; }
  }
  /** 启动后台采集；与设置页是否打开无关。 */
  startCollector() {
    if (this.collectorTimer || this.disposed) return;
    void this.collectOnce();
    this.collectorTimer = setInterval(() => { void this.collectOnce(); }, COLLECT_TICK);
    if (typeof this.collectorTimer.unref === 'function') this.collectorTimer.unref();
  }
  stopCollector() {
    if (this.collectorTimer) clearInterval(this.collectorTimer);
    this.collectorTimer = null;
  }
  async invoke(request) {
    if (this.disposed) throw new Error('插件已卸载');
    if (!request || typeof request !== 'object') throw new Error('请求格式错误');
    const { op } = request;
    if (op === 'read') {
      const read = this.operations.then(async () => {
        if (await this.store.refresh()) {
          this.clearCaches();
          try { await this.onChange(); }
          catch { this.routingError ??= '模型路由更新失败；设置已同步，实际路由仍为此前账号。'; }
        }
        return this.read();
      });
      this.operations = read.catch(() => {});
      return read;
    }
    if (op === 'loginStatus') return this.oauth.status();
    // 轻量读取中间层：只读内存快照与状态 revision，不触发任何上游请求。
    if (op === 'snapshots') return this.snapshotView();
    if (op === 'cancelLogin') return this.oauth.cancel(request.jobId);
    if (op === 'submitLoginCode') return this.oauth.submitCode(request.jobId, request.code);
    if (op === 'quota') return this.quota(request.plan, request.accountId, request.force === true);
    // Serialize account/model/login mutations across all browser tabs.
    const next = this.operations.then(() => this.change(request));
    this.operations = next.catch(() => {});
    return next;
  }
  async change(request) {
    if (request.revision !== revision(this.store.current)) throw new Error('设置已改变，请刷新后重试');
    if (this.disposed) throw new Error('插件已卸载');
    const { op, accountId, plan } = request;
    if (op === 'startLogin') {
      this.owner(accountId);
      const homeId = randomUUID();
      const cli = await this.cli(this.owner(accountId), { homeId });
      return this.oauth.start({ accountId, executable: cli.executable, home: cli.home, homeId, revision: request.revision });
    }
    let catalog;
    if (op === 'models') {
      assertPlan(plan); const owner = this.owner(accountId);
      const binding = this.store.current.oauth[accountId];
      const profile = binding ? binding.profiles[plan] : owner.cliProfile;
      if (!profile) throw new Error(binding
        ? '此 OAuth 账号未绑定该套餐；请确认个人套餐订阅后重新网页登录，填写其他 profile 不会切换身份'
        : '请先为此账号网页登录，或填写其隔离 ArkCli profile 名称；也可继续使用本地模型快照');
      const cli = await this.cli(owner);
      catalog = normalizeCatalog(plan, await cli.models(plan, profile, this.life.signal));
    }
    if (this.disposed) throw new Error('插件已卸载');
    await this.store.mutate(request.revision, next => {
      if (op === 'saveAccount') {
        const owner = account(request.account);
        const index = next.accounts.findIndex(a => a.id === owner.id);
        if (index < 0) next.accounts.push(owner); else next.accounts[index] = owner;
      } else if (op === 'removeAccount') {
        this.owner(accountId);
        if (this.oauth.status().accountId === accountId && ['launching', 'waiting', 'verifying'].includes(this.oauth.status().state)) throw new Error('请先取消该账号的登录');
        next.accounts = next.accounts.filter(a => a.id !== accountId);
        delete next.oauth[accountId];
        for (const p of PLANS) { if (next.active[p] === accountId) next.active[p] = null; delete next.catalogs[`${accountId}:${p}`]; delete next.modelSettings[`${accountId}:${p}`]; }
      } else if (op === 'select') {
        assertPlan(plan); if (accountId !== null) this.owner(accountId); next.active[plan] = accountId;
      } else if (op === 'models') next.catalogs[`${accountId}:${plan}`] = catalog;
      else if (op === 'setProviderEnabled') {
        assertPlan(plan);
        if (typeof request.enabled !== 'boolean') throw new Error('套餐启用状态必须是布尔值');
        next.enabled[plan] = request.enabled;
      } else if (op === 'setModelEnabled') {
        assertPlan(plan); this.owner(accountId); assertModelId(request.modelId);
        if (typeof request.enabled !== 'boolean') throw new Error('模型启用状态必须是布尔值');
        const row = modelRow(next, accountId, plan, request.modelId);
        const key = `${accountId}:${plan}`;
        const bucket = { ...(next.modelSettings[key] ?? {}) };
        // 旧目录把设置记在历史键下；写入时带上已生效的设置，避免只保存开关就丢掉用户参数。
        bucket[request.modelId] = { ...row.settings, enabled: request.enabled };
        next.modelSettings[key] = bucket;
      } else if (op === 'saveModelSettings') {
        assertPlan(plan); this.owner(accountId); assertModelId(request.modelId);
        const settings = normalizeModelSettings(request.settings ?? {});
        const row = modelRow(next, accountId, plan, request.modelId);
        const selectedEfforts = settings.reasoningEfforts === undefined ? row.defaults.reasoningEfforts : settings.reasoningEfforts;
        if (row.canDisableThinking === false && (selectedEfforts?.off === null || (settings.defaultReasoning === 'off' && typeof selectedEfforts?.off !== 'string'))) throw new Error('该模型为常驻思考，不支持关闭档位；请移除 off:null 映射或继承模型默认。');
        const effective = effectiveModel(row.defaults, settings);
        if (effective.maxTokens > effective.contextWindow) throw new Error('maxTokens 不得超过有效 contextWindow');
        if (settings.defaultReasoning !== undefined && settings.defaultReasoning !== null) {
          const efforts = effective.reasoningEfforts;
          if (!efforts || efforts === false || !(settings.defaultReasoning in efforts)) throw new Error('默认思考档位未被有效思考档位映射支持');
        }
        assertBudgetCompatibleEfforts(settings.reasoningEfforts === undefined ? row.defaults.reasoningEfforts : settings.reasoningEfforts, effective.forceAdaptiveThinking);
        const key = `${accountId}:${plan}`;
        const bucket = { ...(next.modelSettings[key] ?? {}) };
        // 同 setModelEnabled：参数整份替换时以当前生效设置为基线，含历史键里保存的值。
        const previous = row.settings;
        // 参数整份替换；启用开关只有显式给出时才改写。
        const { enabled, ...parameters } = settings;
        const kept = enabled === undefined && previous.enabled !== undefined ? { enabled: previous.enabled } : {};
        bucket[request.modelId] = enabled === undefined ? { ...kept, ...parameters } : { ...settings };
        next.modelSettings[key] = bucket;
      } else if (op === 'resetModelSettings') {
        assertPlan(plan); this.owner(accountId); assertModelId(request.modelId);
        const key = `${accountId}:${plan}`;
        const bucket = { ...(next.modelSettings[key] ?? {}) };
        // 恢复默认必须同时清掉历史键，否则读取时仍会回退到旧覆盖。
        for (const id of overrideKeys(request.modelId)) delete bucket[id];
        if (Object.keys(bucket).length) next.modelSettings[key] = bucket; else delete next.modelSettings[key];
      }
      else if (op === 'setMedia') {
        next.media = normalizeMediaState({
          ...next.media,
          ...(request.riskAcknowledged !== undefined ? { riskAcknowledged: request.riskAcknowledged === true } : {}),
          ...(request.imageTool !== undefined ? { imageTool: request.imageTool === true } : {}),
          ...(request.imageModel !== undefined ? { imageModel: request.imageModel } : {})
        });
      }
      else throw new Error('未知操作');
      return next;
    });
    this.clearCaches(); await this.onChange(); return this.read();
  }
  media() {
    return this.store.current?.media ?? defaultMediaState();
  }
  mediaEnabled(key) {
    return mediaToolEnabled(this.media(), key);
  }
  /** 媒体工具运行时上下文：附件服务、账号清单与推理凭据。 */
  mediaContext() {
    const state = this.store.current;
    const accountIds = state ? state.accounts.map(a => a.id) : [];
    return {
      media: this.media(),
      accountIds,
      credentials: async accountId => {
        const current = this.store.current;
        if (!current) throw new Error('账号状态不可用');
        const active = current.active['agent-plan'];
        if (active === null || active === undefined) throw new Error('Agent Plan 未选择账号，请先在设置页选择账号');
        const id = accountId ?? active;
        const owner = this.owner(id);
        const binding = current.oauth[id];
        const key = await this.inferenceKey(owner, 'agent-plan', { binding });
        if (!key) throw new Error(binding ? '此账号未绑定 Agent Plan profile' : `凭据引用 ${owner.apiKeyRefs['agent-plan']} 无法解析`);
        return { accountId: id, key };
      }
    };
  }
  dispose() { this.disposed = true; this.stopCollector(); this.oauth.dispose(); this.life.abort(); this.clearCaches({ quotas: true, persist: false }); this.quotaSnapshots.close(); }
}
