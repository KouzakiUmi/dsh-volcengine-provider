// Real Core/SDK serialization against an in-memory HTTP fixture.
import './host-resolve.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const captured=[];
globalThis.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url);
  assert.equal(url.hostname,'ark.cn-beijing.volces.com');
  assert.match(url.pathname,/^\/api\/(plan|coding)\/v1\/messages$/);
  captured.push(JSON.parse(options.body));
  return new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'OFFLINE_MATRIX_STOP'}}),{status:400,headers:{'content-type':'application/json'}});
};
const {Context}=await import('@deepseek-ai/cordis');
const {LlmRuntime}=await import('@deepseek-ai/dsh-llm');
const {TypertRegistry}=await import('@deepseek-ai/dsh-typert-registry');
const {CredentialProvider}=await import('@deepseek-ai/dsh-credentials');
const plugin=await import('../src/index.mjs');
const {initialState,ROUTES}=await import('../src/state.mjs');
const {getModelRows}=await import('../src/catalog.mjs');
const spec=new Map([
  ['Ark Code Latest（账号路由）',[[],null,'server-default',null]],
  ['豆包 Seed Evolving',[['off','low','medium','high'],'high','enabled',true]],
  ['豆包 Seed 2.1 Pro',[['off','low','medium','high'],'high','enabled',true]],
  ['豆包 Seed 2.1 Lite',[['off','low','medium','high'],'high','enabled',true]],
  ['豆包 Seed 2.0 Mini',[['off','low','medium','high'],'medium','enabled',true]],
  ['Kimi K3.1 Pro',[['low','high','max'],'max','enabled',false]],
  ['Kimi K3',[['low','high','max'],null,'enabled',false]],
  ['Kimi K2.8 Preview',[['low','high','max'],null,'enabled',null]],
  ['Kimi K2.7 Code',[[],null,'server-default',null]],
  ['GLM 5.3',[['low','high','max'],null,'enabled',false]],
  ['GLM 5.3 Flash',[['low','high','max'],'max','enabled',false]],
  ['DeepSeek V4.1 Flash',[['off','low','high','max'],'high','adaptive',true]],
  ['DeepSeek V4.1 Flash Economy',[['off','low','high','max'],'high','adaptive',true]],
  ['DeepSeek V4 Pro',[['off','low','high','max'],'high','enabled',true]],
  ['DeepSeek V4 Flash',[['off','low','high','max'],'high','enabled',true]],
  ['MiniMax M3',[['low','medium','high'],'medium','enabled',null]]
]);
const home=await mkdtemp(join(tmpdir(),'ark-thinking-matrix-')),ctx=new Context(),forks=[];
const messages=[{role:'user',content:[{type:'text',text:'offline fixture'}]}];
class FixtureCredentials extends CredentialProvider {async resolve(){return {value:'fixture-not-a-real-key',source:'fixture'};}}
async function consume(stream){const events=[];try{for await(const event of stream)events.push(event);}catch(error){events.push({code:error.code??'THROWN',message:error.message});}return events;}
let checks=0;
async function request(provider,model,reasoningEffort){const before=captured.length;await consume(ctx.llm.registration(provider).adapter.stream({provider,model,messages,...(reasoningEffort===undefined?{}:{reasoningEffort})}));assert.equal(captured.length,before+1);checks++;return captured.at(-1);}
function assertPayload(payload,id,effort,mode){
  assert.equal(payload.model,id);
  if(effort==null){assert.equal(payload.thinking,undefined);assert.equal(payload.output_config?.effort,undefined);}
  else if(effort==='off'){assert.deepEqual(payload.thinking,{type:'disabled'});assert.equal(payload.output_config?.effort,undefined);}
  else{assert.deepEqual(payload.thinking,{type:mode});assert.equal(payload.output_config.effort,effort);assert.equal(payload.thinking.budget_tokens,undefined);}
}
try{
  const seed=initialState(),statePath=join(home,'state.json');await writeFile(statePath,JSON.stringify(seed));
  for(const implementation of [TypertRegistry,LlmRuntime,FixtureCredentials]){const f=ctx.plugin(implementation);forks.push(f);await f;}
  const f=ctx.plugin(plugin,{statePath});forks.push(f);await f;
  for(let i=0;i<100&&!ctx.get('volcengineProvider');i++)await new Promise(r=>setTimeout(r,20));
  const service=ctx.get('volcengineProvider');assert.ok(service);let view=await service.invoke({op:'read'});
  for(const plan of ['agent-plan','coding-plan']){
    const provider=ROUTES[plan],rows=getModelRows(seed,'default',plan);assert.equal(rows.length,16);
    for(const row of rows){
      const expected=spec.get(row.name);assert.ok(expected,row.name);const [levels,defaultEffort,mode,canDisable]=expected;
      const info=await ctx.llm.resolveModelInfo(provider,row.id);
      assert.deepEqual((info.reasoning?.efforts??[]).map(e=>e.id).sort(),[...levels].sort(),row.name);
      assert.equal(info.reasoning?.defaultEffort,defaultEffort??undefined,row.name);
      assertPayload(await request(provider,row.id),row.id,defaultEffort,mode);
      for(const level of levels)assertPayload(await request(provider,row.id,level),row.id,level,mode);
      if(!levels.includes('off')){const before=captured.length;const events=await consume(ctx.llm.registration(provider).adapter.stream({provider,model:row.id,messages,reasoningEffort:'off'}));assert.equal(captured.length,before);assert.ok(events.some(e=>e.code||e.error||e.type==='error'));checks++;}
      view=await service.invoke({op:'saveModelSettings',revision:view.revision,accountId:'default',plan,modelId:row.id,settings:{defaultReasoning:null}});
      assertPayload(await request(provider,row.id),row.id,null,mode);
    }
  }
  for(const plan of ['agent-plan','coding-plan']){
    const provider=ROUTES[plan],rows=getModelRows(seed,'default',plan);
    for(const name of ['豆包 Seed 2.1 Pro','Kimi K3.1 Pro']){
      const row=rows.find(model=>model.name===name),mapping={off:'low',low:'high'};
      view=await service.invoke({op:'saveModelSettings',revision:view.revision,accountId:'default',plan,modelId:row.id,settings:{reasoningEfforts:mapping,defaultReasoning:'off'}});
      assertPayload(await request(provider,row.id),row.id,'low','enabled');
      assertPayload(await request(provider,row.id,'low'),row.id,'high','enabled');
      assert.deepEqual(view.catalogs.find(c=>c.plan===plan&&c.accountId==='default').models.find(m=>m.id===row.id).settings.reasoningEfforts,mapping);
    }
  }
  const autoState=JSON.parse(await readFile(statePath,'utf8'));
  for(const plan of ['agent-plan','coding-plan'])autoState.catalogs['default:'+plan]={models:[{id:'auto',name:'auto',contextWindow:32768,maxTokens:8192,input:['text'],reasoningEfforts:false}]};
  await writeFile(statePath,JSON.stringify(autoState));await service.invoke({op:'read'});
  for(const plan of ['agent-plan','coding-plan']){
    const provider=ROUTES[plan],info=await ctx.llm.resolveModelInfo(provider,'auto');assert.equal(info.reasoning,undefined);assert.equal(info.name,'Auto（智能调度）');
    assertPayload(await request(provider,'auto'),'auto',null,'server-default');
    const before=captured.length,events=await consume(ctx.llm.registration(provider).adapter.stream({provider,model:'auto',messages,reasoningEffort:'off'}));
    assert.equal(captured.length,before);assert.ok(events.some(e=>e.code||e.error||e.type==='error'));checks++;
  }
  console.log(`Model thinking smoke passed: ${checks} real Core/SDK assertions, both plans, documented defaults/independent levels/native modes/off/unforced; HTTP fully mocked.`);
}finally{
  for(const f of forks.reverse())await f.dispose();
  assert.ok(home.startsWith(join(tmpdir(),'ark-thinking-matrix-')));await rm(home,{recursive:true,force:true});
}
