import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, getModelRows, profilesFor, normalizeCatalog, usableModels, effectiveModel } from '../src/catalog.mjs';
import { initialState, ROUTES } from '../src/state.mjs';
import { captureModelDefaults, getModelDefaults } from '../src/model-defaults.mjs';

const metadata = ['aliases', 'capabilityUnverified', 'defaultReasoning', 'messagesThinkingMode', 'canDisableThinking', 'capabilityStatus', 'capabilityNote'];
const expected = [
  ['ark-code-latest', false, null, 'server-default', null, 'dynamic'],
  ['doubao-seed-evolving', ['off','low','medium','high'], 'high', 'enabled', true, 'documented'],
  ['doubao-seed-2-1-pro', ['off','low','medium','high'], 'high', 'enabled', true, 'documented'],
  ['doubao-seed-2-1-lite', ['off','low','medium','high'], 'high', 'enabled', true, 'documented'],
  ['doubao-seed-2-0-mini', ['off','low','medium','high'], 'medium', 'enabled', true, 'documented'],
  ['kimi-k3.1-pro', ['low','high','max'], 'max', 'enabled', false, 'documented'],
  ['deepseek-v4-1-flash', ['off','low','high','max'], 'high', 'adaptive', true, 'documented'],
  ['deepseek-v4-1-flash-economy', ['off','low','high','max'], 'high', 'adaptive', true, 'documented'],
  ['kimi-k2-8-preview', ['low','high','max'], null, 'enabled', null, 'partial'],
  ['glm-5-3-flash', ['low','high','max'], 'max', 'enabled', false, 'documented'],
  ['glm-5.3', ['low','high','max'], null, 'enabled', false, 'partial'],
  ['deepseek-v4-pro', ['off','low','high','max'], 'high', 'enabled', true, 'documented'],
  ['deepseek-v4-flash', ['off','low','high','max'], 'high', 'enabled', true, 'documented'],
  ['kimi-k3', ['low','high','max'], null, 'enabled', false, 'partial'],
  ['kimi-k2.7-code', false, null, 'server-default', null, 'partial'],
  ['minimax-m3', ['low','medium','high'], 'medium', 'enabled', null, 'partial']
];

function lookup(models, id) {
  return models.find(model => [model.id, ...(model.aliases ?? [])].includes(id));
}

for (const plan of ['agent-plan', 'coding-plan']) {
  test(`${plan}: documented independent efforts, defaults, mode and partial notes stay model-scoped`, () => {
    const state = initialState();
    const rows = getModelRows(state, 'default', plan);
    for (const [id, levels, declaredDefault, mode, disable, status] of expected) {
      const model = lookup(snapshot[plan].models, id);
      assert.ok(model, id);
      const row = rows.find(item => item.id === model.id);
      assert.deepEqual(levels === false ? row.defaults.reasoningEfforts : Object.keys(row.defaults.reasoningEfforts), levels, id);
      assert.equal(row.defaults.defaultReasoning, declaredDefault, id);
      assert.equal(row.effective.defaultReasoning, declaredDefault, id);
      assert.equal(row.messagesThinkingMode, mode, id);
      assert.equal(row.canDisableThinking, disable, id);
      assert.equal(row.capabilityStatus, status, id);
      assert.equal(row.effective.forceAdaptiveThinking, levels !== false, id);
      if (status === 'partial') {
        assert.ok(row.capabilityNote, id);
        assert.equal(row.capabilityUnverified, false, id);
      }
      for (const field of ['messagesThinkingMode', 'canDisableThinking', 'capabilityStatus', 'capabilityNote']) {
        assert.equal(Object.hasOwn(row.defaults, field), false, field);
        assert.equal(Object.hasOwn(row.effective, field), false, field);
      }
      for (const [level, wire] of Object.entries(row.defaults.reasoningEfforts || {})) assert.equal(wire, level === 'off' ? null : level, id);
      if (disable === false || disable === null) assert.equal(Object.hasOwn(row.defaults.reasoningEfforts || {}, 'off'), false, id);
    }
    const defaults = captureModelDefaults(state);
    for (const model of snapshot[plan].models) {
      const applied = getModelDefaults(defaults, ROUTES[plan], model.id);
      assert.equal(applied.reasoningEffort, model.defaultReasoning ?? undefined, model.id);
    }
  });

  test(`${plan}: catalog upgrade preserves raw state but removes all audit metadata from Core`, () => {
    const state = initialState(), key = 'default:' + plan;
    const models = snapshot[plan].models;
    state.catalogs[key] = {models: models.map(model => ({id: model.id, name: model.id, contextWindow: 32768, maxTokens: 8192, reasoningEfforts: false, capabilityUnverified: true}))};
    const before = structuredClone(state);
    const rows = getModelRows(state, 'default', plan);
    assert.equal(rows.find(row => row.id === 'doubao-seed-evolving').effective.defaultReasoning, 'high');
    for (const model of profilesFor(state)[ROUTES[plan]].models) for (const field of metadata) assert.equal(Object.hasOwn(model, field), false, `${model.id}:${field}`);
    for (const model of usableModels(undefined, plan)) for (const field of metadata) assert.equal(Object.hasOwn(model, field), false, `${model.id}:${field}`);
    assert.deepEqual(state, before);
  });
}

