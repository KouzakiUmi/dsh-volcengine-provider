import { mkdir, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildClientBundleFromDisk } from './client-bundle.mjs';
const root = new URL('../', import.meta.url);
const target = new URL('lib/', root);
// lib/ 是纯生成产物：先整体清空，避免已删除模块的残留文件被一起打包或加载。
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
// src 下的运行时模块（.mjs）与快照（.json）全部复制；client.js 与共享模块合并进下方 bundle。
const modules = (await readdir(new URL('src/', root))).filter(name => /\.(?:mjs|json)$/.test(name));
for (const name of modules) await copyFile(new URL(`src/${name}`, root), new URL(name, target));
// 拼接顺序由 scripts/client-bundle.mjs 统一维护，客户端测试复用同一份定义。
const bundle = await buildClientBundleFromDisk(fileURLToPath(root));
await writeFile(new URL('client.js', target), bundle);
console.log(`Built ${modules.length + 1} files in ${fileURLToPath(target)}`);
