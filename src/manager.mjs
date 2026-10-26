import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { StateStore, account, assertBudgetCompatibleEfforts, assertModelId, assertPlan, normalizeModelSettings, PLANS, ROUTES, revision } from './state.mjs';
import { catalogStatus, effectiveModel, getModelRows, normalizeCatalog } from './catalog.mjs';
import { ArkCli, locateCli } from './cli.mjs';
import { ArkOAuth } from './oauth.mjs';
import { fetchUsage, parseAgentUsage, parseCodingUsage } from './quota.mjs';

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
    this.oauth = new ArkOAuth({ spawn: spawnImpl, onSuccess: (id, rev, signal) => this.bindLogin(id, rev, signal) });
    this.onChange = async () => {}; this.operations = Promise.resolve();
  }
  owner(id) {
    if (typeof id !== 'string') throw new Error('请选择账号');
    const owner = this.store.current.accounts.find(a => a.id === id);
    if (!owner) throw new Error('账号不存在');
    return owner;
  }
  async cli(owner) {
    const home = join(dirname(this.store.path), 'accounts', owner.id);
    if (this.cliFactory) return this.cliFactory(owner, home);
    return new ArkCli({ executable: await locateCli(this.arkCliPath), home });
  }
  clearCaches() {
    this.cacheGeneration++;
    this.cache.clear(); this.inflight.clear(); this.inferenceCache.clear(); this.inferenceInflight.clear();
  }
  async inferenceKey(owner, plan, selection = { binding: this.store.current.oauth?.[owner.id] }) {
    if (this.disposed) throw new Error('插件已卸载');
    const binding = selection.binding;
    if (binding) {
      const profile = binding.profiles[plan];
      if (!profile) return undefined; // Never borrow a different identity/key pool after OAuth binding.
      const cacheKey = revision({ accountId: owner.id, plan, profile, loggedAt: binding.loggedAt });
      const cached = this.inferenceCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 30000) return cached.value;
      if (this.inferenceInflight.has(cacheKey)) return this.inferenceInflight.get(cacheKey);
      const generation = this.cacheGeneration;
      const task = (async () => {
        try {
          const key = await (await this.cli(owner)).apiKey(profile, this.life.signal);
          if (typeof key !== 'string' || !key || /\s/.test(key) || key.length > 4096) throw new Error('ArkCli 未返回有效推理凭据');
          if (this.disposed || this.life.signal.aborted) throw new Error('插件已卸载');
          if (generation === this.cacheGeneration) this.inferenceCache.set(cacheKey, { at: Date.now(), value: key });
          return key;
        } finally { if (this.inferenceInflight.get(cacheKey) === task) this.inferenceInflight.delete(cacheKey); }
      })();
      this.inferenceInflight.set(cacheKey, task);
      return task;
    }
    const ref = owner.apiKeyRefs[plan];
    return ref ? await this.resolveRef(ref) : undefined;
  }
  async read() {
    const state = this.store.current;
    if (!state) throw new Error(this.routingError || '无法读取账号元数据；原文件未覆盖');
    const accounts = await Promise.all(state.accounts.map(async owner => {
      const oauth = state.oauth[owner.id];
      const hasApiKeys = {};
      for (const plan of PLANS) hasApiKeys[plan] = oauth ? Boolean(oauth.profiles[plan]) : Boolean(owner.apiKeyRefs[plan] && await this.resolveRef(owner.apiKeyRefs[plan]));
      const hasQuotaKeys = oauth ? true : Boolean(owner.accessKeyRef && owner.secretKeyRef && await this.resolveRef(owner.accessKeyRef) && await this.resolveRef(owner.secretKeyRef));
      return { ...owner, hasApiKeys, hasQuotaKeys, authMode: oauth ? 'oauth' : 'references' };
    }));
    return {
      revision: revision(state), accounts, active: { ...state.active }, enabled: { ...state.enabled }, routes: ROUTES,
      ...(this.routingError ? { routingError: this.routingError } : {}),
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
      })), login: this.oauth.status()
    };
  }
  async bindLogin(id, rev, signal) {
    const owner = this.owner(id);
    const cli = await this.cli(owner);
    const identity = await cli.whoami(signal);
    if (identity?.logged_in !== true) throw new Error('CLI 未确认 OAuth 登录身份');
    const profiles = planProfiles(await cli.status(signal));
    if (signal.aborted || this.disposed) throw new Error('登录已取消');
    await this.store.mutate(rev, next => { next.oauth[id] = { profiles, loggedAt: new Date().toISOString() }; return next; }, { signal });
    this.clearCaches();
    await this.onChange();
  }
  async quota(plan, id, force) {
    assertPlan(plan); const owner = this.owner(id);
    const fingerprint = revision({ owner, binding: this.store.current.oauth[id] });
    const key = `${id}:${plan}:${fingerprint}`;
    const cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.at < 60000) return structuredClone(cached.value);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const generation = this.cacheGeneration;
    const task = (async () => {
      await Promise.resolve();
      const base = { accountId: id, plan, updatedAt: new Date().toISOString() };
      try {
        let parsed;
        const binding = this.store.current.oauth[id];
        if (binding) {
          const profile = binding.profiles[plan];
          if (!profile) return { ...base, state: 'no-key', windows: [], error: '此 OAuth 账号未绑定该订阅' };
          const cli = await this.cli(owner);
          const action = plan === 'agent-plan' ? 'usage.get_afp_usage' : 'usage.get_coding_plan_usage';
          const raw = await cli.run(['api', action, '--params', '{}', '--profile', profile], { signal: this.life.signal });
          // Raw OpenAPI owns the AFP daily window; usage plan intentionally omits it.
          const payload = plan === 'agent-plan' && raw && !raw.Result && ['AFPFiveHour', 'AFPWeekly', 'AFPMonthly', 'AFPDaily'].some(field => Object.hasOwn(raw, field)) ? { Result: raw } : raw;
          parsed = (plan === 'agent-plan' ? parseAgentUsage : parseCodingUsage)(payload);
        } else {
          const accessKeyId = owner.accessKeyRef ? await this.resolveRef(owner.accessKeyRef) : undefined;
          const secretAccessKey = owner.secretKeyRef ? await this.resolveRef(owner.secretKeyRef) : undefined;
          if (!accessKeyId || !secretAccessKey) return { ...base, state: 'no-key', windows: [], error: '额度查询需要 IAM AK/SK，不是推理 API Key；也可使用网页登录' };
          parsed = await fetchUsage(plan, { accessKeyId, secretAccessKey }, { ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}), signal: this.life.signal });
        }
        const { plan: planName, ...usage } = parsed;
        const value = { ...base, state: parsed.windows.length ? 'ok' : 'error', ...usage, ...(planName ? { planName } : {}), ...(!parsed.windows.length ? { error: '接口未返回可展示的额度窗口；未确认订阅或额度状态' } : {}) };
        if (!this.disposed && generation === this.cacheGeneration) this.cache.set(key, { at: Date.now(), value });
        return structuredClone(value);
      } catch {
        return { ...base, state: 'error', windows: [], error: '额度读取失败；请检查该账号的鉴权、权限、网络及 CLI 版本' };
      } finally { if (this.inflight.get(key) === task) this.inflight.delete(key); }
    })();
    this.inflight.set(key, task); return task;
  }
  async invoke(request) {
    if (this.disposed) throw new Error('插件已卸载');
    if (!request || typeof request !== 'object') throw new Error('请求格式错误');
    const { op } = request;
    if (op === 'read') return this.read();
    if (op === 'loginStatus') return this.oauth.status();
    if (op === 'cancelLogin') return this.oauth.cancel(request.jobId);
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
      const cli = await this.cli(this.owner(accountId));
      return this.oauth.start({ accountId, executable: cli.executable, home: cli.home, revision: request.revision });
    }
    let catalog;
    if (op === 'models') {
      assertPlan(plan); const owner = this.owner(accountId);
      const profile = this.store.current.oauth[accountId]?.profiles[plan] ?? owner.cliProfile;
      if (!profile) throw new Error('请先为此账号网页登录，或填写其隔离 ArkCli profile 名称');
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
        modelRow(next, accountId, plan, request.modelId);
        const key = `${accountId}:${plan}`;
        const bucket = { ...(next.modelSettings[key] ?? {}) };
        bucket[request.modelId] = { ...(bucket[request.modelId] ?? {}), enabled: request.enabled };
        next.modelSettings[key] = bucket;
      } else if (op === 'saveModelSettings') {
        assertPlan(plan); this.owner(accountId); assertModelId(request.modelId);
        const settings = normalizeModelSettings(request.settings ?? {});
        const row = modelRow(next, accountId, plan, request.modelId);
        const effective = effectiveModel(row.defaults, settings);
        if (effective.maxTokens > effective.contextWindow) throw new Error('maxTokens 不得超过有效 contextWindow');
        if (settings.defaultReasoning !== undefined && settings.defaultReasoning !== null) {
          const efforts = effective.reasoningEfforts;
          if (!efforts || efforts === false || !(settings.defaultReasoning in efforts)) throw new Error('默认思考档位未被有效思考档位映射支持');
        }
        assertBudgetCompatibleEfforts(effective.reasoningEfforts, effective.forceAdaptiveThinking);
        const key = `${accountId}:${plan}`;
        const bucket = { ...(next.modelSettings[key] ?? {}) };
        const previous = bucket[request.modelId] ?? {};
        // 参数整份替换；启用开关只有显式给出时才改写。
        const { enabled, ...parameters } = settings;
        const kept = enabled === undefined && previous.enabled !== undefined ? { enabled: previous.enabled } : {};
        bucket[request.modelId] = enabled === undefined ? { ...kept, ...parameters } : { ...settings };
        next.modelSettings[key] = bucket;
      } else if (op === 'resetModelSettings') {
        assertPlan(plan); this.owner(accountId); assertModelId(request.modelId);
        const key = `${accountId}:${plan}`;
        const bucket = { ...(next.modelSettings[key] ?? {}) };
        delete bucket[request.modelId];
        if (Object.keys(bucket).length) next.modelSettings[key] = bucket; else delete next.modelSettings[key];
      }
      else throw new Error('未知操作');
      return next;
    });
    this.clearCaches(); await this.onChange(); return this.read();
  }
  dispose() { this.disposed = true; this.oauth.dispose(); this.life.abort(); this.clearCaches(); }
}
