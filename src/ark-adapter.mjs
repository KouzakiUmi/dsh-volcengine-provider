import { messagesStreamOptions } from './messages-payload.mjs';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ROUTES = new Set(['volcengine-agent-plan', 'volcengine-coding-plan']);
const MODES = new Set(['enabled', 'adaptive', 'server-default']);
const COMPAT = [
  'forceAdaptiveThinking', 'allowEmptySignature', 'supportsEagerToolInputStreaming',
  'supportsLongCacheRetention', 'supportsCacheControlOnTools', 'supportsStrictTools',
  'supportsMidConvoSystemMessages', 'supportsMidConvoToolChanges'
];
const PROFILE_OPTIONS = [
  'headers', 'thinkingBudgets', 'cacheRetention', 'transport', 'timeoutMs',
  'websocketConnectTimeoutMs', 'streamIdleTimeoutMs', 'maxRequestImageBytes',
  'requestImagePixelBudget', 'requestImageMaxBytes', 'retryPolicy'
];
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function abortOnReturn(iterator, cancellation) {
  const finish = iterator.return.bind(iterator);
  const reject = iterator.throw.bind(iterator);
  iterator.return = value => { cancellation.abort(); return finish(value); };
  iterator.throw = error => { cancellation.abort(); return reject(error); };
  return iterator;
}

/** 工具被逐模型关闭时，服务端返回的任何工具调用块都视为违约。 */
function carriesToolCall(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  if (chunk.type === 'tool-call-delta') return true;
  if (chunk.type === 'block-start') return chunk.blockType === 'tool-call';
  if (chunk.type === 'block-end') return chunk.block?.type === 'tool-call';
  return chunk.type === 'finish' && chunk.reason?.kind === 'tool-calls';
}

/**
 * Build an isolated public PiAiAdapter composition for one route generation.
 * deps supplies LlmAdapter, LlmError, PiAiAdapter, InMemoryCredentialStore,
 * anthropicMessagesApi and optionally the Core's public resolveRetryPolicy.
 * config.providers is the plain profilesFor result. factsByProvider is a
 * Map<route, Map<exactModelId, row>>; row.messagesThinkingMode,
 * row.canDisableThinking and row.effective.toolsEnabled enter request
 * controls. The tool switch is per model: false asks the API for
 * tool_choice none and blocks any tool call the server returns anyway. resolveApiKey(route) is the
 * sole credential source; the attachment hooks use PiAiAdapterOptions shapes.
 * The returned LlmAdapter also exposes idempotent dispose().
 */
