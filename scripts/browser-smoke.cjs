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
    await context.route('**/plugins/dsh-volcengine-provider/image/file*', route => route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPwd3v6HwAE3AJ6zM4FjgAAAABJRU5ErkJggg==', 'base64')
    }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Theme switch for the offline fixture. The host marks dark mode on
    // <body data-ds-dark-theme>; the fixture sets and clears that attribute together
    // with its own token switch so native controls follow the same host signal.
    const setFixtureTheme = async theme => {
      await page.evaluate(mode => {
        if (mode === 'dark') {
          document.documentElement.dataset.fixtureTheme = 'dark';
          document.body.dataset.dsDarkTheme = '';
        } else {
          delete document.documentElement.dataset.fixtureTheme;
          delete document.body.dataset.dsDarkTheme;
        }
      }, theme);
    };
    await page.setContent('<!doctype html><html><head><base href="http://fixture.local/"></head><body><div id="root"></div></body></html>');
    // Controlled DSW theme tokens: this is an offline fixture, not the running host.
    // The host flags its dark theme on <body data-ds-dark-theme> and feeds the state
    // secondary aliases; the fixture mirrors both signals so native control color
    // schemes and status surfaces follow the same host switches.
    // Text and hover-surface tokens use the host's measured DSW values
    // (--dsw-alias-label-secondary -> neutral-bluish-700 / neutral-bluish-300,
    // --dsw-alias-interactive-bg-hover -> #2631480f / #ffffff14) so contrast
    // verdicts reflect the real host palette instead of a guess.
    const lightTokens = '--dsw-alias-label-primary:#1f2937;--dsw-alias-label-secondary:#61666b;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f7fa;--dsw-alias-border-l4:#e4e8ee;--dsw-alias-border-l3:#cdd4df;--dsw-alias-brand-primary:#2563eb;--dsw-alias-button-primary-fill:#2563eb;--dsw-alias-button-primary-hover:#1d4ed8;--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-state-error-primary:#b91c1c;--dsw-alias-state-warn-primary:#b45309;--dsw-alias-state-success-primary:#15803d';
    const darkTokens = '--dsw-alias-label-primary:#e5eaf1;--dsw-alias-label-secondary:#cfd3d6;--dsw-alias-bg-layer-1:#1b2029;--dsw-alias-bg-layer-2:#252d39;--dsw-alias-border-l4:#354152;--dsw-alias-border-l3:#46556b;--dsw-alias-brand-primary:#60a5fa;--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-state-error-primary:#f87171;--dsw-alias-state-warn-primary:#fbbf24;--dsw-alias-state-success-primary:#4ade80';
    await page.addStyleTag({ content: `
      :root{color-scheme:light;${lightTokens}}
      :root[data-fixture-theme=dark]{color-scheme:dark;${darkTokens}}
      body[data-ds-dark-theme]{color-scheme:dark;${darkTokens}}
      body{background:#f3f5f8;color:var(--dsw-alias-label-primary)}html[data-fixture-theme=dark] body,body[data-ds-dark-theme]{background:#11161e}
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
          const defaults = { contextWindow: 32768, maxTokens: 8192, imageInput: true, toolsEnabled: true, reasoningEfforts: { off: null, low: 'low', high: 'high' }, defaultReasoning: 'low', forceAdaptiveThinking: true };
          return { plan, accountId: 'default', count: 1, enabledCount: 1, source: 'local-snapshot', models: [{ id: 'demo-reasoning-model', name: '示例模型（假数据）', enabled: true, capabilityUnverified: true, consumption: { plan, multiplier: 1.25, regularMultiplier: 2.5, discounted: true, discountEndsAt: '2026-12-30T23:59:59+08:00' }, settings: {}, defaults, effective: { ...defaults } }] };
        }),
        routes: { 'agent-plan': 'volcengine-agent-plan', 'coding-plan': 'volcengine-coding-plan' }, login: { jobId: null, state: 'idle', message: '' }
        , media: { riskAcknowledged: false, imageTool: false, imageModel: 'doubao-seedream-5-0-pro' }
      };
      window.fixtureCalls = [];
      window.fixtureRequests = [];
      window.fixtureState = state;
      window.fixtureArkCli = { state: 'ready', source: 'host', platform: 'linux-arm64', version: '1.0.70' };
      const service = { async invoke(request) {
        window.fixtureCalls.push(request.op);
        window.fixtureRequests.push(structuredClone(request));
        if (window.fixtureFailOps && window.fixtureFailOps.has(request.op)) throw new Error('离线测试：故意失败');
        if (request.op === 'arkCliStatus') return { ok: true, value: structuredClone(window.fixtureArkCli) };
        if (request.op === 'installArkCli') {
          if (request.platform !== window.fixtureArkCli.platform || request.version !== window.fixtureArkCli.version) throw new Error('ArkCli 发行信息不匹配');
          window.fixtureArkCli.state = 'installing';
          return { ok: true, value: structuredClone(window.fixtureArkCli) };
        }
        if (request.op === 'cancelArkCliInstall') {
          window.fixtureArkCli.state = 'failed';
          window.fixtureArkCli.message = 'ArkCli 安装已取消。';
          return { ok: true, value: structuredClone(window.fixtureArkCli) };
        }
        if (request.op === 'saveAccount') {
          if (request.revision !== state.revision) throw new Error('设置已改变，请刷新后重试');
          state.accounts.push({ ...request.account, authMode: 'references', hasApiKeys: {}, hasQuotaAccess: {} });
          state.catalogs = state.catalogs.map(catalog => ({ ...catalog, accountId: request.account.id }));
          state.revision += '-a';
        }
        if (request.op === 'select') { state.active[request.plan] = request.accountId; state.revision += '-s'; }
        if (request.op === 'setProviderEnabled') { state.enabled[request.plan] = request.enabled; state.revision += '-p'; }
        if (request.op === 'setMedia') {
          state.media = {
            ...state.media,
            ...(request.riskAcknowledged === undefined ? {} : { riskAcknowledged: request.riskAcknowledged }),
            ...(request.imageTool === undefined ? {} : { imageTool: request.imageTool }),
            ...(request.imageModel === undefined ? {} : { imageModel: request.imageModel })
          };
          if (!state.media.riskAcknowledged) state.media.imageTool = false;
          state.revision += '-m';
        }
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
        if (request.op === 'quota') {
          // 重置时间一律相对当前时间生成：未来值驱动倒计时，另外给已到期与无法解析的样例。
          const now = Date.now();
          const windows = request.plan === 'coding-plan'
            ? [
              { kind: '5h', percent: 12.5, resetsAt: new Date(now + 90_000).toISOString() },
              { kind: 'week', percent: 39, resetsAt: new Date(now + 3 * 3600_000).toISOString() },
              { kind: 'month', percent: 68 }
            ]
            : [
              { kind: '5h', percent: 25, group: 'text', resetsAt: new Date(now + 90_000).toISOString(), detail: { used: 250, limit: 1000, unit: 'AFP' } },
              { kind: 'month', percent: 90, group: 'all', resetsAt: new Date(now + 3 * 3600_000).toISOString(), detail: { used: 9000, limit: 10000, unit: 'AFP' } },
              { kind: 'day', percent: 40, group: 'daily-capabilities', resetsAt: new Date(now - 60_000).toISOString(), detail: { used: 400, limit: 1000, unit: 'AFP' } },
              { kind: 'week', percent: 30, group: 'text', resetsAt: '未提供的时间' }
            ];
          value = { plan: request.plan, accountId: request.accountId, state: 'ok', updatedAt: new Date(now).toISOString(), windows };
        }
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
      window.fixtureDisposers = disposers;
      window.fixtureDispose = () => { for (const fn of disposers) fn(); };
      const ctx = {
        get: () => service, remote: { $mount: async () => () => {}, volcengineProvider: service },
        inject(_deps, callback) { callback(ctx); },
        effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') disposers.push(cleanup); return cleanup; },
        slots: {
          inject(_key, callback) { callback(); },
          register(options, component) {
            if (options.name === 'tool.call.toolview' && options.key === 'volc_imagine') {
              window.fixtureMediaComponent = component;
            }
            if (options.name !== 'settings.section') return;
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
    // 设置页按套餐分四个分区：Agent / 编程 / 账号 / 图片，隐藏不卸载。
    const quotaTab = page.getByRole('tab', { name: '额度', exact: true });
    const modelsTab = page.getByRole('tab', { name: '模型', exact: true });
    const accountsTab = page.getByRole('tab', { name: /账号与登录/ });
    const mediaTab = page.getByRole('tab', { name: '图片生成', exact: true });
    assert.equal(await page.locator('[role="tab"]').count(), 4, '设置页应恰好有四个分区标签');
    const tabStrip = page.locator('.vcp-tabs');
    assert.equal(await tabStrip.evaluate(node => getComputedStyle(node).overflowX), 'auto', '标签栏横向可滚动');
    assert.equal(await tabStrip.evaluate(node => getComputedStyle(node).overflowY), 'hidden', '标签栏不得出现竖向滚动条');
    assert.equal(await page.locator('.vcp-tabs .vcp-tab:last-child').evaluate(node => Math.ceil(node.getBoundingClientRect().right) <= Math.ceil(node.parentElement.getBoundingClientRect().right)), true, '宽视口下四个标签应完整落进标签栏');
    await accountsTab.click();
    // 已有账号时账号区默认折叠：摘要给出管理入口，点击后才展开账号与操作。
    const accountsDisclosure = page.locator('details.vcp-accounts-disclosure');
    assert.equal(await accountsDisclosure.count(), 1, '账号区应使用统一的折叠容器');
    assert.equal(await accountsDisclosure.evaluate(node => node.open), false, '已有账号时账号区默认折叠');
    const disclosureSummary = accountsDisclosure.locator('summary.vcp-account-summary');
    const disclosureText = (await disclosureSummary.innerText()).trim();
    assert.match(disclosureText, /^管理账号 · /, '折叠摘要应标明这是账号管理入口');
    assert.match(disclosureText, /测试账号（假数据）/, '折叠摘要应列出当前账号');
    await disclosureSummary.click();
    assert.equal(await accountsDisclosure.evaluate(node => node.open), true, '点击摘要后展开账号列表');
    await page.getByRole('button', { name: '新增账号', exact: true }).waitFor();
    await accountsTab.click();
    const providerToggle = page.getByRole('checkbox', { name: '启用火山方舟 · Agent 套餐', exact: true });
    await providerToggle.uncheck();
    assert.equal(await page.evaluate(() => window.fixtureState.active['agent-plan']), 'default');
    await providerToggle.check();
    for (const select of await page.locator('select.vcp-select:visible').all()) {
      const box = await select.boundingBox();
      assert.ok(box && box.height >= 24 && box.height < 64, `Account selector must stay compact (height=${box?.height}, box=${JSON.stringify(box)})`);
    }
    // 额度分区内两个套餐面板同时可见；切走后整区隐藏但保留。
    const agentCard = page.locator('section[aria-label="火山方舟 · Agent 套餐额度"]');
    const codingCard = page.locator('section[aria-label="火山方舟 · 编程套餐额度"]');
    await quotaTab.click();
    const agentBox = await agentCard.boundingBox();
    assert.ok(agentBox, 'Agent 套餐额度面板应可见');
    assert.ok(await codingCard.boundingBox(), '同一标签内两个套餐额度面板都可见');
    assert.equal(await page.locator('.vcp-plans').count(), 0, '套餐面板之间不得再有并排容器');
    await accountsTab.click();
    assert.equal(await agentCard.evaluate(node => node.closest('[hidden]') != null), true, '切到账号区后额度面板应隐藏但保留');
    await quotaTab.click();
    assert.ok(await agentCard.boundingBox(), '切回额度分区后面板重新可见');
    await accountsTab.click();
    const advanced = page.getByText('账号高级配置与标识', { exact: true }).first();
    await advanced.click();
    assert.equal(await advanced.evaluate(node => node.parentElement.open), true, 'Native details opens');
    await advanced.click();
    assert.equal(await advanced.evaluate(node => node.parentElement.open), false, 'Native details closes');
    await modelsTab.click();
    // 模型列表默认折叠，展开后才渲染模型卡片。
    const agentModelSection = page.locator('section[aria-label="火山方舟 · Agent 套餐模型目录"]');
    const modelListSummary = agentModelSection.locator('summary', { hasText: '模型列表' });
    await modelListSummary.click();
    assert.equal(await modelListSummary.evaluate(node => node.parentElement.open), true, '点击摘要后模型列表应展开');
    const firstModelCard = page.locator('.vcp-model').first();
    await firstModelCard.waitFor();
    const rateBadge = firstModelCard.locator('.vcp-rate-badge');
    // 倍率文案与选择器徽标共用一份契约：两位小数带 x 前缀，活动期附剩余天数。
    assert.match((await rateBadge.innerText()).trim(), /^x1\.25\s+活动 \d+ 天$/);
    assert.match(await rateBadge.getAttribute('title'), /Agent Plan AFP 输入\/输出抵扣系数/);
    assert.match(await rateBadge.getAttribute('title'), /限时活动价，至 .* 结束，之后恢复常规倍率 x2\.50/);
    assert.equal(await rateBadge.getAttribute('data-discount'), 'true');
    for (const tag of ['视觉', '可调思考', '上下文 32K', '输出 8K']) await firstModelCard.locator('.vcp-model-tag', { hasText: tag }).waitFor();
    const modelToggle = page.getByRole('checkbox', { name: '启用模型 demo-reasoning-model', exact: true }).first();
    await modelToggle.uncheck();
    const modelIdentity = page.getByText('模型技术标识与参数详情', { exact: true }).first();
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
    const imageCapability = page.getByRole('checkbox', { name: '图片输入', exact: true });
    const toolCapability = page.getByRole('checkbox', { name: '工具调用', exact: true });
    const textCapability = page.getByRole('checkbox', { name: '文本输入（固定开启）', exact: true });
    assert.equal(await textCapability.isChecked(), true, '文本输入必须始终保留');
    assert.equal(await textCapability.isDisabled(), true, '文本输入不应被关闭');
    assert.equal(await imageCapability.isChecked(), true, '默认图片能力应与目录一致');
    assert.equal(await toolCapability.isChecked(), true, '默认工具能力应与目录一致');
    await imageCapability.uncheck();
    await toolCapability.uncheck();
    await page.getByLabel('温度 temperature', { exact: true }).fill('0.4');
    await page.getByRole('button', { name: '保存参数', exact: true }).click();
    await page.waitForFunction(() => window.fixtureRequests.some(request => request.op === 'saveModelSettings'));
    const save = await page.evaluate(() => window.fixtureRequests.find(request => request.op === 'saveModelSettings'));
    assert.equal(save.settings.temperature, 0.4);
    assert.equal(save.settings.imageInput, false);
    assert.equal(save.settings.toolsEnabled, false);
    assert.equal(await page.evaluate(() => window.fixtureState.catalogs[0].models[0].enabled), false);
    assert.equal(await imageCapability.isChecked(), false);
    assert.equal(await toolCapability.isChecked(), false);
    await page.getByRole('button', { name: '恢复图片输入默认', exact: true }).click();
    assert.equal(await imageCapability.isChecked(), true, '恢复后应显示目录默认');
    assert.equal(await toolCapability.isChecked(), false, '恢复图片不应影响工具覆盖');
    await page.getByRole('button', { name: '恢复工具调用默认', exact: true }).click();
    assert.equal(await toolCapability.isChecked(), true, '恢复后应显示目录默认');
    await page.getByRole('button', { name: '保存参数', exact: true }).click();
    await page.waitForFunction(() => window.fixtureRequests.filter(request => request.op === 'saveModelSettings').length === 2);
    const inherited = await page.evaluate(() => window.fixtureRequests.filter(request => request.op === 'saveModelSettings').at(-1));
    assert.equal(Object.hasOwn(inherited.settings, 'imageInput'), false);
    assert.equal(Object.hasOwn(inherited.settings, 'toolsEnabled'), false);
    assert.equal(await page.evaluate(() => window.fixtureState.catalogs[0].models[0].enabled), false);
    await page.evaluate(() => {
      const model = window.fixtureState.catalogs[0].models[0];
      delete model.defaults.imageInput;
      delete model.effective.imageInput;
    });
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="图片输入"]')?.indeterminate === true);
    assert.equal(await imageCapability.getAttribute('aria-checked'), 'mixed', '未知目录默认不能显示成确定的禁用状态');
    await imageCapability.check();
    assert.equal(await imageCapability.evaluate(node => node.indeterminate), false, '手动选择后不应仍为未定态');
    await page.getByRole('button', { name: '恢复图片输入默认', exact: true }).click();
    assert.equal(await imageCapability.evaluate(node => node.indeterminate), true, '恢复未知默认应回到未定态');
    await page.evaluate(() => {
      const model = window.fixtureState.catalogs[0].models[0];
      model.defaults.imageInput = true;
      model.effective.imageInput = true;
    });
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await modelToggle.check();
    await page.getByRole('button', { name: '恢复默认 demo-reasoning-model', exact: true }).first().click();
    await page.waitForFunction(() => window.fixtureRequests.some(request => request.op === 'resetModelSettings'));
    await quotaTab.click();
    await page.getByRole('button', { name: '刷新额度', exact: true }).first().click();
    const agentQuota = page.locator('section[aria-label="火山方舟 · Agent 套餐额度"]');
    const agentBar = agentQuota.locator('[role="progressbar"][aria-valuetext="剩余 75%"]');
    await agentBar.waitFor();
    assert.equal(await agentBar.getAttribute('aria-valuenow'), '75', '可访问进度应表达真实剩余百分比');
    assert.ok((await agentBar.boundingBox()).height >= 6, '额度条应有足够的视觉厚度');
    const mainPercent = agentQuota.locator('.vcp-quota-percent').first();
    assert.equal((await mainPercent.innerText()).trim(), '75%');
    assert.ok(await mainPercent.evaluate(node => parseFloat(getComputedStyle(node).fontSize)) >= 18, '剩余比例应成为窗口的主要数字');
    // ── 额度倒计时与分组 ────────────────────────────────────────────────
    // 未来重置时间给出秒级倒计时，并随真实时间实时变动；已到期、无法解析与未提供各有独立文案。
    const textGroup = agentQuota.locator('section[aria-label="文本 / 向量模型额度"]');
    await textGroup.waitFor();
    assert.equal(await textGroup.locator('.vcp-quota-window').count(), 2, '文本分组只应包含自己的额度窗口');
    assert.equal(await agentQuota.locator('section[aria-label="全能力月度额度"] .vcp-quota-window').count(), 1, '月度分组只应包含自己的额度窗口');
    assert.equal(await agentQuota.locator('section[aria-label="每日能力限额"] .vcp-quota-window').count(), 1, '每日能力限额分组应包含自己的日窗口');
    const countdown = textGroup.locator('.vcp-quota-reset span').first();
    await countdown.waitFor();
    const countdownBefore = (await countdown.innerText()).trim();
    assert.match(countdownBefore, /^距重置 /, '未来重置时间应显示倒计时');
    // 真实时钟推进后倒计时文案必须变化，而不是静态快照。
    await page.waitForFunction(before => {
      const row = document.querySelector('section[aria-label="文本 / 向量模型额度"] .vcp-quota-reset span');
      return row ? row.textContent.trim() !== before : false;
    }, countdownBefore, { timeout: 6000 });
    const countdownAfter = (await countdown.innerText()).trim();
    assert.notEqual(countdownAfter, countdownBefore, '倒计时应随真实时间实时变动');
    assert.match(countdownAfter, /^距重置 /, '倒计时应始终保持剩余时间文案');
    const resetTime = textGroup.locator('time');
    assert.match((await resetTime.innerText()).trim(), /^重置于 /, '额度窗口应同时给出绝对重置时间');
    assert.ok(Number.isFinite(Date.parse(await resetTime.getAttribute('dateTime'))), '重置时间应是可解析的时间戳');
    // 已到期与无法解析的时间都只给出提示，不伪装成倒计时。
    const problemRows = agentQuota.locator('.vcp-quota-reset').filter({ hasText: '重置时间' });
    await problemRows.first().waitFor();
    assert.equal(await problemRows.count(), 2, '到期与无效窗口都应给出明确的重置时间提示');
    for (const row of await problemRows.all()) {
      assert.doesNotMatch((await row.innerText()).trim(), /^距重置/, '异常重置时间不应显示倒计时');
    }
    await agentQuota.getByText('已到重置时间，等待自动刷新', { exact: true }).first().waitFor();
    await accountsTab.click();
    const accountPanel = page.locator('section[aria-label="账号管理"]');
    const accountDisclosureNode = page.locator('details.vcp-accounts-disclosure');
    const accountCardButtons = page.locator('details.vcp-accounts-disclosure button');
    const accountDomState = await page.evaluate(() => {
      const details = document.querySelector('details.vcp-accounts-disclosure');
      const panel = document.querySelector('section[aria-label="账号管理"]');
      const button = [...(details?.querySelectorAll('button') ?? [])].find(node => node.textContent.trim() === '网页登录');
      return {
        selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
        panelHidden: panel?.closest('[hidden]') != null,
        detailsOpen: Boolean(details?.open),
        buttonCount: button ? 1 : 0,
        buttonVisible: Boolean(button && (button.offsetWidth || button.offsetHeight || button.getClientRects().length))
      };
    });
    assert.match(accountDomState.selectedTab, /^账号与登录/, `账号标签未生效：${JSON.stringify(accountDomState)}`);
    assert.equal(accountDomState.panelHidden, false, `账号分区应可见：${JSON.stringify(accountDomState)}`);
    assert.equal(accountDomState.buttonCount, 1, `账号卡片登录按钮应存在：${JSON.stringify(accountDomState)}`);
    if (!accountDomState.detailsOpen) {
      await accountDisclosureNode.locator('summary.vcp-account-summary').click();
      await accountCardButtons.filter({ hasText: '网页登录' }).first().waitFor({ state: 'visible' });
    }
    const loginButton = page.getByRole('button', { name: '网页登录', exact: true }).first();
    await loginButton.waitFor({ state: 'attached' });
    const loginState = await loginButton.evaluate(node => ({
      disabled: node.disabled,
      visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
      hiddenAncestor: Boolean(node.closest('[hidden]')),
      openDisclosure: Boolean(node.closest('details')?.open),
      text: node.textContent.trim()
    }));
    assert.ok(loginState.visible && !loginState.disabled && !loginState.hiddenAncestor && loginState.openDisclosure, `登录入口应可点击：${JSON.stringify(loginState)}`);
    await loginButton.click();
    await page.getByRole('button', { name: '确认并生成登录链接', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.fixtureCalls)).includes('startLogin'), false);
    await page.getByRole('button', { name: '确认并生成登录链接', exact: true }).click();
    await page.getByText('测试状态：未执行真实登录').waitFor();
    // 登录进行中时账号区强制展开，登录进度文字因此可见。
    assert.equal(await accountsDisclosure.evaluate(node => node.open), true, '登录进行中时账号区应强制展开');
    assert.equal((await page.evaluate(() => window.fixtureCalls)).includes('startLogin'), true);
    await page.getByText('身份与套餐已更新（离线测试）').waitFor();
    await page.waitForFunction(() => {
      const select = document.querySelector('select[aria-label="火山方舟 · Agent 套餐使用账号"]');
      return select?.selectedOptions[0]?.textContent.includes('方舟体验账号（假数据）');
    });
    assert.match((await disclosureSummary.innerText()).trim(), /^管理账号 · /, '登录后账号摘要仍应是管理入口');
    assert.match(await disclosureSummary.innerText(), /方舟体验账号（假数据）/, '登录后账号摘要应更新为最新身份');
    assert.equal(await agentQuota.locator('[role="progressbar"][aria-valuetext="剩余 75%"]').count(), 0, 'Login invalidates previous identity quota');
    await quotaTab.click();
    const quotaRefresh = page.getByRole('button', { name: '刷新额度', exact: true });
    await quotaRefresh.nth(0).click();
    await quotaRefresh.nth(1).click();
    await page.locator('section[aria-label="火山方舟 · 编程套餐额度"] [role="progressbar"][aria-valuetext="剩余 87.5%"]').waitFor();
    // 编程套餐：三个窗口归入同一分组，缺少重置时间时给出「未提供」文案而非空白。
    const codingQuota = page.locator('section[aria-label="火山方舟 · 编程套餐额度"]');
    assert.equal(await codingQuota.locator('.vcp-quota-window').count(), 3, '编程套餐应展示三个额度窗口');
    assert.equal(await codingQuota.locator('.vcp-quota-group').count(), 1, '未分组的窗口应归入同一分组');
    await codingQuota.getByText('重置时间未提供', { exact: true }).first().waitFor();
    await codingQuota.getByText(/^距重置 /).first().waitFor();
    assert.equal(await codingQuota.locator('.vcp-quota-reset').filter({ hasText: '重置时间' }).count(), 1, '编程套餐只有缺失时间的窗口给出提示');
    // Keep the preview focused on account → plan → quota rather than an open parameter form.
    await accountsTab.click();
    await disclosureSummary.click();
    assert.equal(await accountsDisclosure.evaluate(node => node.open), false, '已完成登录后可重新收起账号管理');
    await quotaTab.click();
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    await setFixtureTheme('dark');
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-dark.png'), fullPage: true });
    // 宿主窗口可以很宽，但设置内容栏仍可能很窄：单独验证容器宽度而非只看 viewport。
    await page.evaluate(() => { document.getElementById('fixture-root').style.maxWidth = '390px'; });
    const panelAgent = await agentCard.boundingBox();
    assert.ok(panelAgent && panelAgent.width <= 390, 'A narrow settings panel must keep the plan panel within the container');
    assert.ok(await codingCard.boundingBox(), '窄内容栏下两个套餐额度面板都在同一分区内');
    assert.equal(await page.locator('.vcp-settings').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'Narrow host panel must not overflow horizontally');
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-narrow-panel-dark.png'), fullPage: true });
    await page.evaluate(() => { document.getElementById('fixture-root').style.maxWidth = '1000px'; });
    await page.setViewportSize({ width: 768, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Settings must fit an intermediate viewport');
    const agentModels = page.locator('section[aria-label="火山方舟 · Agent 套餐模型目录"]');
    for (const [tab, panel] of [[quotaTab, agentCard], [quotaTab, codingCard], [modelsTab, agentModels]]) {
      await tab.click();
      const box = await panel.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 769, 'Each panel must remain visible within the intermediate viewport');
    }
    await quotaTab.click();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-tablet-dark.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-compact-mobile-dark.png'), fullPage: true });
    await accountsTab.click();
    await disclosureSummary.click();
    const mobileNotice = page.locator('.vcp-notice[data-tone=success]:visible').first();
    await mobileNotice.waitFor();
    const noticeBox = await mobileNotice.boundingBox();
    const noticeTextBox = await mobileNotice.locator('p').boundingBox();
    assert.ok(noticeBox && noticeTextBox && noticeTextBox.x >= noticeBox.x + 25, 'Status text should wrap beside its icon on narrow screens');
    await quotaTab.click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Settings must fit a narrow viewport');
    for (const select of await page.locator('select.vcp-select:visible').all()) assert.ok((await select.boundingBox()).height < 64, 'Narrow account selectors must remain compact');
    // 窄屏下每个套餐分区只占整宽，另一套餐卡片保持隐藏，且额度重置行不得横向溢出。
    const narrowAgent = await agentCard.boundingBox();
    assert.ok(narrowAgent, '窄屏下 Agent 额度面板应可见');
    const narrowCoding = await codingCard.boundingBox();
    assert.ok(narrowCoding, '窄屏下编程套餐额度面板同样可见');
    assert.ok(narrowAgent.x >= 0 && narrowAgent.x + narrowAgent.width <= 391, '窄屏下额度面板不得溢出视口');
    assert.ok(narrowCoding.x >= 0 && narrowCoding.x + narrowCoding.width <= 391, '窄屏下编程套餐额度面板不得溢出视口');
    for (const reset of await page.locator('.vcp-quota-reset:visible').all()) {
      const box = await reset.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 391, '额度重置行不得溢出窄屏');
    }
    assert.equal(await page.locator('.vcp-plan-panel').first().evaluate(node => getComputedStyle(node).borderRadius), '10px', '套餐面板应保持统一圆角');
    // 可选的区块高度测量：DSH_TEST_MEASURE=1 时输出窄屏下展开/收起两种状态的高度分布，
    // 供设置页长度优化取证；不参与断言，测完恢复展开状态。
    if (process.env.DSH_TEST_MEASURE) {
      const measure = () => page.evaluate(() => {
        const parts = [];
        for (const node of document.querySelectorAll('.vcp-notice, .vcp-section, .vcp-details, .vcp-quota-group, .vcp-quota-window')) {
          const rect = node.getBoundingClientRect();
          if (rect.height < 1) continue;
          parts.push({
            className: String(node.className).slice(0, 60),
            height: Math.round(rect.height),
            label: (node.querySelector('summary, h4, .vcp-quota-name')?.textContent ?? '').trim().slice(0, 32),
          });
        }
        return { scrollHeight: document.documentElement.scrollHeight, parts };
      });
      console.log('MEASURE_EXPANDED', JSON.stringify(await measure(), null, 1));
      await modelListSummary.click();
      console.log('MEASURE_COLLAPSED', JSON.stringify(await measure(), null, 1));
      await modelListSummary.click();
    }
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-mobile-dark.png'), fullPage: true });
    await setFixtureTheme('light');
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-mobile.png'), fullPage: true });
    // Empty-account onboarding must work without a technical ID form or any official browser page.
    await quotaTab.click();
    await page.evaluate(() => {
      window.fixtureState.accounts = [];
      window.fixtureState.active = { 'agent-plan': null, 'coding-plan': null };
      window.fixtureState.enabled = { 'agent-plan': false, 'coding-plan': false };
      window.fixtureState.login = { jobId: null, state: 'idle', message: '' };
      window.fixtureArkCli.state = 'missing';
    });
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await accountsTab.click();
    await page.getByText('还没有账号。', { exact: false }).waitFor();
    const webLogin = page.getByRole('button', { name: '网页登录', exact: true });
    const install = page.getByRole('button', { name: '安装官方 ArkCli', exact: true });
    await install.waitFor();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-arkcli.png'), fullPage: true });
    const loginCallsBeforeInstall = await page.evaluate(() => window.fixtureCalls.filter(op => op === 'startLogin').length);
    assert.equal(await webLogin.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('installArkCli')), false, 'Detect must not start installation');
    await install.click();
    await page.getByText(/正在下载并校验 ArkCli/).waitFor();
    await page.getByRole('button', { name: '取消安装', exact: true }).click();
    await page.getByText('ArkCli 安装已取消。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重试安装 ArkCli', exact: true }).click();
    await page.evaluate(() => Object.assign(window.fixtureArkCli, { state: 'ready', source: 'managed' }));
    await page.getByText('ArkCli 1.0.70 已安装，可开始网页登录。', { exact: true }).waitFor();
    assert.equal(await webLogin.isEnabled(), true);
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(op => op === 'startLogin').length), loginCallsBeforeInstall, 'Installation must not start login');
    console.log('ArkCli setup smoke passed: host platform, explicit install, cancel, retry and login availability at 390px.');
    assert.equal(await accountsDisclosure.evaluate(node => node.open), true, '没有账号时账号区应始终展开');
    assert.equal((await disclosureSummary.innerText()).trim(), '添加账号', '没有账号时摘要应提示添加账号');
    await page.evaluate(() => window.scrollTo(0, 0));
    const emptyAccountBox = await page.locator('section[aria-label="账号管理"]').boundingBox();
    const firstLoginBox = await page.getByRole('button', { name: '网页登录', exact: true }).boundingBox();
    assert.ok(emptyAccountBox, '空账号时账号管理分区应可见');
    assert.ok(firstLoginBox && firstLoginBox.y >= 0 && firstLoginBox.y + firstLoginBox.height <= 844, '首次登录入口应在窄屏首屏可见');
    await disclosureSummary.click();
    await page.waitForFunction(() => document.querySelector('details.vcp-accounts-disclosure')?.open === true, undefined, { timeout: 2000 });
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-empty.png'), fullPage: true });
    await page.getByRole('button', { name: '网页登录', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureState.accounts.length), 0);
    await page.getByRole('button', { name: '确认并生成登录链接', exact: true }).click();
    await page.getByText('身份与套餐已更新（离线测试）').waitFor();
    await page.getByRole('button', { name: '用于 Agent套餐', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureState.active['agent-plan']), 'account-1');
    assert.equal(await page.evaluate(() => window.fixtureState.enabled['agent-plan']), true);
    assert.equal(await page.evaluate(() => window.fixtureState.active['coding-plan']), null);
    await quotaTab.click();
    await page.getByRole('button', { name: '刷新额度', exact: true }).first().click();
    await agentQuota.locator('[role="progressbar"][aria-valuetext="剩余 75%"]').waitFor();
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
    await setFixtureTheme('dark');
    await modelsTab.click();
    const namedSection = page.locator('section[aria-label="火山方舟 · Agent 套餐模型目录"]');
    // 模型列表默认折叠：未展开则先展开再断言模型名。
    if (!(await namedSection.locator('summary', { hasText: '模型列表' }).evaluate(node => node.parentElement.open))) {
      await namedSection.locator('summary', { hasText: '模型列表' }).click();
    }
    for (const name of ['豆包 Seed 2.1 Pro', 'DeepSeek V4.1 Flash', 'Kimi K3.1 Pro']) await page.getByText(name, { exact: true }).waitFor();
    for (const details of await namedSection.locator('.vcp-model details').all()) assert.equal(await details.getAttribute('open'), null);
    await namedSection.screenshot({ path: screenshot.replace(/\.png$/, '-models.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '模型参数 kimi-k3-1-pro-261024', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Expanded native model parameters must fit 390px');
    for (const label of ['上下文长度 contextWindow', '最大输出 token maxTokens', '默认思考档位 defaultReasoning', '思考模式 forceAdaptiveThinking']) {
      const box = await page.getByLabel(label, { exact: true }).boundingBox();
      assert.ok(box && box.height < 64 && box.x >= 0 && box.x + box.width <= 391, `${label} must fit the expanded narrow form`);
    }
    for (const label of ['图片输入', '工具调用']) {
      const box = await page.getByLabel(label, { exact: true }).boundingBox();
      assert.ok(box && box.height < 64 && box.x >= 0 && box.x + box.width <= 391, `${label} must fit the expanded narrow form`);
    }
    await namedSection.screenshot({ path: screenshot.replace(/\.png$/, '-mobile-models.png') });
    await namedSection.locator('.vcp-editor').screenshot({ path: screenshot.replace(/\.png$/, '-model-capabilities.png') });
    await mediaTab.click();
    await page.setViewportSize({ width: 1200, height: 1000 });
    assert.doesNotMatch(await page.locator('.vcp-content').innerText(), /Seedance|视频生成|volc_video/);
    // 图片生成只有一个开关：一次 setMedia 同时写入 riskAcknowledged 与 imageTool。
    const imageSwitch = page.getByRole('checkbox', { name: '启用图片生成', exact: true });
    assert.equal(await page.locator('section[aria-label="图片生成"] input[type="checkbox"]').count(), 1, '图片生成分区应只有一个开关');
    await imageSwitch.check();
    await page.waitForFunction(() => window.fixtureRequests.some(request => request.op === 'setMedia' && request.riskAcknowledged === true && request.imageTool === true));
    await page.waitForFunction(() => window.fixtureState.media.riskAcknowledged === true && window.fixtureState.media.imageTool === true);
    await page.getByLabel('默认图片模型', { exact: true }).first().selectOption('doubao-seedream-5.5');
    await page.waitForFunction(() => window.fixtureState.media.imageModel === 'doubao-seedream-5.5');
    await page.locator('section[aria-label="图片生成"]').screenshot({ path: screenshot.replace(/\.png$/, '-media.png') });
    await imageSwitch.uncheck();
    await page.waitForFunction(() => window.fixtureRequests.some(request => request.op === 'setMedia' && request.riskAcknowledged === false && request.imageTool === false));
    await imageSwitch.check();
    await page.getByLabel('默认图片模型', { exact: true }).first().screenshot({ path: screenshot.replace(/\.png$/, '-media-model.png') });
    await quotaTab.click();
    // ── 暗浅色配色可读性 ────────────────────────────────────────────────
    // 宿主用 body[data-ds-dark-theme] 标记深色，并提供 state-*-secondary 令牌。
    // 这里同时模拟「宿主给出实色 secondary 令牌」与「宿主缺少该令牌」两种配置，
    // 实测成功/警告/错误提示、原生 select 与 option、主按钮和次级说明文字的
    // 计算色与对比度。验收只看可读性，不约束具体实现写法。
    await page.setViewportSize({ width: 1200, height: 1000 });
    await setFixtureTheme('light');
    await page.evaluate(() => {
      const state = window.fixtureState;
      // 第二个账号让账号下拉有可切换项，用于触发一次真实失败并得到错误提示。
      state.accounts.push({ id: 'contrast-account', label: '对比验证账号（假数据）', authMode: 'references', apiKeyRefs: { 'agent-plan': 'AGENT_REF', 'coding-plan': 'CODING_REF' }, accessKeyRef: 'AK_REF', secretKeyRef: 'SK_REF', hasApiKeys: { 'agent-plan': true, 'coding-plan': true }, hasQuotaKeys: true, hasQuotaAccess: { 'agent-plan': true, 'coding-plan': true } });
      const oauth = state.accounts.find(account => account.id === 'account-1');
      // 编程套餐未绑定该 OAuth 身份，套餐卡片会给出警告提示。
      if (oauth) oauth.oauthProfiles = { 'agent-plan': 'demo-agent' };
      state.active['coding-plan'] = 'account-1';
      state.login = { ...state.login, state: 'success', message: '身份与套餐已更新（离线测试）' };
      window.fixtureFailOps = new Set(['select']);
    });
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await accountsTab.click();
    await page.getByText('此账号尚未绑定该套餐', { exact: false }).waitFor();
    await page.locator('.vcp-notice', { hasText: '正在更新账号与套餐状态' }).waitFor({ state: 'detached' });
    await page.getByLabel('火山方舟 · Agent 套餐使用账号', { exact: true }).first().selectOption('contrast-account');
    await page.getByText('切换账号失败', { exact: false }).waitFor();
    await page.locator('.vcp-notice', { hasText: '正在更新账号与套餐状态' }).waitFor({ state: 'detached' });
    // 取色探针：解析计算色、按祖先链合成实际背景、计算 WCAG 对比度。
    await page.evaluate(() => {
      const parseColor = value => {
        if (!value) return null;
        const text = String(value).trim().toLowerCase();
        if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        const functional = text.match(/^rgba?\(([^)]+)\)$/);
        if (functional) {
          const parts = functional[1].split(/[\s,/]+/).filter(Boolean).map(Number);
          if (parts.length < 3 || parts.some(part => Number.isNaN(part))) return null;
          return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
        }
        const hex = text.match(/^#([0-9a-f]{3,8})$/);
        if (hex) {
          const digits = hex[1];
          const channel = part => parseInt(part.length === 1 ? part + part : part, 16);
          if (digits.length === 3 || digits.length === 4) return { r: channel(digits[0]), g: channel(digits[1]), b: channel(digits[2]), a: digits.length === 4 ? channel(digits[3]) / 255 : 1 };
          if (digits.length === 6 || digits.length === 8) return { r: channel(digits.slice(0, 2)), g: channel(digits.slice(2, 4)), b: channel(digits.slice(4, 6)), a: digits.length === 8 ? channel(digits.slice(6, 8)) / 255 : 1 };
        }
        return null;
      };
      const over = (source, backdrop) => {
        const alpha = source.a + backdrop.a * (1 - source.a);
        if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r: (source.r * source.a + backdrop.r * backdrop.a * (1 - source.a)) / alpha,
          g: (source.g * source.a + backdrop.g * backdrop.a * (1 - source.a)) / alpha,
          b: (source.b * source.a + backdrop.b * backdrop.a * (1 - source.a)) / alpha,
          a: alpha
        };
      };
      const luminance = color => {
        const channel = value => {
          const scaled = value / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      };
      const contrast = (foreground, backdrop) => {
        const first = luminance(foreground);
        const second = luminance(backdrop);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };
      const ownBackground = element => parseColor(getComputedStyle(element).backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
      // 实际背景：把元素自己的背景色与祖先链上的背景色按 alpha 合成。
      const effectiveBackground = element => {
        const layers = [];
        let node = element;
        while (node && node.nodeType === 1) {
          const color = ownBackground(node);
          if (color.a > 0) layers.push(color);
          if (color.a >= 1) break;
          node = node.parentElement;
        }
        let result = { r: 255, g: 255, b: 255, a: 1 };
        for (let index = layers.length - 1; index >= 0; index -= 1) result = over(layers[index], result);
        return result;
      };
      const groupOpacity = element => {
        let opacity = 1;
        let node = element;
        while (node && node.nodeType === 1) {
          opacity *= Number(getComputedStyle(node).opacity);
          node = node.parentElement;
        }
        return opacity;
      };
      const isLargeText = element => {
        const style = getComputedStyle(element);
        const size = Number.parseFloat(style.fontSize);
        const weight = Number.parseInt(style.fontWeight, 10) || 400;
        return size >= 24 || (size >= 18.66 && weight >= 700);
      };
      const isDisabledControl = element => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) && element.disabled === true;
      const format = color => `rgb(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)})`;
      const describe = element => {
        const className = typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean).join('.') : '';
        const text = (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20)
          || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '';
        return `${element.tagName.toLowerCase()}${className ? '.' + className : ''}${text ? `「${text}」` : ''}`;
      };
      const sample = (label, element, backdropOverride, foregroundOverride) => {
        const style = getComputedStyle(element);
        const text = foregroundOverride || parseColor(style.color);
        if (!text || text.a === 0) return null;
        const backdrop = backdropOverride || effectiveBackground(element);
        const own = ownBackground(element);
        // 文字落在透明背景上时才受元素自身透明度影响；不透明背景整体淡出不影响内部对比。
        const foreground = over({ ...text, a: text.a * (own.a >= 1 ? 1 : groupOpacity(element)) }, backdrop);
        return {
          label,
          ratio: Number(contrast(foreground, backdrop).toFixed(2)),
          foreground: format(foreground),
          backdrop: format(backdrop),
          large: isLargeText(element),
          disabled: isDisabledControl(element)
        };
      };
      window.__contrast = {
        collect() {
          const samples = [];
          const schemes = [];
          const root = document.querySelector('.vcp-settings');
          if (!root) return { samples, schemes };
          const add = (label, element, backdrop, foreground) => {
            const entry = sample(label, element, backdrop, foreground);
            if (entry) samples.push(entry);
          };
          // 状态提示：容器本身承载图形标识，段落承载正文，两者都要能读。
          for (const notice of [...root.querySelectorAll('.vcp-notice')].filter(notice => !notice.closest('[hidden]'))) {
            const tone = notice.getAttribute('data-tone') || 'muted';
            add(`notice:${tone}`, notice);
            const text = notice.querySelector('p');
            if (text) add(`notice-text:${tone}`, text);
          }
          // 原生下拉：控件本身与其 option 的实际计算色。
          for (const select of [...root.querySelectorAll('select')].filter(select => !select.closest('[hidden]'))) {
            const name = select.getAttribute('aria-label') || select.className || 'select';
            add(`select:${name}`, select);
            const selectBackdrop = effectiveBackground(select);
            for (const option of select.options) {
              // 禁用项（失效档位或停用控件）不参与对比度要求。
              if (option.disabled || select.disabled) {
                samples.push({ label: `option-disabled:${name}:${(option.textContent || '').trim().slice(0, 12)}`, ratio: null, foreground: '', backdrop: '', large: false, disabled: true });
                continue;
              }
              const own = ownBackground(option);
              // 原生弹出层沿用下拉控件的底色，option 自身背景优先。
              const backdrop = own.a >= 1 ? own : over(own, selectBackdrop);
              add(`option:${name}:${(option.textContent || '').trim().slice(0, 12)}`, option, backdrop);
            }
            schemes.push({ label: `color-scheme:${name}`, scheme: getComputedStyle(select).colorScheme });
          }
          // 表单控件：控件内文字与占位文字的实际计算色。
          for (const control of [...root.querySelectorAll('input, textarea')].filter(control => !control.closest('[hidden]'))) {
            add(`control:${describe(control)}`, control);
            // 只采样真正可见的占位文字：控件要带 placeholder 且当前没有值。
            if (!control.getAttribute('placeholder') || control.value) continue;
            const placeholderStyle = getComputedStyle(control, '::placeholder');
            const placeholder = parseColor(placeholderStyle.color);
            if (!placeholder) continue;
            const alpha = placeholder.a * Number(placeholderStyle.opacity || 1);
            add(`placeholder:${describe(control)}`, control, undefined, { ...placeholder, a: alpha });
          }
          // 页面内所有承载文字的元素：按钮、说明文字、标题、标签等。
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node = root;
          while ((node = walker.nextNode())) {
            if (node.tagName === 'OPTION' || node.closest('option')) continue;
            if (node.closest('[hidden]')) continue;
            if (node.getAttribute('aria-hidden') === 'true' || node.closest('[aria-hidden="true"]')) continue;
            const text = Array.from(node.childNodes).filter(child => child.nodeType === 3).map(child => child.textContent).join('').trim();
            if (!text) continue;
            const kind = node.matches('.vcp-button-primary') ? 'primary-button'
              : node.matches('.vcp-button') ? 'secondary-button'
                : node.matches('.vcp-chip') ? 'chip'
                  : node.matches('.vcp-eyebrow') ? 'eyebrow'
                    : node.matches('summary') ? 'summary'
                      : node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' ? 'control'
                        : 'text';
            add(`${kind}:${describe(node)}`, node);
          }
          return { samples, schemes };
        }
      };
    });
    // 图片工具卡片：真实构建产物 + 本地 PNG 回源夹具，不读取宿主附件。
    await page.evaluate(() => {
      const fixtureRef = { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'original.png', bytes: 70 };
      const previewRef = { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/jpeg', bytes: 9, width: 1, height: 1, name: 'preview.jpg' };
      const block = {
        kind: 'tool-call', call: { name: 'volc_imagine', argsRaw: JSON.stringify({ prompt: '离线 PNG 原图预览' }) },
        content: [{ type: 'text', text: 'fixture' }, { type: 'image', attachment: previewRef }, { type: 'file', attachment: fixtureRef }],
        meta: { model: 'doubao-seedream-5.5', images: [previewRef], originals: [{ attachment: fixtureRef, mediaType: 'image/png', width: 1, height: 1 }] }
      };
      const container = document.createElement('section');
      container.id = 'media-fixture-root';
      container.style.cssText = 'max-width:760px;margin:24px auto;padding:0 12px';
      document.body.append(container);
      const root = window.fixtureModules['react-dom/client'].createRoot(container);
      const renderMedia = result => root.render(window.fixtureModules.react.createElement(window.fixtureMediaComponent, {
        owner: { phase: 'result', block: result, loadImage: async () => { throw new Error('原图结果不应读取规范化预览'); } }
      }));
      renderMedia(block);
      window.renderLayerFixture = () => renderMedia({
        ...block,
        call: { name: 'volc_imagine', argsRaw: JSON.stringify({ layer_decomposition: true }) },
        meta: { ...block.meta, originals: Array.from({ length: 9 }, (_, z_index) => ({
          ...block.meta.originals[0], z_index, name: `元素 ${z_index}`,
          attachment: { ...fixtureRef, name: z_index ? `layer-${z_index}.png` : 'base.png' },
          ...(z_index === 1 ? { bounding_box: { absolute: [0, 0, 1, 1] }, text_recognition: { text: '标题', lines: [] } } : {})
        })) }
      });
      window.fixtureDisposers.push(() => { root.unmount(); container.remove(); });
    });
    const mediaCard = page.locator('[data-testid="volc-imagine-card"]');
    await mediaCard.waitFor();
    const originalImage = mediaCard.locator('img').first();
    await originalImage.waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-testid="volc-imagine-card"] img');
      return image && image.complete && image.naturalWidth > 0;
    });
    assert.match(await originalImage.getAttribute('src'), /^\/plugins\/dsh-volcengine-provider\/image\/file\?/);
    assert.match(await mediaCard.locator('a[download="original.png"]').getAttribute('href'), /download=1/);
    await mediaCard.getByRole('button', { name: '查看大图：original.png', exact: true }).click();
    await page.locator('dialog.vcp-media-lightbox').waitFor();
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await page.getByText('150%', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('dialog.vcp-media-lightbox').waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 390, height: 844 });
    const mediaOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(mediaOverflow, false, '390px 图片卡片不能产生横向溢出');
    const mediaScreenshot = path.resolve(process.env.DSH_TEST_MEDIA_SCREENSHOT || 'test-output/client-media-preview.png');
    fs.mkdirSync(path.dirname(mediaScreenshot), { recursive: true });
    await mediaCard.screenshot({ path: mediaScreenshot });
    await page.evaluate(() => window.renderLayerFixture());
    await mediaCard.getByText('1 张底图 · 8 个图层', { exact: true }).waitFor();
    await mediaCard.getByText('图层信息与富文本 OCR', { exact: true }).click();
    assert.match(await mediaCard.locator('details[open]').innerText(), /底图像素坐标.*标题/s);
    const transparent = mediaCard.locator('img[data-transparent]').first();
    assert.match(await transparent.evaluate(node => getComputedStyle(node).backgroundImage), /repeating-conic-gradient/);
    assert.equal(await mediaCard.locator('img').count(), 8);
    await mediaCard.getByRole('button', { name: '下一页' }).click();
    await mediaCard.getByText('第 2 / 2 页', { exact: true }).waitFor();
    assert.match(await mediaCard.getByRole('link', { name: '下载图层 8' }).getAttribute('href'), /name=layer-8\.png.*download=1/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    console.log('Layer card smoke passed: checkerboard, OCR, coordinates, pagination and per-layer download at 390px.');
    await page.setViewportSize({ width: 1200, height: 1000 });
    console.log('Media card smoke passed: original PNG route, native download, lightbox zoom/Escape, 390px layout.');
    console.log('Media screenshot:', mediaScreenshot);

    const contrastFailures = [];
    const contrastReport = [];
    for (const theme of ['light', 'dark']) {
      for (const profile of ['solid-secondary', 'missing-secondary']) {
        await setFixtureTheme(theme);
        // 使用饱和实色 secondary 令牌，覆盖不能当作浅色背景使用的主题配置。
        await page.evaluate(mode => {
          const hostTokens = {
            '--dsw-alias-state-error-secondary': '#f25a5a',
            '--dsw-alias-state-warn-secondary': '#f7ad31',
            '--dsw-alias-state-success-secondary': '#4ed17e'
          };
          for (const [name, value] of Object.entries(hostTokens)) {
            if (mode === 'solid-secondary') document.documentElement.style.setProperty(name, value);
            else document.documentElement.style.removeProperty(name);
          }
        }, profile);
        const measured = await page.evaluate(() => window.__contrast.collect());
        const tones = new Set(measured.samples.filter(entry => entry.label.startsWith('notice:')).map(entry => entry.label.slice('notice:'.length)));
        if (!tones.size) contrastFailures.push(`${theme}/${profile}: 当前分区没有可采样提示，无法核对配色`);
        const worst = new Map();
        let skipped = 0;
        for (const entry of measured.samples) {
          if (entry.disabled) {
            skipped += 1;
            continue;
          }
          const minimum = entry.large ? 3 : 4.5;
          if (entry.ratio < minimum) contrastFailures.push(`${theme}/${profile}: ${entry.label} 对比度 ${entry.ratio}:1 低于 ${minimum}:1（前景 ${entry.foreground} / 背景 ${entry.backdrop}）`);
          const category = entry.label.split(':')[0];
          const current = worst.get(category);
          if (!current || entry.ratio < current.ratio) worst.set(category, { ratio: entry.ratio, label: entry.label });
        }
        contrastReport.push(`${theme}/${profile}：采样 ${measured.samples.length} 项（跳过禁用态 ${skipped} 项），各类最低对比度 —— ${[...worst.entries()].map(([category, entry]) => `${category} ${entry.ratio}:1`).join('，')}`);
        for (const entry of measured.schemes) {
          const expected = theme === 'dark' ? 'dark' : 'light';
          if (!String(entry.scheme).includes(expected)) contrastFailures.push(`${theme}/${profile}: ${entry.label} 为 ${entry.scheme}，原生控件未跟随宿主${expected === 'dark' ? '深色' : '浅色'}主题`);
        }
        if (profile === 'solid-secondary') {
          fs.mkdirSync(path.dirname(screenshot), { recursive: true });
          await page.screenshot({ path: screenshot.replace(/\.png$/, `-contrast-${theme}.png`), fullPage: true });
        }
      }
    }
    assert.equal(contrastFailures.length, 0, `暗浅色配色可读性未达标：\n${contrastFailures.join('\n')}`);
    console.log(`配色可读性：深浅色 × （宿主实色 secondary 令牌 / 缺失令牌）共 ${contrastReport.length} 组，全部达到 WCAG AA（正文 4.5:1 / 大字 3:1）。`);
    for (const line of contrastReport) console.log('  ' + line);
    await page.evaluate(() => window.fixtureDispose());
    assert.deepEqual(errors, []);
    console.log('Browser smoke passed: real React/Chrome, four-section tabs (one per plan), collapsed account disclosure (default closed, empty-account open), collapsed model list, single image-generation switch, provider/model toggles, model parameters/reset, quota grouping, live reset countdown, login confirmation, light/dark readability and dispose; fake RPC, HTTP(S) blocked.');
    console.log('Screenshot:', screenshot);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
