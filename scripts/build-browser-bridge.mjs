import { access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildBrowserBridge() {
  if (process.platform !== 'win32') return;
  const root = new URL('../', import.meta.url);
  const output = fileURLToPath(new URL('lib/browser-bridge/win32/rundll32.exe', root));
  const source = fileURLToPath(new URL('src/browser-bridge/BrowserBridge.cs', root));
  let compiler;
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    try { await access(candidate); compiler = candidate; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!compiler) throw new Error('Building the Windows browser bridge requires the Windows .NET Framework C# compiler');
  await mkdir(new URL('lib/browser-bridge/win32/', root), { recursive: true });
  await promisify(execFile)(compiler, ['/nologo', '/utf8output', '/target:winexe', '/optimize+', `/out:${output}`, source], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
}