test('dynamic and unknown catalogs remain distinct without guessing a low or off level', () => {
  const plan = 'agent-plan';
  const catalog = normalizeCatalog(plan, {plan, models: [{model_id:'auto'}, {model_id:'future-model-991231'}]});
  assert.deepEqual(catalog.models.map(model => model.capabilityStatus), ['dynamic','unknown']);
  const state = initialState();
  state.catalogs['default:agent-plan'] = catalog;
  for (const row of getModelRows(state, 'default', plan)) {
    assert.equal(row.defaults.defaultReasoning, null);
    assert.equal(row.defaults.reasoningEfforts, false);
    assert.equal(row.messagesThinkingMode, 'server-default');
    assert.equal(row.canDisableThinking, null);
    assert.equal(row.defaults.contextWindow, 32768);
    assert.equal(row.defaults.maxTokens, 8192);
  }
  state.catalogs['default:agent-plan'].models[0].reasoningEfforts = {off:null, low:'low'};
  state.catalogs['default:agent-plan'].models[0].defaultReasoning = 'low';
  const row = getModelRows(state, 'default', plan)[0];
  assert.equal(row.defaults.reasoningEfforts, false);
  assert.equal(row.defaults.defaultReasoning, null);
});

test('legacy off overrides remain saved but cannot disable a documented always-thinking model', () => {
  const state=initialState(),key='default:agent-plan';
  state.modelSettings[key]={'kimi-k3-1-pro-261024':{reasoningEfforts:{off:null,low:'low'},defaultReasoning:'off'}};
  const before=structuredClone(state),row=getModelRows(state,'default','agent-plan').find(model=>model.id==='kimi-k3-1-pro-261024');
  assert.deepEqual(row.settings.reasoningEfforts,{off:null,low:'low'});assert.equal(row.settings.defaultReasoning,'off');
  assert.deepEqual(row.effective.reasoningEfforts,{low:'low'});assert.equal(row.effective.defaultReasoning,null);assert.match(row.settingsWarning,/常驻思考/);
  assert.equal(getModelDefaults(captureModelDefaults(state),ROUTES['agent-plan'],row.id).reasoningEffort,undefined);
  assert.deepEqual(state,before);
});

test('custom effort maps do not invent a low default and invalidate unsupported inherited defaults', () => {
  const defaults = {reasoningEfforts:{low:'low',high:'high'}, defaultReasoning:'high', forceAdaptiveThinking:true};
  assert.equal(effectiveModel(defaults, {reasoningEfforts:{low:'low'}}).defaultReasoning, null);
  assert.equal(effectiveModel({...defaults, defaultReasoning:null}, {reasoningEfforts:{low:'low'}}).defaultReasoning, null);
  assert.equal(effectiveModel(defaults, {defaultReasoning:'off', reasoningEfforts:{off:null,low:'low'}}).defaultReasoning, 'off');
});
