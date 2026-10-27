import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, ROUTES } from '../src/state.mjs';
import { getModelRows } from '../src/catalog.mjs';
import { captureModelDefaults, getModelDefaults, describeModelDefaults } from '../src/model-defaults.mjs';

for (const plan of ['agent-plan','coding-plan']) {
  test(`${plan}: legacy GLM medium default remains saved but does not block model resolution`, () => {
    const state=initialState(), key='default:'+plan;
    state.catalogs[key]={models:[{id:'glm-5.3',name:'glm-5.3',contextWindow:1048576,maxTokens:131072,reasoningEfforts:{low:'low',medium:'medium',high:'high'}}]};
    state.modelSettings[key]={'glm-5.3':{defaultReasoning:'medium',temperature:0.3}};
    const before=structuredClone(state),row=getModelRows(state,'default',plan)[0];
    assert.equal(row.settings.defaultReasoning,'medium');assert.equal(row.effective.defaultReasoning,null);assert.match(row.settingsWarning,/medium/);
    assert.equal(Object.hasOwn(row.effective.reasoningEfforts,'medium'),false);
    const defaults=getModelDefaults(captureModelDefaults(state),ROUTES[plan],'glm-5.3');
    assert.deepEqual(defaults,{temperature:0.3});
    const info={id:'glm-5.3',reasoning:{efforts:[{id:'low'},{id:'high'},{id:'max'}]}};
    assert.doesNotThrow(()=>describeModelDefaults(info,defaults));
    assert.throws(()=>describeModelDefaults(info,{reasoningEffort:'medium'}),/不匹配/);
    assert.deepEqual(state,before);
  });
}
test('explicit user effort maps continue to define supported defaults',()=>{
  const state=initialState(),key='default:agent-plan';
  state.modelSettings[key]={'glm-5.3':{reasoningEfforts:{low:'low',medium:'medium',high:'high'},defaultReasoning:'medium'}};
  const row=getModelRows(state,'default','agent-plan').find(model=>model.id==='glm-5.3');
  assert.equal(row.effective.defaultReasoning,'medium');assert.equal(row.settingsWarning,undefined);
  assert.equal(getModelDefaults(captureModelDefaults(state),ROUTES['agent-plan'],'glm-5.3').reasoningEffort,'medium');
});
test('choosing a valid replacement clears compatibility feedback and restores the saved default',()=>{
  const state=initialState(),key='default:agent-plan';
  state.modelSettings[key]={'glm-5.3':{defaultReasoning:'high'}};
  const row=getModelRows(state,'default','agent-plan').find(model=>model.id==='glm-5.3');
  assert.equal(row.effective.defaultReasoning,'high');assert.equal(row.settingsWarning,undefined);
  assert.equal(getModelDefaults(captureModelDefaults(state),ROUTES['agent-plan'],'glm-5.3').reasoningEffort,'high');
});

for (const plan of ['agent-plan', 'coding-plan']) {
  test(`${plan}: saved budget mode filters only inherited incompatible levels without rewriting raw settings`, () => {
    const state = initialState(), key = 'default:' + plan;
    const id = plan === 'agent-plan' ? 'kimi-k3-1-pro-261024' : 'kimi-k3.1-pro';
    state.modelSettings[key] = {[id]: {forceAdaptiveThinking:false, defaultReasoning:'max'}};
    const before = structuredClone(state);
    const row = getModelRows(state, 'default', plan).find(model => model.id === id);
    assert.deepEqual(row.defaults.reasoningEfforts, {low:'low', high:'high', max:'max'});
    assert.deepEqual(row.effective.reasoningEfforts, {low:'low', high:'high'});
    assert.equal(row.effective.forceAdaptiveThinking, false);
    assert.equal(row.effective.defaultReasoning, null);
    assert.equal(row.defaults.defaultReasoning, 'max');
    assert.match(row.settingsWarning, /固定预算模式.*max/);
    assert.match(row.settingsWarning, /默认思考档位 max/);
    assert.deepEqual(getModelDefaults(captureModelDefaults(state),ROUTES[plan],id), {});
    assert.deepEqual(state, before);
  });
}

test('explicit user maps and saved budget mode are preserved instead of silently filtering', () => {
  const state = initialState(), key = 'default:agent-plan', id = 'glm-5.3';
  state.modelSettings[key] = {[id]: {forceAdaptiveThinking:false, reasoningEfforts:{low:'low',max:'custom-max'}, defaultReasoning:'max'}};
  const row = getModelRows(state, 'default', 'agent-plan').find(model => model.id === id);
  assert.deepEqual(row.effective.reasoningEfforts, {low:'low',max:'custom-max'});
  assert.equal(row.effective.defaultReasoning, 'max');
  assert.equal(row.settingsWarning, undefined);
});

test('a compatible inherited budget map needs no repair warning', () => {
  const state = initialState(), key = 'default:agent-plan', id = 'doubao-seed-evolving';
  state.modelSettings[key] = {[id]: {forceAdaptiveThinking:false}};
  const row = getModelRows(state, 'default', 'agent-plan').find(model => model.id === id);
  assert.deepEqual(row.effective.reasoningEfforts, {off:null,low:'low',medium:'medium',high:'high'});
  assert.equal(row.effective.defaultReasoning, 'high');
  assert.equal(row.settingsWarning, undefined);
});
