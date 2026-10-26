// Run with a Node runtime capable of reading the target Core (Electron for ASAR).
// This creates only disposable metadata and fake credentials. No API requests.
import './host-resolve.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry');
const { CredentialProvider } = await import('@deepseek-ai/dsh-credentials');
const plugin = await import('../src/index.mjs');
const { initialState } = await import('../src/state.mjs');
const piAi = await import('@deepseek-ai/dsh-llm-pi-ai');
const home = await mkdtemp(join(tmpdir(), 'ark-host-smoke-'));
const ctx = new Context();
const logErrors = [];
ctx.logger.exporter({ colors: 0, export: message => { if (message.type === 'error') logErrors.push(message.args); } });
let llmFork, registryFork, credentialFork, existingCoreFork, pluginFork;
let configured = false;
class FixtureCredentials extends CredentialProvider {
  async resolve(ref) { return configured && ref.startsWith('ARKCLI_') ? { value: 'fixture-not-a-real-api-key', source: 'fixture' } : undefined; }
}
const waitUntil = async pred => {
  for (let n = 0; n < 100; n++) { if (await pred()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for plugin activation');
};
try {
  const seed = initialState();
  seed.accounts.push({ ...structuredClone(seed.accounts[0]), id: 'broken', label: '损坏缓存夹具' });
  seed.catalogs['broken:agent-plan'] = {};
  await writeFile(join(home, 'state.json'), JSON.stringify(seed));
  registryFork = ctx.plugin(TypertRegistry);
  llmFork = ctx.plugin(LlmRuntime);
  credentialFork = ctx.plugin(FixtureCredentials);
  // The real host already runs llm-pi-ai. Reproduce its occupied settings/discovery namespace.
  existingCoreFork = ctx.plugin(piAi, { providers: {} });
  await existingCoreFork;
  pluginFork = ctx.plugin(plugin, { statePath: join(home, 'state.json') });
  await waitUntil(() => ctx.get('volcengineProvider'));
  const service = ctx.get('volcengineProvider');
  const initial = await service.invoke({ op: 'read' });
  assert.equal(initial.accounts.length, 2);
  assert.equal(initial.catalogs.find(row => row.accountId === 'broken' && row.plan === 'agent-plan').source, 'invalid-cache');
  await waitUntil(() => ctx.llm.listProviders().length === 2);
  assert.deepEqual(ctx.llm.listProviders().map(p => p.id).sort(), ['volcengine-agent-plan', 'volcengine-coding-plan']);
  assert.equal((await ctx.llm.listModels('volcengine-agent-plan')).length, 0);
  configured = true;
  assert.equal((await ctx.llm.listModels('volcengine-agent-plan')).length, 10);
  assert.equal((await ctx.llm.listModels('volcengine-coding-plan')).length, 10);
  const model = await ctx.llm.resolveModelInfo('volcengine-agent-plan', 'deepseek-v4-1-flash-economy-261017');
  assert.equal(model.context.contextWindow, 1048576);
  assert.equal(model.defaultMaxTokens, 384000);
  await assert.rejects(service.invoke({ op: 'select', revision: initial.revision, plan: 'agent-plan', accountId: 'broken' }));
  assert.equal(ctx.llm.listProviders().length, 2);
  assert.equal((await ctx.llm.listModels('volcengine-agent-plan')).length, 10);
  const failed = await service.invoke({ op: 'read' });
  assert.match(failed.routingError, /校验失败|更新失败/);
  const recovered = await service.invoke({ op: 'select', revision: failed.revision, plan: 'agent-plan', accountId: 'default' });
  assert.equal(recovered.routingError, undefined);
  await service.invoke({ op: 'select', revision: recovered.revision, plan: 'coding-plan', accountId: null });
  await waitUntil(() => ctx.llm.listProviders().length === 1);
  await pluginFork.dispose(); pluginFork = null;
  assert.equal(ctx.llm.listProviders().length, 0);
  assert.equal(ctx.get('volcengineProvider'), undefined);
  assert.deepEqual(logErrors, []);
  console.log('Host smoke passed: actual Core schema, RPC registry, isolated credentials, both model catalogs, selection and dispose; no network.');
} finally {
  for (const fork of [pluginFork, existingCoreFork, credentialFork, llmFork, registryFork]) if (fork) await fork.dispose();
  assert.ok(home.startsWith(join(tmpdir(), 'ark-host-smoke-')));
  await rm(home, { recursive: true, force: true });
}
