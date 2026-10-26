import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { authorizeInBrowser, browserEnvironment, approvedLoginUrl } from '../src/oauth-browser.mjs';
const url = 'https://ark.volcengine.com/region:cn-beijing/arkcli/login?callbackNonce=fake-test-nonce-123456&callbackPort=43210&sessionId=fake-test-session-123456';
function mock() {
  const browser = new EventEmitter(); let closes = 0;
  const page = { goto: async value => { assert.equal(value, url); } };
  browser.close = async () => { closes++; browser.emit('disconnected'); };
  browser.newContext = async () => ({ newPage: async () => page });
  const launches = [];
  return { chromium: { launch: async options => { launches.push(options); return browser; } }, browser, page, launches, get closes() { return closes; } };
}
test('browser keeps system home and removes CLI identity, bridge tokens and driver debug configuration', () => {
  const env = browserEnvironment({ HOME: 'real-home', USERPROFILE: 'real-profile', LOCALAPPDATA: 'real-appdata', XDG_CONFIG_HOME: 'real-config', ARK_API_KEY: 'fake', VOLC_ACCESSKEY: 'fake', AWS_TOKEN: 'fake', DSH_ARK_BROWSER_TOKEN: 'fake', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', PWDEBUG: '1', DEBUG: 'pw:*', DEBUG_FILE: 'fake-sensitive-file', PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: 'fake' });
  assert.deepEqual(env, { HOME: 'real-home', USERPROFILE: 'real-profile', LOCALAPPDATA: 'real-appdata', XDG_CONFIG_HOME: 'real-config' });
});
test('only official same-device ArkCli URLs with valid callback fields are accepted', () => {
  assert.equal(approvedLoginUrl(url), url);
  assert.equal(approvedLoginUrl(url.replace('/region:cn-beijing', '')), url.replace('/region:cn-beijing', ''));
  for (const raw of [url.replace('https:', 'http:'), url.replace('ark.volcengine.com', 'ark.volcengine.com.evil.test'), url.replace('ark.volcengine.com', 'user:password@ark.volcengine.com'), url.replace('43210', '0'), url.replace('43210', '99999'), url.replace('callbackNonce=', 'wrong='), url+'&callbackPort=1234', 'https://signin.volcengine.com/authorize/oauth/authorize?client_id=cross-device', 'javascript:alert(1)']) assert.equal(approvedLoginUrl(raw), undefined);
});
test('browser uses temporary profile, never reads DOM and stays open until official CLI completes', async () => {
  const m = mock(), controller = new AbortController();
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  m.page.goto = async value => { assert.equal(value, url); opened(); };
  const task = authorizeInBrowser(url, controller.signal, { chromium: m.chromium });
  await ready;
  assert.equal(m.closes, 0); assert.equal(m.launches[0].headless, false); assert.equal(m.launches[0].channel, 'chrome'); assert.equal(m.launches[0].chromiumSandbox, true);
  assert.equal(m.launches[0].args, undefined); assert.equal(m.launches[0].userDataDir, undefined); assert.equal(m.launches[0].env.USERPROFILE, process.env.USERPROFILE);
  // The page stub deliberately has no evaluate/locator/cookie APIs.
  controller.abort(); await assert.rejects(task); assert.equal(m.closes, 1);
});
test('user closing the owned browser ends the session without touching any other browser', async () => {
  const m = mock(); m.page.goto = async () => { queueMicrotask(() => m.browser.emit('disconnected')); };
  await authorizeInBrowser(url, new AbortController().signal, { chromium: m.chromium }); assert.equal(m.closes, 1);
});
test('navigation failure closes only the owned browser and never falls back to default browser', async () => {
  const m = mock(); m.page.goto = async () => { throw new Error('fake-navigation-error'); };
  await assert.rejects(authorizeInBrowser(url, new AbortController().signal, { chromium: m.chromium })); assert.equal(m.closes, 1);
});
test('cancel during launch closes late-arriving browser without navigating', async () => {
  const m = mock(), controller = new AbortController(); let release;
  m.chromium.launch = () => new Promise(resolve => { release = resolve; });
  m.page.goto = async () => assert.fail('cancelled session must not navigate');
  const task = authorizeInBrowser(url, controller.signal, { chromium: m.chromium }); controller.abort(); release(m.browser);
  await assert.rejects(task); assert.equal(m.closes, 1);
});
test('driver worker gets a clean environment and captured stdout/stderr before import', async t => {
  const previous = { DEBUG: process.env.DEBUG, DEBUG_FILE: process.env.DEBUG_FILE, PWDEBUG: process.env.PWDEBUG };
  Object.assign(process.env, { DEBUG: 'pw:protocol', DEBUG_FILE: 'fake-sensitive-file', PWDEBUG: '1' });
  t.after(() => { for (const [key,value] of Object.entries(previous)) { if(value===undefined)delete process.env[key];else process.env[key]=value; } });
  let drained = 0;
  const workerFactory = (entry, options) => {
    assert.ok(entry.pathname.endsWith('/oauth-browser-worker.mjs'));
    assert.equal(options.env.DEBUG, undefined); assert.equal(options.env.DEBUG_FILE, undefined); assert.equal(options.env.PWDEBUG, undefined); assert.deepEqual(options.execArgv, []);
    assert.equal(options.env.USERPROFILE, process.env.USERPROFILE); assert.equal(options.stdout, true); assert.equal(options.stderr, true);
    const worker = new EventEmitter(); worker.stdout = worker.stderr = { resume: () => { drained++; } };
    queueMicrotask(() => worker.emit('exit', 0)); return worker;
  };
  await authorizeInBrowser(url, new AbortController().signal, { workerFactory }); assert.equal(drained, 2);
});
test('cancel during worker startup sends cancellation and rejects its late clean exit', async () => {
  const controller = new AbortController(), messages = [], worker = new EventEmitter(); worker.postMessage = message => messages.push(message);
  const task = authorizeInBrowser(url, controller.signal, { workerFactory: () => { controller.abort(); return worker; } }); worker.emit('exit', 0);
  await assert.rejects(task); assert.deepEqual(messages, [{ type: 'cancel' }]);
});
test('worker errors never expose driver output, even if exit status is zero', async () => {
  const worker = new EventEmitter(); const task = authorizeInBrowser(url, new AbortController().signal, { workerFactory: () => worker });
  worker.emit('error', new Error('fake-sensitive-error')); worker.emit('exit', 0);
  await assert.rejects(task, error => !error.message.includes('fake-sensitive-error'));
});
test('pre-cancelled jobs and cross-device URLs never launch a browser', async () => {
  const m = mock(), controller = new AbortController(); controller.abort();
  await assert.rejects(authorizeInBrowser(url, controller.signal, { chromium: m.chromium }));
  await assert.rejects(authorizeInBrowser('https://signin.volcengine.com/authorize/oauth/authorize', new AbortController().signal, { chromium: m.chromium })); assert.equal(m.launches.length, 0);
});
