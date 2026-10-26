import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBrowserBridge, verifyBrowserBridgeCli } from '../lib/browser-bridge.mjs';
const url = 'https://ark.volcengine.com/region:cn-beijing/arkcli/login?callbackNonce=fake-test-nonce-123456&callbackPort=43210&sessionId=fake-test-session-123456';
async function fixture(t) {
  const controller=new AbortController(), received=[];
  const bridge=await createBrowserBridge({signal:controller.signal,onLaunch:value=>received.push(value)});
  t.after(()=>bridge.close());
  const env=bridge.environment(process.env);
  const post=(raw,token=env.DSH_ARK_BROWSER_TOKEN)=>fetch(env.DSH_ARK_BROWSER_ENDPOINT,{method:'POST',headers:{'x-dsh-ark-browser':token},body:raw});
  return {controller,bridge,env,received,post};
}
test('bridge requires its per-job token and strict same-device URL, with no secret-bearing output', async t=>{
  const f=await fixture(t);
  assert.equal((await f.post(url,'wrong-token')).status,403);
  assert.equal((await f.post(url,'ÿ'.repeat(64))).status,403);
  assert.equal((await f.post('https://evil.test/arkcli/login')).status,400);
  assert.equal((await f.post('https://signin.volcengine.com/authorize/oauth/authorize')).status,400);
  assert.equal(f.received.length,0);
  assert.equal((await f.post(url)).status,204);assert.deepEqual(f.received,[url]);
  assert.equal((await f.post(url)).status,204);assert.equal(f.received.length,1);
  assert.equal((await f.post(url.replace('43210','43211'))).status,409);assert.equal(f.received.length,1);
});
test('bridge environment is local to child and replaces case-insensitive PATH without inheriting stale tokens', async t=>{
  const f=await fixture(t);const ambient={Path:'original-path',DSH_ARK_BROWSER_TOKEN:'stale',HOME:'isolated-home'};const env=f.bridge.environment(ambient);
  assert.equal(ambient.Path,'original-path');assert.equal(ambient.DSH_ARK_BROWSER_TOKEN,'stale');assert.equal(env.Path,undefined);
  assert.ok(env.PATH.endsWith('original-path'));assert.ok(env.PATH.includes('browser-bridge'));assert.equal(env.HOME,'isolated-home');assert.equal(env.NoDefaultCurrentDirectoryInExePath,'1');assert.ok(env.DSH_ARK_BROWSER_TOKEN!=='stale');
});
test('abort closes only the task bridge and rejects later calls', async t=>{
  const f=await fixture(t);f.controller.abort();await f.bridge.close();
  await assert.rejects(f.post(url));assert.equal(f.received.length,0);
});
test('POSIX helper must be executable before any bridge server or login can start', async()=>{
  let checked=false;
  await assert.rejects(createBrowserBridge({signal:new AbortController().signal,platform:'linux',onLaunch:()=>assert.fail('must not launch'),accessImpl:async(_path,mode)=>{checked=true;assert.equal(mode,constants.X_OK);throw Object.assign(Error('not executable'),{code:'EACCES'});}}));
  assert.equal(checked,true);
});
test('unverified platforms and CLI versions fail closed before starting login',async()=>{
  const args={env:{},cwd:'.',signal:new AbortController().signal};
  await assert.rejects(verifyBrowserBridgeCli('fake',{...args,platform:'linux',exec:()=>assert.fail('must not invoke')}));
  await assert.rejects(verifyBrowserBridgeCli('fake',{...args,platform:'win32',exec:(_exe,argv,_options,cb)=>{assert.deepEqual(argv,['--version']);cb(null,'arkcli version 1.0.42');}}));
  await verifyBrowserBridgeCli('fake',{...args,platform:'win32',exec:(_exe,_argv,_options,cb)=>cb(null,'arkcli version 1.0.37\n')});
});
test('real native Windows opener forwards the URL unchanged to the authenticated bridge', {skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);
  const {stdout,stderr}=await promisify(execFile)(fileURLToPath(new URL('../lib/browser-bridge/win32/rundll32.exe',import.meta.url)),['url.dll,FileProtocolHandler',url],{env:f.env,windowsHide:true,timeout:10000});
  assert.deepEqual(f.received,[url]);assert.equal(stdout.length,0);assert.equal(stderr.length,0);
});
test('real Node opener client forwards only approved URLs without launching a browser',async t=>{
  const f=await fixture(t);
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../lib/browser-bridge-client.mjs',import.meta.url)),url],{env:f.env,windowsHide:true,timeout:10000});
  assert.deepEqual(f.received,[url]);
});
