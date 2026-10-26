import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { buildBrowserBridge } from './build-browser-bridge.mjs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const target = new URL('lib/', root);
await mkdir(target, { recursive: true });
const modules = ['index.mjs', 'state.mjs', 'catalog.mjs', 'catalog-snapshot.json', 'cli.mjs', 'oauth.mjs', 'oauth-browser.mjs', 'oauth-browser-worker.mjs', 'browser-bridge.mjs', 'browser-bridge-client.mjs', 'manager.mjs', 'quota.mjs', 'remote.mjs', 'model-defaults.mjs', 'adapter-lease.mjs'];
for (const name of modules) await copyFile(new URL(`src/${name}`, root), new URL(name, target));
for (const [platform, command] of [['linux', 'xdg-open'], ['darwin', 'open']]) {
  const path = `browser-bridge/${platform}/${command}`;
  await mkdir(new URL(`browser-bridge/${platform}/`, target), { recursive: true });
  await copyFile(new URL(`src/${path}`, root), new URL(path, target));
  await chmod(new URL(path, target), 0o755);
}
await buildBrowserBridge();
const remote = (await readFile(new URL('src/remote.mjs', root), 'utf8')).replace(/^export /gm, '');
const client = (await readFile(new URL('src/client.js', root), 'utf8')).replace(/^export /gm, '');
const bundle = `window.__ModuleLoader__.load({id:'dsh-volcengine-provider',factory:(require)=>{\n'use strict';\n${remote}\n${client}\nreturn {name,inject,apply};\n}});\n`;
await writeFile(new URL('client.js', target), bundle);
console.log(`Built ${modules.length + 1} files in ${fileURLToPath(target)}`);
