// Offline real-browser smoke: official same-device entry and a synthetic CLI
// callback are fulfilled locally. No real authorization, external HTTP or DOM read.
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { authorizeInBrowser, authorizeWithChromium } from '../lib/oauth-browser.mjs';
const url = 'https://ark.volcengine.com/region:cn-beijing/arkcli/login?callbackNonce=fake-test-nonce-123456&callbackPort=43210&sessionId=fake-test-session-123456';
const callback = 'http://127.0.0.1:43210/callback?nonce=fake-test-nonce-123456';
if (isMainThread) {
  const controller = new AbortController(); let callbackSeen = false;
  const task = authorizeInBrowser(url, controller.signal, { workerFactory: (_entry, options) => {
    const worker = new Worker(new URL(import.meta.url), options);
    worker.on('message', message => {
      if (message?.type === 'fixture-callback') { callbackSeen = true; controller.abort(); }
      if (message?.type === 'offline-test-error') console.error('Offline fixture failure:', message.error);
    });
    worker.on('error', error => console.error('Offline fixture worker failure:', error.message.split('\n')[0]));
    return worker;
  } });
  await assert.rejects(task); assert.equal(callbackSeen, true);
  console.log('PASS: isolated driver, private temporary Chrome, unchanged Ark same-device URL, synthetic official-CLI callback and automatic browser cleanup. No real login or code extraction.');
} else {
  const controller = new AbortController();
  parentPort.on('message', message => { if (message?.type === 'cancel') controller.abort(); });
  try {
    assert.equal(process.env.DEBUG, undefined); assert.equal(process.env.DEBUG_FILE, undefined); assert.equal(process.env.PWDEBUG, undefined);
    const { chromium } = await import('playwright-core');
    let launches = 0;
    const offline = { async launch(options) {
      launches++; assert.equal(options.env.USERPROFILE, process.env.USERPROFILE); assert.equal(options.args, undefined);
      const browser = await chromium.launch(options), newContext = browser.newContext.bind(browser);
      browser.newContext = async config => {
        const context = await newContext(config);
        await context.route('**/*', async route => {
          const target = route.request().url();
          if (target === url) { await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><title>Offline same-device OAuth</title><p>Local fixture only</p><script>setTimeout(()=>location.href=${JSON.stringify(callback)},100)</script>` }); return; }
          if (target === callback) { await route.fulfill({ contentType: 'text/html', body: '<p>Callback complete</p>' }); parentPort.postMessage({ type: 'fixture-callback' }); return; }
          await route.abort();
        });
        return context;
      };
      return browser;
    } };
    try { await authorizeWithChromium(workerData.url, controller.signal, { chromium: offline }); }
    catch (error) { if (!controller.signal.aborted) throw error; }
    assert.equal(launches, 1);
  } catch (error) { parentPort.postMessage({ type: 'offline-test-error', error: error.message.split('\n')[0] }); process.exitCode = 1; }
  finally { parentPort.close(); }
}
