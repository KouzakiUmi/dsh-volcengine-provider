import { Worker } from 'node:worker_threads';

export function browserEnvironment(ambient = process.env) {
  return Object.fromEntries(Object.entries(ambient).filter(([key]) => !/^(ARK_|ARKCLI_|VOLC|AWS_|DSH_ARK_BROWSER_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|ELECTRON_RUN_AS_NODE$|PWDEBUG$|DEBUG(?:_FILE)?$|PLAYWRIGHT_)/i.test(key)));
}
export function approvedLoginUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    if (url.hostname !== 'ark.volcengine.com' || !/^\/(?:region:cn-beijing\/)?arkcli\/login\/?$/.test(url.pathname)) return undefined;
    const port = url.searchParams.get('callbackPort');
    if (!/^\d{1,5}$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) return undefined;
    for (const key of ['callbackNonce', 'sessionId']) {
      const value = url.searchParams.get(key);
      if (url.searchParams.getAll(key).length !== 1 || !/^[A-Za-z0-9_-]{16,256}$/.test(value ?? '')) return undefined;
    }
    if (url.searchParams.getAll('callbackPort').length !== 1) return undefined;
    return raw;
  } catch { return undefined; }
}
// This promise remains pending while the browser is open. The official CLI owns
// the same-device callback and identity; completion/cancel aborts this session.
export async function authorizeInBrowser(url, signal, options = {}) {
  if (options.chromium) return authorizeWithChromium(url, signal, options);
  if (!approvedLoginUrl(url)) throw new Error('官方同设备登录链接格式不受支持');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const factory = options.workerFactory ?? ((entry, config) => new Worker(entry, config));
    const worker = factory(new URL('./oauth-browser-worker.mjs', import.meta.url), {
      workerData: { url }, env: browserEnvironment(), execArgv: [], stdout: true, stderr: true
    });
    worker.stdout?.resume(); worker.stderr?.resume();
    let failed = false;
    const abort = () => worker.postMessage({ type: 'cancel' });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.once('error', () => { failed = true; });
    worker.once('exit', exit => {
      signal.removeEventListener('abort', abort);
      if (exit === 0 && !failed && !signal.aborted) resolve();
      else reject(new Error('独立浏览器已结束（驱动输出已隐藏）'));
    });
  });
}
export async function authorizeWithChromium(url, signal, { chromium } = {}) {
  if (!approvedLoginUrl(url)) throw new Error('官方同设备登录链接格式不受支持');
  signal.throwIfAborted();
  chromium ??= (await import('playwright-core')).chromium;
  signal.throwIfAborted();
  let browser, closeTask;
  const close = () => {
    if (browser && !closeTask) closeTask = browser.close();
    return closeTask;
  };
  const abort = () => { void close()?.catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true, env: browserEnvironment(), timeout: 30000 });
    signal.throwIfAborted();
    const disconnected = new Promise(resolve => browser.once('disconnected', resolve));
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    // No DOM/password/Cookie/code inspection. The generated URL is unchanged;
    // the official page sends its callback directly to the official CLI.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await disconnected;
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
    await close();
  }
}
