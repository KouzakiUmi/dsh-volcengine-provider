import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, ROUTES } from '../src/state.mjs';
import { captureModelDefaults, getModelDefaults, applyModelDefaults, describeModelDefaults } from '../src/model-defaults.mjs';

const info = () => ({ id: 'model', reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultEffort: 'high' } });

test('saved request defaults fill only absent controls, preserving explicit zero and off', () => {
  const original = { provider: 'p', model: 'm' };
  assert.deepEqual(applyModelDefaults(original, { temperature: 0.4, reasoningEffort: 'low' }), { ...original, temperature: 0.4, reasoningEffort: 'low' });
  assert.deepEqual(original, { provider: 'p', model: 'm' });
  const explicit = { ...original, temperature: 0, reasoningEffort: 'off' };
  assert.equal(applyModelDefaults(explicit, { temperature: 0.4, reasoningEffort: 'high' }), explicit);
});

test('models with no saved request defaults remain unchanged', () => {
  const options = { provider: 'p', model: 'm' };
  assert.equal(applyModelDefaults(options), options);
  assert.equal(describeModelDefaults({ id: 'plain' }).reasoning, undefined);
});

test('model metadata exposes the configured supported effort without mutating the source', () => {
  const source = info();
  const described = describeModelDefaults(source, { reasoningEffort: 'low' });
  assert.equal(described.reasoning.defaultEffort, 'low');
  assert.equal(source.reasoning.defaultEffort, 'high');
  assert.equal(describeModelDefaults(source).reasoning.defaultEffort, undefined);
});

test('unsupported and non-reasoning defaults are rejected instead of advertised', () => {
  assert.throws(() => describeModelDefaults(info(), { reasoningEffort: 'max' }), /不匹配/);
  assert.throws(() => describeModelDefaults({ id: 'plain' }, { reasoningEffort: 'low' }), /非思考/);
});

test('saved model defaults are isolated by account, plan and enabled status', () => {
  const state = initialState();
  state.enabled = { 'agent-plan': true, 'coding-plan': true };
  state.modelSettings = {
    'default:agent-plan': { 'ark-code-latest': { temperature: 0.2, defaultReasoning: 'off' } },
    'default:coding-plan': { 'ark-code-latest': { temperature: 0.8, defaultReasoning: 'low' } }
  };
  const before = captureModelDefaults(state);
  const agent = getModelDefaults(before, ROUTES['agent-plan'], 'ark-code-latest');
  const coding = getModelDefaults(before, ROUTES['coding-plan'], 'ark-code-latest');
  assert.deepEqual(agent, { temperature: 0.2, reasoningEffort: 'off' });
  assert.deepEqual(coding, { temperature: 0.8, reasoningEffort: 'low' });
  assert.ok(Object.isFrozen(agent));
  state.modelSettings['default:agent-plan']['ark-code-latest'].temperature = 0.7;
  state.enabled['coding-plan'] = false;
  const after = captureModelDefaults(state);
  assert.equal(getModelDefaults(before, ROUTES['agent-plan'], 'ark-code-latest').temperature, 0.2);
  assert.equal(getModelDefaults(after, ROUTES['agent-plan'], 'ark-code-latest').temperature, 0.7);
  assert.equal(getModelDefaults(after, ROUTES['coding-plan'], 'ark-code-latest'), undefined);
  state.modelSettings['default:agent-plan']['ark-code-latest'].enabled = false;
  assert.equal(getModelDefaults(captureModelDefaults(state), ROUTES['agent-plan'], 'ark-code-latest'), undefined);
});
