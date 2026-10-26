import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArkOAuth, approvedLoginUrl } from '../src/oauth.mjs';
import { cliEnvironment, parseJsonOutput } from '../src/cli.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const url = 'https://ark.volcengine.com/region:cn-beijing/arkcli/login?callbackNonce=fake-test-nonce-123456&callbackPort=43210&sessionId=fake-test-session-123456';
const pendingBrowser = (_url, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
async function fixture(t, onSuccess = async () => {}, browserAuthorize = pendingBrowser) {
  const home = await mkdtemp(join(tmpdir(), 'ark-oauth-test-')); let launch, onLaunch, bridgeCloses = 0;
  const oauth = new ArkOAuth({ onSuccess, browserAuthorize, verifyCli: async () => {}, timeoutMs: 1000,
    bridgeFactory: async options => { onLaunch = options.onLaunch; return { environment: env => ({ ...env, TEST_BRIDGE: 'private-path' }), close: async () => { bridgeCloses++; } }; },
    spawn: (exe, args, options) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
      child.kill = () => { child.killed = true; return true; }; launch = { exe, args, options, child }; return child;
    }
  });
  t.after(async () => { oauth.dispose(); await oauth.current?.done; assert.ok(home.startsWith(join(tmpdir(), 'ark-oauth-test-'))); await rm(home, { recursive: true, force: true }); });
  const start = async () => { const status = oauth.start({ accountId: 'a', executable: 'fake', home, revision: 'rev' }); await tick(); return status; };
  const open = async () => { onLaunch(url); await tick(); };
  const complete = async (code = 0) => { launch.child.exitCode = code; launch.child.emit('close', code); await tick(); };
  return { oauth, home, start, open, complete, get launch() { return launch; }, get bridgeCloses() { return bridgeCloses; } };
}
test('only official same-device login URLs are accepted, never cross-device code pages', () => {
  assert.equal(approvedLoginUrl(url), url);
  for(const raw of ['https://signin.volcengine.com/authorize/oauth/authorize',url.replace('ark.volcengine.com','ark.volcengine.com.evil.test'),url.replace('https:','http:'),url.replace('ark.volcengine.com','user:pass@ark.volcengine.com')])assert.equal(approvedLoginUrl(raw),undefined);
});
test('CLI identity stays isolated and cloud credentials are not inherited', () => {
  const env = cliEnvironment('C:/fake-account', { PATH: 'safe', VOLC_ACCESSKEY: 'fake', ARK_API_KEY: 'fake', USERPROFILE: 'original' });
  assert.equal(env.HOME, 'C:/fake-account'); assert.equal(env.USERPROFILE, 'C:/fake-account'); assert.equal(env.VOLC_ACCESSKEY, undefined); assert.equal(env.ARK_API_KEY, undefined); assert.equal(env.ARKCLI_NO_UPDATE_NOTIFIER, '1');
});
test('CLI JSON parse errors never echo raw output', () => {
  assert.deepEqual(parseJsonOutput('{"models":[]}'), { models: [] }); assert.throws(() => parseJsonOutput('fake-sensitive-output'), error => !error.message.includes('fake-sensitive-output'));
});
test('login uses official broker same-device mode and a private browser bridge, not no-browser', async t => {
  const f = await fixture(t); await f.start();
  assert.deepEqual(f.launch.args, ['auth','login','--login-mode','broker','--credential-store','encrypted-file']);
  assert.equal(f.launch.options.env.USERPROFILE, f.home); assert.equal(f.launch.options.env.TEST_BRIDGE, 'private-path'); assert.equal(f.launch.options.stdio[0], 'ignore');
  assert.throws(() => f.oauth.start({}), /已有登录/); await f.open(); assert.equal(f.oauth.status().state, 'waiting');
});
test('CLI output never becomes a public authorize URL or raw credentials', async t => {
  const f = await fixture(t); await f.start();
  f.launch.child.stdout.emit('data', Buffer.from(`fake-secret ${url}`)); assert.equal(f.oauth.status().url, undefined); assert.ok(!JSON.stringify(f.oauth.status()).includes('fake-secret'));
});
test('success requires official CLI completion, identity verification and closes the browser/bridge', async t => {
  let verified = false, signal;
  const f = await fixture(t, async(id,rev) => { assert.equal(id,'a'); assert.equal(rev,'rev'); verified=true; }, (_url,value) => { signal=value; return pendingBrowser(_url,value); });
  await f.start(); await f.open(); assert.equal(verified,false); await f.complete(); await f.oauth.current.done;
  assert.equal(verified,true); assert.equal(f.oauth.status().state,'success'); assert.equal(signal.aborted,true); assert.equal(f.bridgeCloses,1);
});
test('CLI success without a controlled browser launch cannot bind an account', async t => {
  let verified=false;const f=await fixture(t,async()=>{verified=true;});await f.start();await f.complete();
  assert.equal(verified,false);assert.equal(f.oauth.status().state,'error');
});
test('cancel kills only owned CLI, aborts the browser and ignores late CLI success', async t => {
  let verified=false,signal;const f=await fixture(t,async()=>{verified=true;},(_url,value)=>{signal=value;return pendingBrowser(_url,value);});
  const s=await f.start();await f.open();assert.equal(f.oauth.cancel('wrong-id').state,'waiting');assert.equal(f.oauth.cancel(s.jobId).state,'cancelled');assert.equal(signal.aborted,true);assert.equal(f.launch.child.killed,true);
  f.launch.child.emit('close',0);await tick();assert.equal(verified,false);
});
test('user closing the browser before official CLI completes fails safely', async t => {
  const f=await fixture(t,undefined,async()=>{});await f.start();await f.open();
  assert.equal(f.oauth.status().state,'error');assert.equal(f.launch.child.killed,true);
});
test('browser launch failure kills CLI without exposing driver errors', async t => {
  const f=await fixture(t,undefined,async()=>{throw Error('fake-sensitive-driver-error');});await f.start();await f.open();
  assert.equal(f.oauth.status().state,'error');assert.equal(f.launch.child.killed,true);assert.ok(!JSON.stringify(f.oauth.status()).includes('fake-sensitive'));
});
test('verification failure cannot claim login success', async t => {
  const f=await fixture(t,async()=>{throw Error('fake-secret');});await f.start();await f.open();await f.complete();
  assert.equal(f.oauth.status().state,'error');assert.ok(!JSON.stringify(f.oauth.status()).includes('fake-secret'));
});
test('timeout aborts browser and closes its bridge without binding', async t => {
  const f=await fixture(t);f.oauth.timeoutMs=80;await f.start();await f.open();await new Promise(resolve=>setTimeout(resolve,100));await f.oauth.current.done;
  assert.equal(f.oauth.status().state,'error');assert.equal(f.launch.child.killed,true);assert.equal(f.bridgeCloses,1);
});
