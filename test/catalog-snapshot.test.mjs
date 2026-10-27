// Source-audited fixed model limits, not live API or inference tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, normalizeCatalog, getModelRows, usableModels, profilesFor } from '../src/catalog.mjs';
import { initialState, ROUTES } from '../src/state.mjs';
const current = [
  ['auto','auto','auto'],
  ['doubao-seed-evolving-latest-version','doubao-seed-evolving','doubao-seed-evolving'],
  ['doubao-seed-2-1-pro-260915','doubao-seed-2-1-pro-260915','doubao-seed-2-1-pro'],
  ['doubao-seed-2-1-lite-260915','doubao-seed-2-1-lite-260915','doubao-seed-2-1-lite'],
  ['doubao-seed-2-0-mini-260428','doubao-seed-2-0-mini-260428','doubao-seed-2-0-mini'],
  ['kimi-k3-1-pro-261001','kimi-k3-1-pro-261024','kimi-k3.1-pro'],
  ['kimi-k2-8-260901','kimi-k2-8-preview','kimi-k2-8-preview'],
  ['deepseek-v4-1-flash-261017','deepseek-v4-1-flash-261017','deepseek-v4-1-flash'],
  ['deepseek-v4-1-flash-economy-261017','deepseek-v4-1-flash-economy-261017','deepseek-v4-1-flash-economy'],
  ['glm-5-3-flash-260901','glm-5-3-flash-260828','glm-5-3-flash'],
  ['glm-5-3-260801','glm-5.3','glm-5.3'],
  ['deepseek-v4-pro-ga-260801','deepseek-v4-pro-ga-260813','deepseek-v4-pro'],
  ['deepseek-v4-flash-260801','deepseek-v4-flash-ga-260731','deepseek-v4-flash'],
  ['kimi-k3-260701','kimi-k3','kimi-k3'],
  ['kimi-k2-7-code-260601','kimi-k2.7-code','kimi-k2.7-code'],
  ['minimax-m3-modelhub','minimax-m3','minimax-m3']
];
function catalog(plan) {
  const index = plan === 'agent-plan' ? 1 : 2;
  return normalizeCatalog(plan, { plan, models: current.map(row => ({ model_id: row[0], output_name: row[index] })) });
}
test('all current fixed models use pinned parameters rather than the 32K/8K unknown fallback', () => {
  for (const plan of ['agent-plan','coding-plan']) {
    const value = catalog(plan);
    assert.equal(value.models.length,16);
    for (const model of value.models) {
      if (model.id === 'auto') { assert.equal(model.capabilityUnverified,true); continue; }
      assert.ok(model.contextWindow > 32768,model.id);
      assert.ok(model.maxTokens > 8192,model.id);
      assert.equal(model.aliases,undefined);
    }
  }
});
test('friendly display names cover snapshot, live aliases, old code-name caches and Core while IDs stay stable', () => {
  for (const plan of ['agent-plan','coding-plan']) {
    for (const model of snapshot[plan].models) { assert.notEqual(model.name,model.id);assert.ok(/[\s\u3400-\u9fff]/.test(model.name)); }
    const value=catalog(plan);
    assert.equal(value.models.find(model=>model.id==='auto').name,'Auto（智能调度）');
    const id=plan==='agent-plan'?'kimi-k3-1-pro-261024':'kimi-k3.1-pro';
    assert.equal(value.models.find(model=>model.id===id).name,'Kimi K3.1 Pro');
    const state=initialState(),key='default:'+plan;
    state.catalogs[key]={models:[{id,name:id,contextWindow:32768,maxTokens:8192}]};
    state.modelSettings[key]={[id]:{maxTokens:2048,temperature:0.2}};
    const before=structuredClone(state),row=getModelRows(state,'default',plan)[0];
    assert.equal(row.id,id);assert.equal(row.name,'Kimi K3.1 Pro');assert.equal(row.effective.maxTokens,2048);
    const core=profilesFor(state)[ROUTES[plan]].models[0];assert.equal(core.id,id);assert.equal(core.name,'Kimi K3.1 Pro');assert.deepEqual(state,before);
    const refreshed=normalizeCatalog(plan,{plan,models:[{model_id:'kimi-k3-1-pro-261001',output_name:id,model_name:id.toUpperCase()}]});
    assert.equal(refreshed.models[0].id,id);assert.equal(refreshed.models[0].name,'Kimi K3.1 Pro');
    assert.equal(normalizeCatalog(plan,{plan,models:[{model_id:id,model_name:'My readable Kimi label'}]}).models[0].name,'My readable Kimi label');
    assert.equal(normalizeCatalog(plan,{plan,models:[{model_id:id,model_name:'FastKimi'}]}).models[0].name,'FastKimi');
  }
});

