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
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (!manifest.dsh?.bundle?.patch || !manifest.exports['./client']) throw new Error('Invalid plugin manifest');
console.log(`Syntax checked ${files.length} sources; manifest and client boundary checked`);
