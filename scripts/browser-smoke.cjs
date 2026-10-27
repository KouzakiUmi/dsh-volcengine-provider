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
    // Controlled DSW theme tokens: this is an offline fixture, not the running host.
    await page.addStyleTag({ content: `
      :root{color-scheme:light;--dsw-alias-label-primary:#1f2937;--dsw-alias-label-secondary:#647084;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f7fa;--dsw-alias-border-l4:#e4e8ee;--dsw-alias-border-l3:#cdd4df;--dsw-alias-brand-primary:#2563eb;--dsw-alias-button-primary-fill:#2563eb;--dsw-alias-button-primary-hover:#1d4ed8;--dsw-alias-state-error-primary:#b91c1c;--dsw-alias-state-warn-primary:#b45309;--dsw-alias-state-success-primary:#15803d}
      :root[data-fixture-theme=dark]{color-scheme:dark;--dsw-alias-label-primary:#e5eaf1;--dsw-alias-label-secondary:#a9b4c5;--dsw-alias-bg-layer-1:#1b2029;--dsw-alias-bg-layer-2:#252d39;--dsw-alias-border-l4:#354152;--dsw-alias-border-l3:#46556b;--dsw-alias-brand-primary:#60a5fa;--dsw-alias-state-error-primary:#f87171;--dsw-alias-state-warn-primary:#fbbf24;--dsw-alias-state-success-primary:#4ade80}
      body{background:#f3f5f8;color:var(--dsw-alias-label-primary)}html[data-fixture-theme=dark] body{background:#11161e}
    ` });
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
        enabled: { 'agent-plan': true, 'coding-plan': true },
        catalogs: ['agent-plan', 'coding-plan'].map(plan => {
          const defaults = { contextWindow: 32768, maxTokens: 8192, reasoningEfforts: { off: null, low: 'low', high: 'high' }, defaultReasoning: 'low', forceAdaptiveThinking: true };
          return { plan, accountId: 'default', count: 1, enabledCount: 1, source: 'local-snapshot', models: [{ id: 'demo-reasoning-model', name: '示例模型（假数据）', enabled: true, capabilityUnverified: true, settings: {}, defaults, effective: { ...defaults } }] };
        }),
        routes: { 'agent-plan': 'volcengine-agent-plan', 'coding-plan': 'volcengine-coding-plan' }, login: { jobId: null, state: 'idle', message: '' }
      };
      window.fixtureCalls = [];
      window.fixtureRequests = [];
      window.fixtureState = state;
      const service = { async invoke(request) {
        window.fixtureCalls.push(request.op);
        window.fixtureRequests.push(structuredClone(request));
        if (request.op === 'saveAccount') {
          if (request.revision !== state.revision) throw new Error('设置已改变，请刷新后重试');
          state.accounts.push({ ...request.account, authMode: 'references', hasApiKeys: {}, hasQuotaAccess: {} });
          state.catalogs = state.catalogs.map(catalog => ({ ...catalog, accountId: request.account.id }));
          state.revision += '-a';
        }
        if (request.op === 'select') { state.active[request.plan] = request.accountId; state.revision += '-s'; }
        if (request.op === 'setProviderEnabled') { state.enabled[request.plan] = request.enabled; state.revision += '-p'; }
        if (['setModelEnabled', 'saveModelSettings', 'resetModelSettings'].includes(request.op)) {
          const catalog = state.catalogs.find(row => row.plan === request.plan && row.accountId === request.accountId);
          const model = catalog.models.find(row => row.id === request.modelId);
          if (request.op === 'setModelEnabled') model.settings.enabled = request.enabled;
          if (request.op === 'saveModelSettings') {
            const enabled = model.settings.enabled;
            model.settings = { ...request.settings };
            if (!Object.hasOwn(model.settings, 'enabled') && enabled !== undefined) model.settings.enabled = enabled;
          }
          if (request.op === 'resetModelSettings') model.settings = {};
          model.enabled = model.settings.enabled !== false;
          model.effective = { ...model.defaults, ...model.settings };
          catalog.enabledCount = catalog.models.filter(row => row.enabled).length;
        }
        let value = state;
        if (request.op === 'quota') value = { plan: request.plan, accountId: request.accountId, state: 'ok', updatedAt: '2026-10-26T14:00:00Z', windows: request.plan === 'coding-plan' ? [{ kind: '5h', percent: 12.5 }, { kind: 'week', percent: 39 }, { kind: 'month', percent: 68 }] : [
          { kind: '5h', percent: 25, group: 'text', detail: { used: 250, limit: 1000, unit: 'AFP' } },
          { kind: 'month', percent: 90, group: 'all', resetsAt: '2026-11-09T15:59:59Z', detail: { used: 9000, limit: 10000, unit: 'AFP' } }
        ] };
        if (request.op === 'startLogin') {
          if (request.revision !== state.revision) throw new Error('设置已改变，请刷新后重试');
          state.login = { jobId: `fixture-job-${window.fixtureCalls.length}`, state: 'waiting', accountId: request.accountId, message: '测试状态：未执行真实登录' };
          value = state.login;
        }
        if (request.op === 'loginStatus') {
          Object.assign(state.accounts.find(account => account.id === state.login.accountId), { displayName: '方舟体验账号（假数据）', identity: { name: '方舟体验账号（假数据）', accountId: 'demo-account', userId: 'demo-user' },
            authMode: 'oauth', oauthProfiles: { 'agent-plan': 'demo-agent', 'coding-plan': 'demo-coding' }, hasQuotaAccess: { 'agent-plan': true, 'coding-plan': true }, loggedAt: '2026-10-26T14:00:00Z' });
          state.login = { ...state.login, state: 'success', message: '身份与套餐已更新（离线测试）' };
          value = state.login;
        }
        return { ok: true, value: structuredClone(value) };
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
        const plugin = specification.factory(name => window.fixtureModules[name]);
        plugin.apply(ctx);
      };
    });
    await page.addScriptTag({ content: fs.readFileSync('lib/client.js', 'utf8') });
    await page.getByRole('heading', { name: '火山方舟 Provider', exact: true }).waitFor();
    await page.getByRole('button', { name: '新增账号', exact: true }).waitFor();
    const providerToggle = page.getByRole('checkbox', { name: '启用火山方舟 · Agent 套餐', exact: true });
    await providerToggle.uncheck();
    assert.equal(await page.evaluate(() => window.fixtureState.active['agent-plan']), 'default');
    await providerToggle.check();
    for (const select of await page.locator('select.vcp-select').all()) {
      const box = await select.boundingBox();
      assert.ok(box && box.height >= 28 && box.height < 64, 'Account selector must stay a compact control, never a 220px flex item');
    }
    const advanced = page.getByText('账号高级配置与标识', { exact: true }).first();
    await advanced.click();
    assert.equal(await advanced.evaluate(node => node.parentElement.open), true, 'Native details opens');
    await advanced.click();
    assert.equal(await advanced.evaluate(node => node.parentElement.open), false, 'Native details closes');
    await page.getByText('模型列表（已启用 1 / 共 1）', { exact: true }).first().click();
    const modelToggle = page.getByRole('checkbox', { name: '启用模型 demo-reasoning-model', exact: true }).first();
    await modelToggle.uncheck();
    const modelIdentity = page.getByText('模型技术标识', { exact: true }).first();
    assert.equal(await modelIdentity.evaluate(node => node.parentElement.open), false);
    await modelIdentity.click();
    assert.equal(await page.getByText('调用 ID：demo-reasoning-model', { exact: true }).first().isVisible(), true);
    await modelIdentity.click();
    assert.equal(await modelIdentity.evaluate(node => node.parentElement.open), false);
    await page.getByRole('button', { name: '模型参数 demo-reasoning-model', exact: true }).first().click();
    for (const label of ['思考档位映射 reasoningEfforts', '默认思考档位 defaultReasoning', '思考模式 forceAdaptiveThinking']) {
      const box = await page.getByLabel(label, { exact: true }).locator('..').boundingBox();
      assert.ok(box && box.height < 150, `${label} should not inherit a row's 220px flex basis`);
    }
    await page.getByLabel('温度 temperature', { exact: true }).fill('0.4');
    await page.getByRole('button', { name: '保存参数', exact: true }).click();
    await page.waitForFunction(() => window.fixtureRequests.some(request => request.op === 'saveModelSettings'));
    const save = await page.evaluate(() => window.fixtureRequests.find(request => request.op === 'saveModelSettings'));
    assert.equal(save.settings.temperature, 0.4);
    assert.equal(await page.evaluate(() => window.fixtureState.catalogs[0].models[0].enabled), false);
    await modelToggle.check();
    await page.getByRole('button', { name: '恢复默认 demo-reasoning-model', exact: true }).first().click();
    await page.waitForFunction(() => window.fixtureRequests.some(request => request.op === 'resetModelSettings'));
    await page.getByRole('button', { name: '刷新额度', exact: true }).first().click();
    await page.getByText('剩余 75%').waitFor();
    await page.getByRole('button', { name: '网页登录', exact: true }).click();
    await page.getByRole('button', { name: '确认并打开官方登录页', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.fixtureCalls)).includes('startLogin'), false);
    await page.getByRole('button', { name: '确认并打开官方登录页', exact: true }).click();
    await page.getByText('测试状态：未执行真实登录').waitFor();
    assert.equal((await page.evaluate(() => window.fixtureCalls)).includes('startLogin'), true);
    await page.getByText('身份与套餐已更新（离线测试）').waitFor();
    await page.getByText('当前账号：方舟体验账号（假数据）', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('剩余 75%', { exact: true }).count(), 0, 'Login invalidates previous identity quota');
    await page.getByRole('button', { name: '刷新额度', exact: true }).first().click();
    await page.getByRole('button', { name: '刷新额度', exact: true }).nth(1).click();
    await page.getByText('剩余 87.5%', { exact: true }).waitFor();
    // Keep the preview focused on account → plan → quota rather than an open parameter form.
    await page.getByText('模型列表（已启用 1 / 共 1）', { exact: true }).first().click();
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.fixtureTheme = 'dark'; });
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-dark.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Settings must fit a narrow viewport');
    for (const select of await page.locator('select.vcp-select').all()) assert.ok((await select.boundingBox()).height < 64, 'Narrow account selectors must remain compact');
    assert.equal(await page.locator('.vcp-card').first().evaluate(node => getComputedStyle(node).paddingLeft), '12px', 'Narrow card padding must override the desktop rule');
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-mobile-dark.png'), fullPage: true });
    await page.evaluate(() => { delete document.documentElement.dataset.fixtureTheme; });
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-mobile.png'), fullPage: true });
    // Empty-account onboarding must work without a technical ID form or any official browser page.
    await page.evaluate(() => {
      window.fixtureState.accounts = [];
      window.fixtureState.active = { 'agent-plan': null, 'coding-plan': null };
      window.fixtureState.enabled = { 'agent-plan': false, 'coding-plan': false };
      window.fixtureState.login = { jobId: null, state: 'idle', message: '' };
    });
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.getByText('还没有账号。', { exact: false }).waitFor();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-empty.png'), fullPage: true });
    await page.getByRole('button', { name: '网页登录', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureState.accounts.length), 0);
    await page.getByRole('button', { name: '确认并打开官方登录页', exact: true }).click();
    await page.getByText('身份与套餐已更新（离线测试）').waitFor();
    await page.getByRole('button', { name: '用于 Agent套餐', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureState.active['agent-plan']), 'account-1');
    assert.equal(await page.evaluate(() => window.fixtureState.enabled['agent-plan']), true);
    assert.equal(await page.evaluate(() => window.fixtureState.active['coding-plan']), null);
    await page.getByRole('button', { name: '刷新额度', exact: true }).first().click();
    await page.getByText('剩余 75%').waitFor();
    // Render a few real pinned names through the same RPC fixture, with IDs folded.
    const { getModelRows } = await import('../src/catalog.mjs');
    const { initialState } = await import('../src/state.mjs');
    const namedRows = getModelRows(initialState(), 'default', 'agent-plan').filter(row => ['doubao-seed-2-1-pro-260915', 'deepseek-v4-1-flash-261017', 'kimi-k3-1-pro-261024'].includes(row.id));
    await page.evaluate(rows => {
      const catalog = window.fixtureState.catalogs.find(row => row.plan === 'agent-plan');
      catalog.models = rows; catalog.count = rows.length; catalog.enabledCount = rows.length;
    }, namedRows);
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.dataset.fixtureTheme = 'dark'; });
    await page.getByText('模型列表（已启用 3 / 共 3）', { exact: true }).first().click();
    for (const name of ['豆包 Seed 2.1 Pro', 'DeepSeek V4.1 Flash', 'Kimi K3.1 Pro']) await page.getByText(name, { exact: true }).waitFor();
    const namedSection = page.locator('section[aria-label="火山方舟 · Agent 套餐模型目录"]');
    for (const details of await namedSection.locator('.vcp-model details').all()) assert.equal(await details.getAttribute('open'), null);
    await namedSection.screenshot({ path: screenshot.replace(/\.png$/, '-models.png') });
    await page.evaluate(() => window.fixtureDispose());
    assert.deepEqual(errors, []);
    console.log('Browser smoke passed: real React/Chrome, provider/model toggles, model parameters/reset, quota grouping, login confirmation and dispose; fake RPC, HTTP(S) blocked.');
    console.log('Screenshot:', screenshot);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
