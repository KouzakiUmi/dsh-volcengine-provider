import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { approvedLoginUrl } from './oauth-browser.mjs';
import { execFile } from 'node:child_process';

// Browser interception is a safety boundary, not a best-effort compatibility
// feature. Reject unverified platforms/CLI versions before starting login.
export async function verifyBrowserBridgeCli(executable, { env, cwd, signal, platform = process.platform, exec = execFile }) {
  if (platform !== 'win32') throw new Error('当前同设备安全登录桥仅验收 Windows ArkCli 1.0.37');
  const version = await new Promise((resolve, reject) => exec(executable, ['--version'], { env, cwd, signal, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 16384 }, (error, stdout) => {
    if (error) reject(new Error('无法核验 ArkCli 版本'));
    else resolve(stdout.trim());
  }));
  if (!/(?:^|\s)v?1\.0\.37(?:\s|$)/.test(version)) throw new Error('同设备安全登录桥要求已核验的 ArkCli 1.0.37');
}

export async function createBrowserBridge({ onLaunch, signal, platform = process.platform, accessImpl = access }) {
  signal.throwIfAborted();
  const directory = fileURLToPath(new URL(`./browser-bridge/${platform}/`, import.meta.url));
  const opener = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : undefined;
  if (!opener) throw new Error('当前平台不支持隔离浏览器启动桥');
  await accessImpl(fileURLToPath(new URL(`./browser-bridge/${platform}/${opener}`, import.meta.url)), platform === 'win32' ? constants.F_OK : constants.X_OK);
  signal.throwIfAborted();
  const token = randomBytes(32).toString('hex');
  let launched, closeTask;
  const authenticated = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/launch' || !authenticated(request.headers['x-dsh-ark-browser'])) { response.writeHead(403).end(); request.resume(); return; }
    let body = '', bytes = 0;
    request.on('error', () => { response.destroy(); });
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16384) { response.writeHead(413).end(); request.destroy(); return; }
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      if (bytes > 16384 || signal.aborted) { response.writeHead(410).end(); return; }
      const url = approvedLoginUrl(body);
      if (!url) { response.writeHead(400).end(); return; }
      if (launched) { response.writeHead(launched === url ? 204 : 409).end(); return; }
      try { onLaunch(url); launched = url; response.writeHead(204).end(); }
      catch { response.writeHead(500).end(); }
      body = '';
    });
  });
  const close = () => {
    if (!closeTask) {
      launched = undefined;
      closeTask = new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
      signal.removeEventListener('abort', abort);
    }
    return closeTask;
  };
  const abort = () => { void close(); };
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { await close(); signal.throwIfAborted(); }
  const endpoint = `http://127.0.0.1:${server.address().port}/launch`;
  return {
    close,
    environment(env) {
      const inheritedPath = Object.entries(env).find(([key]) => /^path$/i.test(key))?.[1] ?? '';
      const next = Object.fromEntries(Object.entries(env).filter(([key]) => !/^path$|^DSH_ARK_BROWSER_|^NoDefaultCurrentDirectoryInExePath$/i.test(key)));
      return { ...next, PATH: directory + delimiter + inheritedPath, NoDefaultCurrentDirectoryInExePath: '1', DSH_ARK_BROWSER_ENDPOINT: endpoint, DSH_ARK_BROWSER_TOKEN: token, DSH_ARK_BROWSER_NODE: process.execPath, DSH_ARK_BROWSER_CLIENT: fileURLToPath(new URL('./browser-bridge-client.mjs', import.meta.url)), ELECTRON_RUN_AS_NODE: '1' };
    }
  };
}
