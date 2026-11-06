import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = [];
for (const folder of ['src', 'scripts', 'test']) for (const name of await readdir(folder)) if (/\.(mjs|cjs|js)$/.test(name)) files.push(`${folder}/${name}`);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const client = await readFile('src/client.js', 'utf8');
if (/from\s+['"]node:|require\(['"](?:node:|fs|path|child_process)/.test(client)) throw new Error('Client contains a Node dependency');
// Host 源码的相对导入必须解析到 src 下的文件：构建按目录复制，漏一个源文件 lib 就缺一份模块。
const sourceNames = new Set(await readdir('src'));
for (const name of sourceNames) {
  if (!/\.(mjs|js)$/.test(name)) continue;
  const source = await readFile(`src/${name}`, 'utf8');
  for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith('./')) continue;
    const target = specifier.slice(2);
    if (target.includes('/') || !sourceNames.has(target)) throw new Error(`src/${name} 引用了 src 之外或不存在的模块：${specifier}`);
  }
}
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (!manifest.dsh?.bundle?.patch || !manifest.exports['./client']) throw new Error('Invalid plugin manifest');
console.log(`Syntax checked ${files.length} sources; manifest, client boundary and import closure checked`);
