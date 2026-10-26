// Optional real-Core test. Every HTTP request receives a local fake response.
import './host-resolve.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const captured = [];
globalThis.fetch = async (_url, options) => {
  captured.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'OFFLINE_SMOKE_STOP' } }), { status: 400, headers: { 'content-type': 'application/json' } });
};
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry');
const { CredentialProvider } = await import('@deepseek-ai/dsh-credentials');
const plugin = await import('../src/index.mjs');
const { initialState, ROUTES } = await import('../src/state.mjs');
const { normalizeCatalog } = await import('../src/catalog.mjs');
const home = await mkdtemp(join(tmpdir(), 'ark-model-management-'));
const statePath = join(home, 'state.json');
const ctx = new Context();
const forks = [];
class FakeCredentials extends CredentialProvider {
  async resolve() { return { value: 'offline-fake-key', source: 'fixture' }; }
}
const provider = ROUTES['agent-plan'];
const model = 'new-model-without-capability-metadata';
const messages = [{ role: 'user', content: [{ type: 'text', text: 'offline smoke' }] }];
async function consume(stream) {
  const events = [];
  try { for await (const event of stream) events.push(event); }
  catch (error) { events.push({ code: error.code, message: error.message }); }
  return events;
}
try {
  const seed = initialState();
  seed.version = 1;
  delete seed.enabled; delete seed.modelSettings;
  seed.catalogs['default:agent-plan'] = normalizeCatalog('agent-plan', { plan: 'agent-plan', models: [{ model_id: model, model_name: 'New model' }] });
  const originalBytes = JSON.stringify(seed);
  await writeFile(statePath, originalBytes);
  for (const implementation of [TypertRegistry, LlmRuntime, FakeCredentials]) {
    const fork = ctx.plugin(implementation); forks.push(fork); await fork;
  }
  const pluginFork = ctx.plugin(plugin, { statePath }); forks.push(pluginFork); await pluginFork;
  for (let i = 0; i < 100 && !ctx.get('volcengineProvider'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const service = ctx.get('volcengineProvider'); assert.ok(service);
  let view = await service.invoke({ op: 'read' });
  assert.equal(await readFile(statePath, 'utf8'), originalBytes, 'Reading a legacy state must not rewrite it');
  assert.equal(view.enabled['agent-plan'], true);
  async function change(request) { view = await service.invoke({ ...request, revision: view.revision }); return view; }
  const info = await ctx.llm.resolveModelInfo(provider, model);
  assert.equal(info.reasoning, undefined, 'Unknown model must not receive invented thinking levels');
  const beforeUnknown = captured.length;
  await consume(ctx.llm.registration(provider).adapter.stream({ provider, model, messages }));
  assert.equal(captured.length, beforeUnknown + 1, 'Unknown model must reach the fake transport instead of failing on default low');
  assert.equal(captured.at(-1).thinking, undefined);
  await change({ op: 'setProviderEnabled', plan: 'agent-plan', enabled: false });
  assert.equal(view.active['agent-plan'], 'default');
  assert.ok(!ctx.llm.listProviders().some(row => row.id === provider));
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 2);
  await change({ op: 'setProviderEnabled', plan: 'agent-plan', enabled: true });
  assert.ok(ctx.llm.listProviders().some(row => row.id === provider));
  await change({ op: 'setModelEnabled', accountId: 'default', plan: 'agent-plan', modelId: model, enabled: false });
  assert.ok(!(await ctx.llm.listModels(provider)).some(row => row.id === model));
  await change({ op: 'setModelEnabled', accountId: 'default', plan: 'agent-plan', modelId: model, enabled: true });
  const settings = { contextWindow: 131072, maxTokens: 10000, temperature: 0.2, reasoningEfforts: { off: null, low: 'low', high: 'high' }, defaultReasoning: 'high', forceAdaptiveThinking: true };
  await change({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: model, settings });
  const configured = await ctx.llm.resolveModelInfo(provider, model);
  assert.equal(configured.context.contextWindow, 131072);
  assert.equal(configured.defaultMaxTokens, 10000);
  assert.equal(configured.reasoning.defaultEffort, 'high');
  await change({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: model, settings: { ...settings, defaultReasoning: 'off' } });
  const adaptiveOff = await ctx.llm.prepareCall({ provider, model });
  assert.equal(adaptiveOff.config.reasoningEffort, 'off');
  await consume(adaptiveOff.stream({ ...adaptiveOff.config, messages }));
  assert.deepEqual(captured.at(-1).thinking, { type: 'disabled' });
  assert.equal(captured.at(-1).output_config, undefined);
  await change({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: model, settings });
  const prepared = await ctx.llm.prepareCall({ provider, model, reasoningEffort: 'off', maxTokens: 4096 });
  await change({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: model, settings: { ...settings, temperature: 0.8 } });
  const beforePrepared = captured.length;
  const preparedEvents = await consume(prepared.stream({ ...prepared.config, messages }));
  assert.equal(captured.length, beforePrepared + 1, `Prepared request did not reach fake HTTP: ${JSON.stringify(preparedEvents)}`);
  assert.equal(captured.at(-1).temperature, 0.2, 'Prepared calls retain their old model defaults');
  assert.deepEqual(captured.at(-1).thinking, { type: 'disabled' });
  await consume(ctx.llm.registration(provider).adapter.stream({ provider, model, messages }));
  assert.equal(captured.at(-1).output_config.effort, 'high');
  assert.equal(captured.at(-1).temperature, undefined, 'Thinking mode preserves the transport temperature restriction');
  await consume(ctx.llm.registration(provider).adapter.stream({ provider, model, reasoningEffort: 'off', temperature: 0.1, maxTokens: 2048, messages }));
  assert.equal(captured.at(-1).temperature, 0.1, 'Explicit request controls beat saved defaults');
  assert.equal(captured.at(-1).max_tokens, 2048);
  await assert.rejects(() => change({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: model, settings: { ...settings, forceAdaptiveThinking: false, reasoningEfforts: { low: 'low', max: 'max' }, defaultReasoning: 'max' } }));
  await change({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: model, settings: { ...settings, maxTokens: 40000, forceAdaptiveThinking: false } });
  await consume(ctx.llm.registration(provider).adapter.stream({ provider, model, reasoningEffort: 'low', messages }));
  assert.equal(captured.at(-1).thinking.type, 'enabled');
  assert.equal(captured.at(-1).thinking.budget_tokens, 2048);
  assert.equal(captured.at(-1).output_config, undefined);
  await consume(ctx.llm.registration(provider).adapter.stream({ provider, model, reasoningEffort: 'high', messages }));
  assert.equal(captured.at(-1).thinking.budget_tokens, 16384);
  await change({ op: 'saveModelSettings', accountId: 'default', plan: 'agent-plan', modelId: model, settings: { ...settings, maxTokens: 40000, forceAdaptiveThinking: false, defaultReasoning: 'off' } });
  const budgetOff = await ctx.llm.prepareCall({ provider, model });
  await consume(budgetOff.stream({ ...budgetOff.config, messages }));
  assert.deepEqual(captured.at(-1).thinking, { type: 'disabled' });
  assert.ok(Number.isFinite(captured.at(-1).max_tokens));
  await change({ op: 'resetModelSettings', accountId: 'default', plan: 'agent-plan', modelId: model });
  assert.equal((await ctx.llm.resolveModelInfo(provider, model)).reasoning, undefined);
  console.log('Model management smoke passed: v1 migration, provider/model switches, unknown model dispatch, overrides, request precedence and prepared-call isolation; all HTTP mocked.');
} finally {
  for (const fork of forks.reverse()) await fork.dispose();
  assert.ok(home.startsWith(join(tmpdir(), 'ark-model-management-')));
  await rm(home, { recursive: true, force: true });
}
