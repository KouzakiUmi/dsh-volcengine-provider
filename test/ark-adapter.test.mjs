import test from 'node:test';
import assert from 'node:assert/strict';
import { createArkAdapter } from '../src/ark-adapter.mjs';

const ROUTE = 'volcengine-agent-plan';
const OTHER = 'volcengine-coding-plan';
class LlmError extends Error { constructor(message, code) { super(message); this.code = code; } }
class LlmAdapter {}
class InMemoryCredentialStore {}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const state = { delegates: [], requests: [], keys: [], resolvePolicy: [] };
  class PiAiAdapter extends LlmAdapter {
    constructor(config) { super(); this.config = config; state.delegates.push(this); }
    profile(route) { return this.config.profiles().get(route); }
    model(route, id) { return this.profile(route).piProvider.getModels().find(model => model.id === id); }
    providerInfo(route) { return { id: route, name: this.profile(route).displayName }; }
    providerRetryPolicy(route) { return this.profile(route).retryPolicy; }
    imageRequestPricing() { return undefined; }
    imageRequestTarget(route, id, image) { return { width: image.width, height: image.height, maxBytes: this.profile(route).requestImageMaxBytes }; }
    async listModels(route) { await this.config.resolveApiKey(route); return this.profile(route).piProvider.getModels().map(({ id, name }) => ({ provider: route, id, name })); }
    async resolveModel(route, id) {
      const model = this.model(route, id);
      return { provider: route, id, name: model.name, inputModalities: model.input, context: { contextWindow: model.contextWindow }, defaultMaxTokens: this.profile(route).configuredMaxTokens.get(id) };
    }
    async prepareCall(route, id) {
      return { model: await this.resolveModel(route, id), stream: options => this.stream(options) };
    }
    async *stream(options) {
      const profile = this.profile(options.provider);
      const model = this.model(options.provider, options.model);
      if (options.reasoningEffort != null && options.reasoningEffort !== 'off' && (!model.reasoning || model.thinkingLevelMap?.[options.reasoningEffort] === null)) throw new LlmError('unsupported', 'UNSUPPORTED_REASONING_EFFORT');
      const apiKey = await this.config.resolveApiKey(options.provider);
      // Match the target Core seam: off and omission both lose their wire option.
      const reasoning = options.reasoningEffort === 'off' ? undefined : options.reasoningEffort;
      yield* profile.piProvider.streamSimple(model, { messages: options.messages ?? [], tools: options.tools ?? [] }, { reasoning, apiKey, signal: options.signal, maxTokens: options.maxTokens });
    }
  }
  const api = {
    stream(model, context, options) { return api.streamSimple(model, context, options); },
    async *streamSimple(model, context, options) {
      if (state.beforePayload) await state.beforePayload(model);
      const payload = { model: model.id, messages: context.messages, tools: context.tools, max_tokens: options.maxTokens ?? model.maxTokens };
      if (options.reasoning) {
        if (model.compat.forceAdaptiveThinking) {
          payload.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
          payload.output_config = { effort: model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning };
        } else payload.thinking = { type: 'enabled', budget_tokens: 2048, display: 'summarized' };
      } else if (model.thinkingLevelMap?.off !== null) payload.thinking = { type: 'disabled' };
      const actual = await options.onPayload(payload, model);
      state.requests.push({ model, context, options, payload: actual });
      if (state.throwError) throw state.throwError instanceof Error ? state.throwError : new Error(`provider error: ${options.apiKey}`);
      if (state.failureChunk) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: `rejected ${options.apiKey}` } } };
        return;
      }
      yield { type: 'text-delta', text: JSON.stringify(actual) };
      if (state.waitForAbort) {
        await new Promise((resolve, reject) => {
          const abort = () => reject(new LlmError('aborted', 'ABORTED'));
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
  };
  const model = (id, compat) => ({ id, name: id, contextWindow: 100000, maxTokens: 30000, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' }, ...(compat ? { compat } : {}) });
  const providers = {
    [ROUTE]: { api: 'anthropic-messages', baseURL: 'https://ark.cn-beijing.volces.com/api/plan', displayName: 'Agent Plan', models: [model('enabled-version'), model('adaptive-version'), model('budget-version', { forceAdaptiveThinking: false }), model('unknown-version')] },
    [OTHER]: { api: 'anthropic-messages', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', displayName: 'Coding Plan', models: [model('enabled-version')] }
  };
  const factsByProvider = new Map([
    [ROUTE, new Map([
      ['enabled-version', { messagesThinkingMode: 'enabled', canDisableThinking: true }],
      ['adaptive-version', { messagesThinkingMode: 'adaptive', canDisableThinking: false }],
      ['budget-version', { messagesThinkingMode: 'enabled', canDisableThinking: true }],
      ['unknown-version', { messagesThinkingMode: 'server-default', canDisableThinking: null }]
    ])],
    [OTHER, new Map([['enabled-version', { messagesThinkingMode: 'adaptive', canDisableThinking: true }]])]
  ]);
  const deps = {
    LlmAdapter, LlmError, PiAiAdapter, InMemoryCredentialStore, anthropicMessagesApi: () => api,
    resolveRetryPolicy(value, label) { state.resolvePolicy.push([value, label]); return { mode: 'normal', maxRetries: 5, ...value }; }
  };
  const config = { providers, factsByProvider, resolveApiKey: async route => { state.keys.push(route); return 'unit-test-key'; } };
  return { state, deps, config, create: () => createArkAdapter(deps, config) };
}
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
function request(model = 'enabled-version', extra = {}) { return { provider: ROUTE, model, messages: [], ...extra }; }

test('materialized models preserve exact IDs, null-pin maps and strip metadata', async () => {
  const { create, config, state } = fixture();
  config.providers[ROUTE].models[0].reasoningEfforts.medium = 'high';
  config.providers[ROUTE].models[0].capabilityNote = 'metadata only';
  config.providers[ROUTE].models[0].aliases = ['not-the-request-id'];
  const adapter = create();
  const profile = state.delegates[0].profile(ROUTE);
  const model = profile.piProvider.getModels()[0];
  assert.deepEqual(Object.keys(model).sort(), ['api', 'baseUrl', 'compat', 'contextWindow', 'cost', 'id', 'input', 'maxTokens', 'name', 'provider', 'reasoning', 'thinkingLevelMap'].sort());
  assert.equal(model.id, 'enabled-version');
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: 'low', medium: 'high', high: 'high', xhigh: null, max: 'max' });
  assert.equal(model.compat.forceAdaptiveThinking, true);
  assert.equal(profile.streamIdleTimeoutMs, 300000);
  assert.equal(profile.maxRequestImageBytes, 20971520);
  assert.equal(profile.requestImagePixelBudget, 4194304);
  assert.equal(profile.requestImageMaxBytes, 1048576);
  assert.deepEqual(adapter.providerRetryPolicy(ROUTE), { mode: 'normal', maxRetries: 5 });
  assert.equal((await adapter.resolveModel(ROUTE, model.id)).defaultMaxTokens, 30000);
  assert.equal((await adapter.listModels(ROUTE)).length, 4);
  assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: 'Agent Plan' });
  assert.deepEqual(adapter.imageRequestTarget(ROUTE, model.id, { width: 100, height: 50 }), { width: 100, height: 50, maxBytes: 1048576 });
  assert.deepEqual(await profile.piProvider.auth.apiKey.resolve(), { auth: {}, source: 'request' });
  assert.equal(await state.delegates[0].config.auth.authContext.env('ANY_KEY'), undefined);
  assert.equal(await state.delegates[0].config.auth.authContext.fileExists('/credentials'), false);
});

