// Real Core/SDK capability propagation with isolated state and a mocked HTTP endpoint.
import './host-resolve.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const captured = [];
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  assert.equal(url.hostname, 'ark.cn-beijing.volces.com');
  assert.match(url.pathname, /^\/api\/(plan|coding)\/v1\/messages$/);
  captured.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'OFFLINE_CAPABILITY_STOP' } }), {
    status: 400, headers: { 'content-type': 'application/json' }
  });
};
const { Context } = await import('@deepseek-ai/cordis');
const { LlmRuntime } = await import('@deepseek-ai/dsh-llm');
const { TypertRegistry } = await import('@deepseek-ai/dsh-typert-registry');
const { CredentialProvider } = await import('@deepseek-ai/dsh-credentials');
const { initialState, ROUTES } = await import('../src/state.mjs');
const { getModelRows } = await import('../src/catalog.mjs');
const plugin = await import('../src/index.mjs');

const tempRoot = resolve(tmpdir());
const home = resolve(await mkdtemp(join(tempRoot, 'ark-capability-smoke-')));
assert.equal(dirname(home), tempRoot);
assert.match(basename(home), /^ark-capability-smoke-[A-Za-z0-9]+$/);
const ctx = new Context();
const forks = [];
const messages = [{ role: 'user', content: [{ type: 'text', text: 'offline fixture' }] }];
const tools = [{ name: 'fixtureTool', description: 'An offline fixture tool', parameters: { type: 'object', properties: {} } }];
class FixtureCredentials extends CredentialProvider {
  async resolve() { return { value: 'fixture-not-a-real-key', source: 'fixture' }; }
}
async function consume(stream) {
  try { for await (const _event of stream) { /* fake HTTP responds with a deterministic error */ } }
  catch { /* only the captured request is relevant */ }
}
async function capture(stream) {
  const before = captured.length;
  await consume(stream);
  assert.equal(captured.length, before + 1, 'the mocked endpoint must receive exactly one request');
  return captured.at(-1);
}

try {
  const seed = initialState();
  const statePath = join(home, 'state.json');
  await writeFile(statePath, JSON.stringify(seed));
  for (const implementation of [TypertRegistry, LlmRuntime, FixtureCredentials]) {
    const fork = ctx.plugin(implementation); forks.push(fork); await fork;
  }
  const fork = ctx.plugin(plugin, { statePath }); forks.push(fork); await fork;
  for (let i = 0; i < 100 && !ctx.get('volcengineProvider'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const service = ctx.get('volcengineProvider');
  assert.ok(service);
  let view = await service.invoke({ op: 'read' });
  for (const plan of ['agent-plan', 'coding-plan']) {
    const provider = ROUTES[plan];
    const row = getModelRows(seed, 'default', plan).find(item => item.name === '豆包 Seed 2.1 Pro');
    assert.ok(row);
    const base = { op: 'saveModelSettings', accountId: 'default', plan, modelId: row.id };
    assert.ok((await ctx.llm.resolveModelInfo(provider, row.id)).inputModalities.includes('image'));
    view = await service.invoke({ ...base, revision: view.revision, settings: { imageInput: false, toolsEnabled: false } });
    assert.deepEqual((await ctx.llm.resolveModelInfo(provider, row.id)).inputModalities, ['text']);
    const old = await ctx.llm.registration(provider).adapter.prepareCall(provider, row.id);
    let payload = await capture(old.stream({ provider, model: row.id, messages, tools }));
    assert.ok(payload.tools?.length > 0);
    assert.deepEqual(payload.tool_choice, { type: 'none' });
    payload = await capture(ctx.llm.registration(provider).adapter.stream({ provider, model: row.id, messages }));
    assert.ok(!Object.hasOwn(payload, 'tool_choice'), 'no tool_choice without tools');
    const frozen = await ctx.llm.registration(provider).adapter.prepareCall(provider, row.id);
    view = await service.invoke({ ...base, revision: view.revision, settings: { imageInput: true, toolsEnabled: true } });
    assert.ok((await ctx.llm.resolveModelInfo(provider, row.id)).inputModalities.includes('image'));
    payload = await capture(frozen.stream({ provider, model: row.id, messages, tools }));
    assert.deepEqual(payload.tool_choice, { type: 'none' }, 'prepared calls retain their previous capability settings');
    payload = await capture(ctx.llm.registration(provider).adapter.stream({ provider, model: row.id, messages, tools }));
    assert.notEqual(payload.tool_choice?.type, 'none', 'a new call uses the enabled setting');
    view = await service.invoke({ op: 'resetModelSettings', revision: view.revision, accountId: 'default', plan, modelId: row.id });
    assert.ok((await ctx.llm.resolveModelInfo(provider, row.id)).inputModalities.includes('image'));
  }
  console.log('Capability smoke passed: both plans, real Core/SDK image metadata, per-model tool choice and prepared-call isolation; HTTP mocked.');
} finally {
  for (const fork of forks.reverse()) await fork.dispose();
  assert.equal(dirname(home), tempRoot);
  assert.match(basename(home), /^ark-capability-smoke-[A-Za-z0-9]+$/);
  await rm(home, { recursive: true, force: true });
}
