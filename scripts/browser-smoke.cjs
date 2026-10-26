// Optional offline render test. Requires existing playwright-core and target frontend assets.
// Does not connect to any DSH HTTP endpoint or execute OAuth. All RPC data is fake.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const assets = process.env.DSH_TEST_FRONTEND_ASSETS;
if (!assets) throw new Error('Set DSH_TEST_FRONTEND_ASSETS to the target frontend dist/assets directory');
const playwrightPath = require.resolve('playwright-core', { paths: [process.env.DSH_TEST_PLAYWRIGHT_ROOT || process.cwd()] });
const { chromium } = require(playwrightPath);
const files = fs.readdirSync(assets);
const mainName = files.find(name => /^index-.+\.js$/.test(name));
const vendorName = files.find(name => /^vendor-.+\.js$/.test(name));
if (!mainName || !vendorName) throw new Error('Target frontend assets not found');
const screenshot = path.resolve(process.env.DSH_TEST_SCREENSHOT || 'test-output/client-preview.png');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    await context.route('http://**/*', route => route.abort());
    await context.route('https://**/*', route => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    // Capture the target's static React modules before its app boot. The fixture deliberately
    // stops there: no transport, authentication, route or real boot configuration is loaded.
    await page.evaluate(() => { window.__ModuleLoader__ = { create(options) { window.fixtureModules = options.staticModules; throw Error('offline-fixture-stop'); } }; });
    const vendor = 'data:text/javascript;base64,' + fs.readFileSync(path.join(assets, vendorName)).toString('base64');
    const main = fs.readFileSync(path.join(assets, mainName), 'utf8').replaceAll('./' + vendorName, vendor);
    await page.addScriptTag({ type: 'module', content: main });
    await page.waitForFunction(() => window.fixtureModules, undefined, { timeout: 10000 });
    await page.evaluate(() => {
      document.body.innerHTML = '<main id="fixture-root" style="max-width:1000px;margin:24px auto;font:14px system-ui"></main>';
      const state = {
        revision: 'fixture',
        accounts: [{ id: 'default', label: '测试账号（假数据）', apiKeyRefs: { 'agent-plan': 'AGENT_REF', 'coding-plan': 'CODING_REF' }, accessKeyRef: 'AK_REF', secretKeyRef: 'SK_REF', hasApiKeys: { 'agent-plan': true, 'coding-plan': true }, hasQuotaKeys: true, authMode: 'references' }],
        active: { 'agent-plan': 'default', 'coding-plan': 'default' },
        catalogs: ['agent-plan', 'coding-plan'].map(plan => ({ plan, accountId: 'default', count: 10, source: 'local-snapshot' })),
        routes: { 'agent-plan': 'volcengine-agent-plan', 'coding-plan': 'volcengine-coding-plan' }, login: { jobId: null, state: 'idle', message: '' }
      };
      window.fixtureCalls = [];
      const service = { async invoke(request) {
        window.fixtureCalls.push(request.op);
        let value = state;
        if (request.op === 'quota') value = { plan: request.plan, accountId: request.accountId, state: 'ok', windows: [
          { kind: '5h', percent: 25, group: 'text', detail: { used: 250, limit: 1000, unit: 'AFP' } },
          { kind: 'month', percent: 90, group: 'all', resetsAt: '2026-11-09T15:59:59Z', detail: { used: 9000, limit: 10000, unit: 'AFP' } }
        ] };
        if (['startLogin', 'loginStatus'].includes(request.op)) value = { jobId: 'fixture-job', state: 'waiting', accountId: 'default', message: '测试状态：未执行真实登录' };
        return { ok: true, value };
      } };
      const disposers = [];
      window.fixtureDispose = () => { for (const fn of disposers) fn(); };
      const ctx = {
        get: () => service, remote: { $mount: async () => () => {}, volcengineProvider: service },
        inject(_deps, callback) { callback(ctx); },
        effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') disposers.push(cleanup); return cleanup; },
        slots: {
          inject(_key, callback) { callback(); },
          register(options, component) {
            const root = window.fixtureModules['react-dom/client'].createRoot(document.getElementById('fixture-root'));
            root.render(window.fixtureModules.react.createElement(component, options.inject()));
            disposers.push(() => root.unmount());
          }
        }
      };
      window.__ModuleLoader__.load = specification => {
        const module = { exports: {} };
        specification.factory(name => window.fixtureModules[name], module.exports, module);
        module.exports.apply(ctx);
      };
    });
    await page.addScriptTag({ content: fs.readFileSync('lib/client.js', 'utf8') });
    await page.getByRole('button', { name: '新增账号', exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新额度', exact: true }).first().click();
    await page.getByText('剩余 75%').waitFor();
    await page.getByRole('button', { name: '网页登录', exact: true }).click();
    await page.getByRole('button', { name: '确认并打开官方登录页', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.fixtureCalls)).includes('startLogin'), false);
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.getByRole('button', { name: '确认并打开官方登录页', exact: true }).click();
    await page.getByText('测试状态：未执行真实登录').waitFor();
    assert.equal((await page.evaluate(() => window.fixtureCalls)).includes('startLogin'), true);
    await page.evaluate(() => window.fixtureDispose());
    assert.deepEqual(errors, []);
    console.log('Browser smoke passed: real React/Chrome, dual cards, quota grouping, login confirmation and dispose; fake RPC, HTTP(S) blocked.');
    console.log('Screenshot:', screenshot);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