test('credential redaction preserves cancellation and timeout categories', async () => {
  for (const name of ['AbortError','TimeoutError']) {
    const item=fixture();item.state.throwError=new DOMException('stopped unit-test-key',name);
    await assert.rejects(collect(item.create().stream(request('enabled-version',{reasoningEffort:'low'}))),error=>error.name===name&&!error.message.includes('unit-test-key')&&!error.cause);
  }
});

test('off cannot bypass the offered-level check for an unlisted model control', async () => {
  const item=fixture();item.config.providers[ROUTE].models[3].reasoningEfforts=false;
  await assert.rejects(collect(item.create().stream(request('unknown-version',{reasoningEffort:'off'}))),/未提供关闭思考档位/);
  assert.equal(item.state.requests.length,0);
});

test('string off mappings enable native effort and preserve their exact wire value', async () => {
  for(const model of ['enabled-version','adaptive-version','unknown-version']) {
    const item=fixture();const definition=item.config.providers[ROUTE].models.find(row=>row.id===model);
    definition.reasoningEfforts={off:'low',low:'high'};
    const adapter=item.create();await collect(adapter.stream(request(model,{reasoningEffort:'off'})));
    const payload=item.state.requests.at(-1).payload;
    assert.equal(payload.output_config.effort,'low');assert.notEqual(payload.thinking.type,'disabled');
    await collect(adapter.stream(request(model,{reasoningEffort:'low'})));assert.equal(item.state.requests.at(-1).payload.output_config.effort,'high');
  }
  const budget=fixture();budget.config.providers[ROUTE].models.find(row=>row.id==='budget-version').reasoningEfforts={off:'low',low:'low'};
  assert.throws(()=>budget.create(),/配置无效/);
});

