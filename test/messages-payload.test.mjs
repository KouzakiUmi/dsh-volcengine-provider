import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesPayload, messagesStreamOptions } from '../src/messages-payload.mjs';

function example() {
  return {
    model: 'exact-version-1', max_tokens: 8192,
    thinking: { type: 'adaptive', display: 'summarized', budget_tokens: 2048, block_binding: { prefix_mismatch_behavior: 'drop_block' } },
    output_config: { effort: 'max', format: { type: 'text' } },
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'history', signature: 'unchanged' }] }],
    tools: [{ name: 'tool', input_schema: { type: 'object' } }]
  };
}

for (const mode of ['enabled', 'adaptive']) {
  for (const effort of ['low', 'high', 'max']) {
    test(`native ${mode}/${effort} preserves SDK effort and history`, () => {
      const payload = example();
      payload.output_config.effort = effort;
      const before = structuredClone(payload);
      const actual = messagesPayload(payload, { reasoningEffort: effort, messagesThinkingMode: mode, forceAdaptiveThinking: true });
      assert.deepEqual(actual.thinking, { type: mode });
      assert.deepEqual(actual.output_config, payload.output_config);
      assert.equal(actual.messages, payload.messages);
      assert.equal(actual.tools, payload.tools);
      assert.equal(actual.model, payload.model);
      assert.deepEqual(payload, before);
    });
  }
}

test('undefined and null inherit server defaults instead of SDK disabled/effort defaults', () => {
  for (const reasoningEffort of [undefined, null]) {
    for (const messagesThinkingMode of ['enabled', 'adaptive', 'server-default']) {
      const actual = messagesPayload(example(), { reasoningEffort, messagesThinkingMode });
      assert.ok(!Object.hasOwn(actual, 'thinking'));
      assert.deepEqual(actual.output_config, { format: { type: 'text' } });
    }
  }
  const actual = messagesPayload({ thinking: { type: 'disabled' }, output_config: { effort: 'high' } });
  assert.deepEqual(actual, {});
});

test('off sends disabled, removes effort, and never disables always-thinking models', () => {
  for (const canDisableThinking of [true, null]) {
    const actual = messagesPayload(example(), { reasoningEffort: 'off', canDisableThinking });
    assert.deepEqual(actual.thinking, { type: 'disabled' });
    assert.deepEqual(actual.output_config, { format: { type: 'text' } });
  }
  assert.throws(() => messagesPayload(example(), { reasoningEffort: 'off', canDisableThinking: false }), { code: 'UNSUPPORTED_REASONING_EFFORT' });
});

test('off string is a native alias rather than a close request', () => {
  for(const mode of ['enabled','adaptive','server-default']) {
    const payload=example(),before=structuredClone(payload);
    const actual=messagesPayload(payload,{reasoningEffort:'off',offWire:'low',canDisableThinking:false,messagesThinkingMode:mode,forceAdaptiveThinking:true});
    assert.equal(actual.output_config.effort,'low');assert.notEqual(actual.thinking.type,'disabled');assert.equal(actual.thinking.budget_tokens,undefined);
    assert.equal(actual.output_config.format,payload.output_config.format);assert.deepEqual(payload,before);
  }
});

test('fixed budget remains a budget and does not become a native effort', () => {
  const payload = example();
  payload.thinking.type = 'enabled';
  delete payload.output_config.effort;
  const actual = messagesPayload(payload, { reasoningEffort: 'high', messagesThinkingMode: 'adaptive', forceAdaptiveThinking: false });
  assert.deepEqual(actual.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.deepEqual(actual.output_config, { format: { type: 'text' } });
});

test('unknown mode does not add a type but honors explicitly generated controls', () => {
  const payload = example();
  assert.deepEqual(messagesPayload(payload, { reasoningEffort: 'high', messagesThinkingMode: 'server-default' }).thinking, { type: 'adaptive' });
  assert.deepEqual(messagesPayload({ output_config: { effort: 'high' } }, { reasoningEffort: 'high' }), { output_config: { effort: 'high' } });
  assert.throws(() => messagesPayload(payload, { messagesThinkingMode: 'guessed' }), /配置无效/);
});

test('SDK hook composition preserves amendments and isolates redirects', async () => {
  const payload = example();
  const requests = [];
  const options = messagesStreamOptions({
    maxTokens: 444, cacheRetention: 'long',
    fetch: (url, init) => { requests.push([url, init]); return 'response'; },
    onPayload: (value, model) => ({ ...value, marker: model.id, output_config: { ...value.output_config, extra: 7 } })
  }, { reasoningEffort: 'max', messagesThinkingMode: 'enabled' });
  const actual = await options.onPayload(payload, { id: 'exact-version-1' });
  assert.equal(actual.marker, 'exact-version-1');
  assert.equal(actual.output_config.extra, 7);
  assert.equal(actual.output_config.effort, 'max');
  assert.deepEqual(actual.thinking, { type: 'enabled' });
  assert.equal(options.cacheRetention, 'none');
  assert.equal(options.maxTokens, 444);
  assert.equal(options.fetch('https://example.invalid', { method: 'POST', redirect: 'follow' }), 'response');
  assert.deepEqual(requests[0][1], { method: 'POST', redirect: 'error' });
  const amendedInPlace = messagesStreamOptions({ onPayload: value => { value.marker = 1; } }, { reasoningEffort: undefined });
  assert.equal((await amendedInPlace.onPayload(example(), {})).marker, 1);
});
