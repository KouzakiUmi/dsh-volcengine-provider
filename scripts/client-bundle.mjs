// Client bundle 的单一事实源：构建脚本与客户端测试必须用同一份模块顺序。
// 之前两处测试各自复制拼接逻辑，新模块只在 build.mjs 加过一次，
// 结果"构建产物能跑、测试报 rateBadge is not defined"。这里统一。
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 进入 Client bundle 的模块，按拼接顺序排列。
 * shared 模块（media-config / rate-badge）必须排在 client.js 之前：
 * bundle 是单作用域拼接，client 直接引用这些顶层函数与常量。
 */
export const CLIENT_BUNDLE_MODULES = [
  'src/media-config.mjs',
  'src/rate-badge.mjs',
  'src/remote.mjs',
  'src/client-media-data.js',
  'src/client-media-lightbox.js',
  'src/client-media.js',
  'src/client-arkcli.js',
  'src/client.js'
];

/**
 * 生成 Client bundle 源码。
 * @param {(name: string) => Promise<string>} read 以仓库相对路径读取源码
 * @returns {Promise<string>} ModuleLoader 工厂源码
 */
export async function buildClientBundle(read) {
  const parts = [];
  for (const name of CLIENT_BUNDLE_MODULES) parts.push((await read(name)).replace(/^export /gm, ''));
  return `window.__ModuleLoader__.load({id:'dsh-volcengine-provider',factory:(require)=>{\n'use strict';\n${parts.join('\n')}\nreturn {name,inject,apply};\n}});\n`;
}

/** 以文件系统读取器构造 bundle（构建脚本与测试共用）。 */
export async function buildClientBundleFromDisk(root) {
  return buildClientBundle(name => readFile(join(root, name), 'utf8'));
}

/** 同步版本，供测试的同步装载路径使用（同一份模块顺序）。 */
export function buildClientBundleSync(read) {
  return `window.__ModuleLoader__.load({id:'dsh-volcengine-provider',factory:(require)=>{\n'use strict';\n${CLIENT_BUNDLE_MODULES
    .map(name => read(name).replace(/^export /gm, '')).join('\n')}\nreturn {name,inject,apply};\n}});\n`;
}

/** 以同步文件系统读取器构造 bundle。 */
export function buildClientBundleSyncFromDisk(root) {
  return buildClientBundleSync(name => readFileSync(join(root, name), 'utf8'));
}
