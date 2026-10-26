// POSIX CLI browser opener. No browser is launched here; the host receives the
// official URL through authenticated loopback IPC and owns Playwright.
import { request } from 'node:http';
const raw = process.argv[2];
try {
  if (process.argv.length !== 3) throw new Error('Invalid opener arguments');
  const target = new URL(raw), endpoint = new URL(process.env.DSH_ARK_BROWSER_ENDPOINT);
  if (target.protocol !== 'https:' || target.hostname !== 'ark.volcengine.com' || target.port || target.username || target.password || !/^\/(?:region:cn-beijing\/)?arkcli\/login$/.test(target.pathname)) throw new Error('Invalid target');
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/launch' || endpoint.search || endpoint.hash) throw new Error('Invalid endpoint');
  const token = process.env.DSH_ARK_BROWSER_TOKEN;
  if (!token || !/^[0-9a-f]{64}$/.test(token) || Buffer.byteLength(raw) > 16384) throw new Error('Invalid bridge request');
  const req = request(endpoint, { method: 'POST', headers: { 'x-dsh-ark-browser': token, 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(raw) }, timeout: 5000 }, response => {
    response.resume(); response.once('end', () => { if (response.statusCode !== 204) process.exitCode = 1; });
  });
  req.once('timeout', () => req.destroy());
  req.once('error', () => { process.exitCode = 1; });
  req.end(raw);
} catch { process.exitCode = 1; }