export function createArkAdapter(deps, config) {
  const { LlmAdapter, LlmError, PiAiAdapter, InMemoryCredentialStore, anthropicMessagesApi } = deps;
  const fail = (message, code = 'INVALID_CONFIG') => { throw new LlmError(message, code); };
  const invalid = () => fail('方舟模型或传输配置无效');
  if (!object(config?.providers) || !(config.factsByProvider instanceof Map) || typeof config.resolveApiKey !== 'function') invalid();
  const resolveApiKey = config.resolveApiKey;
  const resolveAttachments = config.resolveAttachments;
  const resolveImageAccess = config.resolveImageAccess;
  const entries = Object.entries(config.providers);
  const specifications = new Map();
  for (const [route, input] of entries) {
    if (!ROUTES.has(route) || !object(input) || input.api !== 'anthropic-messages' || !Array.isArray(input.models)) invalid();
    let url;
    try { url = new URL(input.baseURL); } catch { invalid(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname !== 'ark.cn-beijing.volces.com') invalid();
    const expectedPath = route === 'volcengine-agent-plan' ? '/api/plan' : '/api/coding';
    if (url.pathname.replace(/\/$/, '') !== expectedPath) invalid();
    const facts = config.factsByProvider.get(route);
    if (!(facts instanceof Map)) invalid();
    const profile = {
      provider: route,
      displayName: input.displayName ?? route,
      api: input.api,
      baseURL: input.baseURL,
      streamIdleTimeoutMs: 300000,
      maxRequestImageBytes: 20971520,
      requestImagePixelBudget: 4194304,
      requestImageMaxBytes: 1048576,
      retryPolicy: { mode: 'normal', maxRetries: 5 }
    };
    if (typeof profile.displayName !== 'string' || !profile.displayName.trim()) invalid();
    for (const key of PROFILE_OPTIONS) if (input[key] !== undefined) profile[key] = structuredClone(input[key]);
    if (typeof deps.resolveRetryPolicy === 'function') {
      try { profile.retryPolicy = deps.resolveRetryPolicy(input.retryPolicy, '火山方舟 Provider'); }
      catch { invalid(); }
    } else profile.retryPolicy = { mode: 'normal', maxRetries: 5, ...profile.retryPolicy };
    for (const key of ['streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes', 'timeoutMs', 'websocketConnectTimeoutMs']) {
      if (profile[key] !== undefined && !positive(profile[key])) invalid();
    }
    if (typeof deps.resolveRetryPolicy !== 'function' && (!object(profile.retryPolicy) || profile.retryPolicy.mode !== 'normal' || !Number.isSafeInteger(profile.retryPolicy.maxRetries) || profile.retryPolicy.maxRetries < 0)) invalid();
    if (profile.headers !== undefined) {
      if (!object(profile.headers)) invalid();
      try { new Headers(profile.headers); } catch { invalid(); }
    }
    const models = [];
    const controls = new Map();
    const configuredMaxTokens = new Map();
    const seen = new Set();
    for (const entry of input.models) {
      if (!object(entry) || typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(entry.id) || seen.has(entry.id)) invalid();
      seen.add(entry.id);
      const fact = facts.get(entry.id);
      if (!object(fact)) invalid();
      if (fact.effective !== undefined && !object(fact.effective)) invalid();
      if (fact.effective?.toolsEnabled !== undefined && typeof fact.effective.toolsEnabled !== 'boolean') invalid();
      // 目录里缺少该开关的旧数据按开启处理。
      const toolsEnabled = fact.effective?.toolsEnabled ?? true;
      const mode = fact.messagesThinkingMode ?? 'server-default';
      if (!MODES.has(mode) || (fact.canDisableThinking != null && typeof fact.canDisableThinking !== 'boolean')) invalid();
      if (entry.api !== undefined && entry.api !== input.api) invalid();
      const contextWindow = entry.contextWindow ?? input.defaultContextWindow;
      const maxTokens = entry.maxTokens ?? input.defaultMaxTokens;
      const modalities = entry.input ?? input.defaultInput ?? ['text'];
      const name = entry.name ?? entry.id;
      if (!positive(contextWindow) || !positive(maxTokens) || maxTokens > contextWindow || typeof name !== 'string' || !name.trim() || /[\u0000-\u001f\u007f]/.test(name)) invalid();
      if (!Array.isArray(modalities) || !modalities.length || modalities.some(value => !['text', 'image'].includes(value)) || new Set(modalities).size !== modalities.length) invalid();
      const cost = {};
      if (entry.cost !== undefined && !object(entry.cost)) invalid();
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const value = entry.cost?.[key] ?? 0;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid();
        cost[key] = value;
      }
      const compat = {
        supportsEagerToolInputStreaming: false,
        supportsLongCacheRetention: false,
        supportsCacheControlOnTools: false,
        supportsStrictTools: false,
        supportsMidConvoSystemMessages: false,
        supportsMidConvoToolChanges: false
      };
      for (const source of [input.compat, entry.compat]) {
        if (source !== undefined && !object(source)) invalid();
        for (const key of COMPAT) if (source?.[key] !== undefined) {
          if (typeof source[key] !== 'boolean') invalid();
          compat[key] = source[key];
        }
      }
      compat.forceAdaptiveThinking ??= true;
      const effort = entry.reasoningEfforts;
      if (compat.forceAdaptiveThinking === false && typeof effort?.off === 'string') invalid();
      let reasoning = false;
      let thinkingLevelMap;
      if (effort !== undefined && effort !== false) {
        if (!object(effort) || Object.keys(effort).some(key => !LEVELS.includes(key)) || !Object.keys(effort).some(key => key !== 'off')) invalid();
        thinkingLevelMap = {};
        for (const level of LEVELS) {
          const value = effort[level];
          if (value === undefined) thinkingLevelMap[level] = null;
          else if (value === null && level === 'off') continue;
          else if (typeof value === 'string' && value.trim()) thinkingLevelMap[level] = value;
          else invalid();
        }
        reasoning = true;
      }
      models.push({
        id: entry.id, name, api: input.api, provider: route, baseUrl: input.baseURL,
        contextWindow, maxTokens, input: [...modalities], cost, reasoning, compat,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {})
      });
      if (entry.maxTokens !== undefined) configuredMaxTokens.set(entry.id, entry.maxTokens);
      controls.set(entry.id, {
        messagesThinkingMode: mode,
        canDisableThinking: fact.canDisableThinking ?? null,
        supportsOff: reasoning && Object.hasOwn(effort, 'off'),
        offWire: reasoning ? effort.off : undefined,
        offCarrier: reasoning ? Object.keys(effort).find(level => level !== 'off') : undefined,
        forceAdaptiveThinking: compat.forceAdaptiveThinking,
        toolsEnabled
      });
    }
    specifications.set(route, { profile, models, controls, configuredMaxTokens });
  }
  const api = anthropicMessagesApi();
  if (typeof api?.stream !== 'function' || typeof api?.streamSimple !== 'function') invalid();
  const credentials = new InMemoryCredentialStore();
  const auth = { credentials, authContext: { env: async () => undefined, fileExists: async () => false } };
  const lifetime = new AbortController();
  const active = new Set();
  let disposed = false;
  const ensureLive = () => { if (disposed) fail('方舟模型适配器已卸载', 'ADAPTER_DISPOSED'); };
  const own = (provider, model) => {
    const spec = specifications.get(provider);
    if (!spec) fail('方舟适配器未提供此路由', 'NO_ADAPTER');
    if (model !== undefined && !spec.controls.has(model)) fail('模型不在当前方舟目录中', 'UNKNOWN_MODEL');
    return spec;
  };
  function delegate(control, keyCapture) {
    const profiles = new Map();
    for (const [route, spec] of specifications) {
      const optionsFor = (options, model) => messagesStreamOptions(options, {
        ...spec.controls.get(model.id), reasoningEffort: control?.reasoningEffort,
        toolsEnabled: control?.toolsEnabled ?? spec.controls.get(model.id).toolsEnabled
      });
      profiles.set(route, {
        ...spec.profile,
        modelErrors: new Map(), configuredMaxTokens: new Map(spec.configuredMaxTokens),
        piProvider: {
          id: route, name: spec.profile.displayName, baseUrl: spec.profile.baseURL,
          auth: { apiKey: { name: 'ARK_PROVIDER', resolve: async () => ({ auth: {}, source: 'request' }) } },
          getModels: () => spec.models,
          stream: (model, context, options) => api.stream(model, context, optionsFor(options, model)),
          streamSimple: (model, context, options) => api.streamSimple(model, context, optionsFor(options, model))
        }
      });
    }
    return new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async route => {
        ensureLive();
        own(route);
        let key;
        try { key = await resolveApiKey(route); }
        catch { fail('方舟凭据解析失败', 'CREDENTIAL_RESOLUTION_FAILED'); }
        ensureLive();
        if (typeof key !== 'string' || !key.trim()) fail('未配置方舟认证', 'MISSING_CREDENTIAL');
        if (/[^\x21-\x7e]/.test(key)) fail('方舟凭据格式无效', 'INVALID_CREDENTIAL');
        if (keyCapture) keyCapture.value = key;
        return key;
      },
      auth,
      resolveAttachments,
      resolveImageAccess
    });
  }
  const metadata = delegate();
  const redact = (message, key) => typeof message === 'string' && key ? message.split(key).join('[REDACTED]') : message;
  const safeError = (error, key) => {
    const message = redact(typeof error?.message === 'string' ? error.message : '方舟模型请求失败', key);
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new DOMException(message, error.name);
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'ARK_TRANSPORT_ERROR';
    return new LlmError(message, code);
  };
  class ArkAdapter extends LlmAdapter {
    providerInfo(provider) { ensureLive(); own(provider); return metadata.providerInfo(provider); }
    providerRetryPolicy(provider) { ensureLive(); own(provider); return metadata.providerRetryPolicy(provider); }
    imageRequestPricing(provider, model) { ensureLive(); own(provider, model); return metadata.imageRequestPricing?.(provider, model); }
    imageRequestTarget(provider, model, image) { ensureLive(); own(provider, model); return metadata.imageRequestTarget(provider, model, image); }
    async listModels(provider) {
      ensureLive(); own(provider);
      try { return await metadata.listModels(provider); }
      catch (error) { if (error?.code === 'MISSING_CREDENTIAL') return []; throw safeError(error); }
    }
    resolveModel(provider, model, signal) { ensureLive(); own(provider, model); return metadata.resolveModel(provider, model, signal); }
    async prepareCall(provider, model, signal) {
      ensureLive(); const spec = own(provider, model);
      if (signal?.aborted) fail('方舟请求已取消', 'ABORTED');
      const control = { reasoningEffort: undefined, toolsEnabled: spec.controls.get(model).toolsEnabled };
      const key = { value: undefined };
      const callDelegate = delegate(control, key);
      const prepared = await callDelegate.prepareCall(provider, model, signal);
      ensureLive();
      let consumed = false;
      return {
        model: prepared.model,
        stream: options => {
          if (consumed) fail('已准备的模型请求只能使用一次', 'PREPARED_CALL_CONSUMED');
          consumed = true;
          ensureLive();
          if (!options || options.provider !== provider || options.model !== model) fail('已准备的方舟请求不能切换模型或路由', 'INVALID_REQUEST');
          control.reasoningEffort = options.reasoningEffort;
          if (control.reasoningEffort === 'off') {
            if (spec.controls.get(model).canDisableThinking === false && typeof spec.controls.get(model).offWire !== 'string') fail('该模型不支持关闭思考', 'UNSUPPORTED_REASONING_EFFORT');
            if (!spec.controls.get(model).supportsOff) fail('当前模型未提供关闭思考档位', 'UNSUPPORTED_REASONING_EFFORT');
          }
          const cancellation = new AbortController();
          const iterator = (async function* () {
            ensureLive();
            active.add(cancellation);
            const requestSignal = AbortSignal.any([lifetime.signal, cancellation.signal, ...[signal, options.signal].filter(Boolean)]);
            try {
              if (requestSignal.aborted) fail('方舟请求已取消', 'ABORTED');
              for await (const chunk of prepared.stream({
                ...options,
                // Core omits off. A string mapping needs an enabled SDK request;
                // the local payload hook substitutes its exact saved wire value.
                reasoningEffort: control.reasoningEffort === 'off'
                  ? (typeof spec.controls.get(model).offWire === 'string' ? spec.controls.get(model).offCarrier : undefined)
                  : options.reasoningEffort,
                signal: requestSignal
              })) {
                // 关闭工具调用时不得向上游释放任何完整或增量工具调用。
                if (control.toolsEnabled === false && carriesToolCall(chunk)) {
                  fail('该模型已关闭工具调用，但服务端仍返回了工具调用', 'TOOL_CALL_DISABLED');
                }
                if (chunk.type === 'finish' && chunk.reason?.failure) {
                  yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: redact(chunk.reason.failure.message, key.value) } } };
                } else yield chunk;
              }
            } catch (error) { throw safeError(error, key.value); }
            finally { cancellation.abort(); active.delete(cancellation); key.value = undefined; }
          })();
          // Abort before queuing return/throw, including while next() is waiting.
          return abortOnReturn(iterator, cancellation);
        }
      };
    }
    stream(options) {
      const cancellation = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
      const adapter = this;
      const iterator = (async function* () {
        const prepared = await adapter.prepareCall(options.provider, options.model, signal);
        yield* prepared.stream({ ...options, signal });
      })();
      return abortOnReturn(iterator, cancellation);
    }
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      for (const controller of active) controller.abort();
      active.clear();
    }
  }
  return new ArkAdapter();
}