test('public retry resolver is authoritative and fallback uses the known normal policy', () => {
  const item = fixture();
  item.deps.resolveRetryPolicy = () => ({ mode: 'unlimited', maxRetries: Infinity });
  assert.deepEqual(item.create().providerRetryPolicy(ROUTE), { mode: 'unlimited', maxRetries: Infinity });
  const fallback = fixture();
  delete fallback.deps.resolveRetryPolicy;
  assert.deepEqual(fallback.create().providerRetryPolicy(ROUTE), { mode: 'normal', maxRetries: 5 });
});

test('attachment hooks are forwarded to public Core without extra history conversion', () => {
  const item = fixture();
  const attachments = () => undefined;
  const imageAccess = () => undefined;
  item.config.resolveAttachments = attachments;
  item.config.resolveImageAccess = imageAccess;
  item.create();
  assert.equal(item.state.delegates[0].config.resolveAttachments, attachments);
  assert.equal(item.state.delegates[0].config.resolveImageAccess, imageAccess);
});

test('source mutation cannot change captured models, facts, knobs or credential binding', async () => {
  const { create, config, state } = fixture();
  config.providers[ROUTE].requestImageMaxBytes = 1234;
  config.providers[ROUTE].retryPolicy = { mode: 'normal', maxRetries: 2 };
  const adapter = create();
  const prepared = await adapter.prepareCall(ROUTE, 'enabled-version');
  config.providers[ROUTE].models[0].name = 'changed';
  config.factsByProvider.get(ROUTE).get('enabled-version').messagesThinkingMode = 'adaptive';
  config.resolveApiKey = async () => 'different-binding';
  await collect(prepared.stream(request('enabled-version', { reasoningEffort: 'max' })));
  assert.equal(state.requests[0].options.apiKey, 'unit-test-key');
  assert.equal(state.requests[0].model.name, 'enabled-version');
  assert.deepEqual(state.requests[0].payload.thinking, { type: 'enabled' });
  assert.equal(state.delegates[0].profile(ROUTE).requestImageMaxBytes, 1234);
  assert.deepEqual(adapter.providerRetryPolicy(ROUTE), { mode: 'normal', maxRetries: 2 });
});