test('Plan Pi exact integers are preserved, including mixed units and per-plan differences', () => {
  for (const plan of ['agent-plan','coding-plan']) {
    const rows = catalog(plan).models;
    const find = value => rows.find(model => model.id===value || model.id.startsWith(value));
    assert.equal(find('doubao-seed-2-0-mini').contextWindow,262144);
    assert.equal(find('doubao-seed-2-0-mini').maxTokens,128000);
    assert.equal(find('deepseek-v4-1-flash-economy').contextWindow,1049000);
    assert.equal(find('deepseek-v4-1-flash-economy').maxTokens,393216);
    assert.equal(find('deepseek-v4-pro').maxTokens,393216);
    assert.equal(find('kimi-k2-8-preview').maxTokens,1048576);
    assert.equal(find('glm-5.3').maxTokens,128000);
    assert.equal(rows.find(model=>model.id==='kimi-k3').maxTokens,plan==='agent-plan'?128000:65536);
    assert.equal(find('kimi-k2.7-code').contextWindow,262144);
    assert.equal(find('kimi-k2.7-code').maxTokens,32768);
    assert.equal(find('minimax-m3').maxTokens,131072);
  }
});
test('text-only V4 is not upgraded to V4.1 vision, and MiniMax modality is plan-scoped', () => {
  for (const plan of ['agent-plan','coding-plan']) {
    const rows=catalog(plan).models;
    assert.deepEqual(rows.find(model=>model.id.startsWith('deepseek-v4-pro')).input,['text']);
    assert.deepEqual(rows.find(model=>model.id.startsWith('deepseek-v4-1-flash')).input,['text','image']);
    assert.deepEqual(rows.find(model=>model.id==='minimax-m3').input,plan==='agent-plan'?['text']:['text','image']);
  }
});
test('explicit aliases retain server output IDs and do not guess other version capabilities', () => {
  const result=normalizeCatalog('agent-plan',{plan:'agent-plan',models:[{model_id:'kimi-k3-1-pro-261001',output_name:'kimi-k3-1-pro-261024'},{model_id:'deepseek-v4-1-flash-991231',output_name:'deepseek-v4-1-flash-991231'}]});
  assert.equal(result.models[0].id,'kimi-k3-1-pro-261024');assert.equal(result.models[0].contextWindow,1048576);
  assert.equal(result.models[1].contextWindow,32768);assert.equal(result.models[1].capabilityUnverified,true);
});
test('old 32K cached metadata reconciles in memory without changing user settings, identity or model IDs', () => {
  const state=initialState(),key='default:coding-plan',id='kimi-k3.1-pro';
  state.catalogs[key]={source:'arkcli',updatedAt:'2026-10-01T00:00:00Z',models:[{id,name:'Official Kimi',contextWindow:32768,maxTokens:8192,input:['text'],reasoningEfforts:false,compat:{forceAdaptiveThinking:false},capabilityUnverified:true}]};
  state.modelSettings[key]={[id]:{enabled:false,contextWindow:50000,maxTokens:2048,temperature:0.2}};
  const before=structuredClone(state),row=getModelRows(state,'default','coding-plan')[0];
  assert.equal(row.id,id);assert.equal(row.name,'Official Kimi');assert.equal(row.defaults.contextWindow,1048576);assert.equal(row.defaults.maxTokens,128000);
  assert.equal(row.effective.contextWindow,50000);assert.equal(row.effective.maxTokens,2048);assert.equal(row.settings.enabled,false);assert.deepEqual(state,before);
  const model=usableModels(state.catalogs[key],'coding-plan')[0];assert.deepEqual(model.input,['text','image']);assert.equal(model.aliases,undefined);assert.equal(model.capabilityUnverified,undefined);
});
test('updated default output cannot exceed an explicit smaller context, but explicit output is preserved', () => {
  const state=initialState(),key='default:agent-plan',id='deepseek-v4-1-flash-261017';
  state.modelSettings[key]={[id]:{contextWindow:50000}};
  let row=getModelRows(state,'default','agent-plan').find(model=>model.id===id);
  assert.equal(row.defaults.maxTokens,393216);assert.equal(row.effective.maxTokens,50000);
  state.modelSettings[key][id].maxTokens=4096;
  row=getModelRows(state,'default','agent-plan').find(model=>model.id===id);assert.equal(row.effective.maxTokens,4096);
});
test('refreshed input and token capacities reach Core without metadata-only aliases', () => {
  const state=initialState();state.catalogs['default:agent-plan']=catalog('agent-plan');
  const models=profilesFor(state)[ROUTES['agent-plan']].models;
  const kimi=models.find(model=>model.id==='kimi-k3-1-pro-261024');assert.equal(kimi.contextWindow,1048576);assert.deepEqual(kimi.input,['text','image']);
  for (const model of models) { assert.equal(model.aliases,undefined);assert.equal(model.capabilityUnverified,undefined); }
});
test('snapshot aliases are unique and partial capability notes do not erase documented effort maps', () => {
  for (const plan of ['agent-plan','coding-plan']) {
    const seen=new Set();for(const model of snapshot[plan].models)for(const id of [model.id,...model.aliases]){assert.equal(seen.has(id),false,id);seen.add(id);}
    const kimi=snapshot[plan].models.find(row=>row.id==='kimi-k2.7-code');assert.equal(kimi.reasoningEfforts,false);assert.equal(kimi.capabilityStatus,'partial');assert.match(kimi.capabilityNote,plan==='coding-plan'?/思考能力已确认/:/尚未单独确认/);
    const minimax=snapshot[plan].models.find(row=>row.id==='minimax-m3');assert.deepEqual(minimax.reasoningEfforts,{low:'low',medium:'medium',high:'high'});assert.equal(minimax.defaultReasoning,'medium');assert.equal(minimax.capabilityStatus,'partial');
    assert.deepEqual(Object.keys(snapshot[plan].models.find(model=>model.id==='glm-5.3').reasoningEfforts),['low','high','max']);
  }
});