test('native effort matrix, omission, explicit off and budget use independent controls', async () => {
  const { create, state } = fixture();
  const adapter = create();
  const history = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'prior', signature: 'original' }] }];
  for (const [model, type] of [['enabled-version', 'enabled'], ['adaptive-version', 'adaptive']]) {
    for (const reasoningEffort of ['low', 'high', 'max']) {
      await collect(adapter.stream(request(model, { reasoningEffort, messages: history })));
      const last = state.requests.at(-1);
      assert.equal(last.payload.model, model);
      assert.deepEqual(last.payload.thinking, { type });
      assert.deepEqual(last.payload.output_config, { effort: reasoningEffort });
      assert.equal(last.context.messages, history);
    }
    await collect(adapter.stream(request(model)));
    assert.ok(!Object.hasOwn(state.requests.at(-1).payload, 'thinking'));
    assert.ok(!Object.hasOwn(state.requests.at(-1).payload, 'output_config'));
  }
  await collect(adapter.stream(request('enabled-version', { reasoningEffort: 'off' })));
  assert.deepEqual(state.requests.at(-1).payload.thinking, { type: 'disabled' });
  await assert.rejects(collect(adapter.stream(request('adaptive-version', { reasoningEffort: 'off' }))), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  await collect(adapter.stream(request('budget-version', { reasoningEffort: 'high' })));
  assert.deepEqual(state.requests.at(-1).payload.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.ok(!state.requests.at(-1).payload.output_config);
  await collect(adapter.stream(request('unknown-version', { reasoningEffort: 'high' })));
  assert.equal(state.requests.at(-1).payload.thinking.type, 'adaptive');
  await collect(adapter.stream(request('unknown-version')));
  assert.ok(!state.requests.at(-1).payload.thinking);
  await assert.rejects(collect(adapter.stream(request('enabled-version', { reasoningEffort: 'medium' }))), { code: 'UNSUPPORTED_REASONING_EFFORT' });
});

test('parallel prepared calls cannot cross-contaminate raw effort, route or mode', async () => {
  const { create, state } = fixture();
  const adapter = create();
  const gate = deferred();
  const entered = deferred();
  state.beforePayload = async model => { if (model.id === 'enabled-version' && model.provider === ROUTE) { entered.resolve(); await gate.promise; } };
  const one = await adapter.prepareCall(ROUTE, 'enabled-version');
  const two = await adapter.prepareCall(OTHER, 'enabled-version');
  const first = collect(one.stream(request('enabled-version', { reasoningEffort: 'off' })));
  await entered.promise;
  await collect(two.stream(request('enabled-version', { provider: OTHER, reasoningEffort: 'max' })));
  gate.resolve();
  await first;
  assert.deepEqual(state.requests.find(item => item.model.provider === ROUTE).payload.thinking, { type: 'disabled' });
  assert.deepEqual(state.requests.find(item => item.model.provider === OTHER).payload.thinking, { type: 'adaptive' });
});

test('missing/invalid keys and resolver exceptions never leak credentials', async () => {
  for (const value of [undefined, null, '', ' ', 7]) {
    const { create, config } = fixture();
    config.resolveApiKey = async () => value;
    const adapter = create();
    assert.deepEqual(await adapter.listModels(ROUTE), []);
    await assert.rejects(collect(adapter.stream(request())), { code: 'MISSING_CREDENTIAL' });
  }
  const broken = fixture();
  broken.config.resolveApiKey = async () => { throw new Error('secret-value'); };
  await assert.rejects(broken.create().listModels(ROUTE), error => error.code === 'CREDENTIAL_RESOLUTION_FAILED' && !String(error).includes('secret-value'));
  const invalid = fixture();
  invalid.config.resolveApiKey = async () => 'secret\nvalue';
  await assert.rejects(invalid.create().listModels(ROUTE), error => error.code === 'INVALID_CREDENTIAL' && !String(error).includes('secret'));
});

test('SDK thrown and in-band errors redact the request key without retaining causes', async () => {
  const { create, state } = fixture();
  const adapter = create();
  state.throwError = true;
  await assert.rejects(collect(adapter.stream(request('enabled-version', { reasoningEffort: 'high' }))), error => {
    assert.equal(error.code, 'ARK_TRANSPORT_ERROR');
    assert.ok(!String(error.stack).includes('unit-test-key'));
    assert.equal(error.cause, undefined);
    return true;
  });
  state.throwError = false;
  state.failureChunk = true;
  const chunks = await collect(adapter.stream(request()));
  assert.equal(chunks[0].reason.failure.message, 'rejected [REDACTED]');
});

test('prepared calls are single-use and cannot change exact model or provider', async () => {
  const { create } = fixture();
  const adapter = create();
  const prepared = await adapter.prepareCall(ROUTE, 'enabled-version');
  await collect(prepared.stream(request()));
  assert.throws(() => prepared.stream(request()), { code: 'PREPARED_CALL_CONSUMED' });
  const swapped = await adapter.prepareCall(ROUTE, 'enabled-version');
  assert.throws(() => swapped.stream(request('adaptive-version')), { code: 'INVALID_REQUEST' });
  assert.throws(() => adapter.providerInfo('other-provider'), { code: 'NO_ADAPTER' });
  await assert.rejects(adapter.prepareCall(ROUTE, 'not-the-request-id'), { code: 'UNKNOWN_MODEL' });
});

test('dispose aborts active streams; unconsumed preparation has no active work', async () => {
  const { create, state } = fixture();
  const adapter = create();
  const pending = await adapter.prepareCall(ROUTE, 'enabled-version');
  assert.equal(state.keys.length, 0);
  state.waitForAbort = true;
  const active = adapter.stream(request())[Symbol.asyncIterator]();
  await active.next();
  const waiting = active.next();
  adapter.dispose();
  adapter.dispose();
  await assert.rejects(waiting, { code: 'ABORTED' });
  assert.equal(state.requests[0].options.signal.aborted, true);
  assert.throws(() => pending.stream(request()), { code: 'ADAPTER_DISPOSED' });
  assert.throws(() => adapter.resolveModel(ROUTE, 'enabled-version'), { code: 'ADAPTER_DISPOSED' });
});

test('caller/prepare cancellation and consumer return cancel only their own stream', async () => {
  const { create, state } = fixture();
  const adapter = create();
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(adapter.prepareCall(ROUTE, 'enabled-version', aborted.signal), { code: 'ABORTED' });
  const caller = new AbortController();
  state.waitForAbort = true;
  const stream = adapter.stream(request('enabled-version', { signal: caller.signal }))[Symbol.asyncIterator]();
  await stream.next();
  const waiting = stream.next();
  caller.abort();
  await assert.rejects(waiting, { code: 'ABORTED' });
  state.waitForAbort = false;
  const next = adapter.stream(request('budget-version'))[Symbol.asyncIterator]();
  await next.next();
  await next.return();
  assert.equal(state.requests.at(-1).options.signal.aborted, true);
  await collect(adapter.stream(request('adaptive-version', { reasoningEffort: 'max' })));
});

test('invalid route/model/facts fail before a delegate is constructed', () => {
  const changes = [
    value => { value.config.providers.evil = value.config.providers[ROUTE]; },
    value => { value.config.providers[ROUTE].baseURL = 'https://elsewhere.invalid/api/plan'; },
    value => { value.config.providers[ROUTE].api = 'openai-completions'; },
    value => { value.config.providers[ROUTE].models[0].contextWindow = -1; },
    value => { value.config.providers[ROUTE].models.push(value.config.providers[ROUTE].models[0]); },
    value => { value.config.providers[ROUTE].models[0].reasoningEfforts.low = null; },
    value => { value.config.providers[ROUTE].models[0].reasoningEfforts.guess = 'high'; },
    value => { value.config.providers[ROUTE].models[0].reasoningEfforts = {}; },
    value => { value.config.providers[ROUTE].models[0].input = ['text', 'video']; },
    value => { value.config.factsByProvider.get(ROUTE).delete('enabled-version'); },
    value => { value.config.factsByProvider.get(ROUTE).get('enabled-version').messagesThinkingMode = 'guessed'; }
  ];
  for (const change of changes) {
    const item = fixture(); change(item);
    assert.throws(item.create, { code: 'INVALID_CONFIG' });
    assert.equal(item.state.delegates.length, 0);
  }
});

test('consumer return interrupts a pending next for direct and prepared streams', async () => {
  for (const preparedMode of [false, true]) {
    const { create, state } = fixture();
    const adapter = create();
    state.waitForAbort = true;
    const prepared = preparedMode ? await adapter.prepareCall(ROUTE, 'enabled-version') : undefined;
    const stream = prepared ? prepared.stream(request()) : adapter.stream(request());
    await stream.next();
    const waiting = stream.next();
    const returning = stream.return();
    await assert.rejects(waiting, { code: 'ABORTED' });
    assert.equal((await returning).done, true);
    assert.equal(state.requests[0].options.signal.aborted, true);
  }
});
