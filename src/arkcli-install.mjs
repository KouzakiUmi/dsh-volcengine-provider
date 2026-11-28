import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { cliEnvironment } from './cli.mjs';

const unpack = promisify(gunzip);
const exec = promisify(execFile);
const BLOCK = 512;
const MAX_DOWNLOAD = 32 * 1024 * 1024;
const MAX_TAR = 64 * 1024 * 1024;

export function managedArkCliPath(statePath, release) {
  return release ? resolve(dirname(statePath), 'arkcli', release.version, release.target, release.filename) : undefined;
}

function installError(message) { return Object.assign(new Error(message), { code: 'ARKCLI_INSTALL' }); }

async function download(release, fetchImpl, signal) {
  let response;
  try { response = await fetchImpl(release.url, { signal, redirect: 'error' }); }
  catch { throw installError('无法连接 npm 官方 registry 下载 ArkCli，请检查 DSH Host 的网络后重试。'); }
  try {
    if (!response.ok || !response.body) throw installError(`npm registry 未能提供 ArkCli 安装包（HTTP ${response.status}）。`);
    if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD) throw installError('ArkCli 安装包超过下载大小限制。');
    const chunks = [];
    const hash = createHash('sha512');
    let bytes = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD) throw installError('ArkCli 安装包超过下载大小限制。');
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (hash.digest('base64') !== release.sha512) throw installError('ArkCli 安装包完整性校验失败，未使用下载内容。');
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    if (error.code === 'ARKCLI_INSTALL') throw error;
    throw installError('ArkCli 下载中断，请检查 DSH Host 的网络后重试。');
  }
}

// Read a single regular file from a digest-pinned npm tarball. No tar path is used for filesystem writes.
function findBinary(tar, filename) {
  const field = (offset, length) => tar.toString('ascii', offset, offset + length).split('\0', 1)[0];
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const name = field(offset, 100);
    if (!name) break;
    const size = field(offset + 124, 12).trim();
    if (!/^[0-7]+$/.test(size)) break;
    const length = parseInt(size, 8);
    const start = offset + BLOCK;
    if (length > tar.length - start) break;
    if (!field(offset + 345, 155) && name === `package/bin/${filename}` && length > 0 && [0, 48].includes(tar[offset + 156])) {
      return tar.subarray(start, start + length);
    }
    offset = start + Math.ceil(length / BLOCK) * BLOCK;
  }
  throw installError('ArkCli 安装包里没有目标平台的原生可执行文件。');
}

async function verifyVersion(path, stage, version, signal) {
  let stdout;
  try {
    ({ stdout } = await exec(path, ['--version'], {
      cwd: stage, env: cliEnvironment(stage), maxBuffer: 4096, timeout: 6000, windowsHide: true, signal
    }));
  } catch { throw installError('下载的 ArkCli 无法在当前 DSH Host 运行；请检查架构及插件数据目录的执行权限。'); }
  if (!stdout.trim().split(/\s+/u).some(part => part === version || part === `v${version}`)) {
    throw installError('ArkCli 自检版本与固定的发行版本不匹配。');
  }
}

async function alreadyInstalled(path, binary) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === binary.length && (await readFile(path)).equals(binary);
  } catch { return false; }
}

export async function installManagedArkCli({ destination, release, fetchImpl = globalThis.fetch, verify = verifyVersion, signal }) {
  const timeout = AbortSignal.timeout(90_000);
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let stage;
  try {
    const archive = await download(release, fetchImpl, signal);
    const tar = await unpack(archive, { maxOutputLength: MAX_TAR }).catch(() => { throw installError('ArkCli 安装包无法解压或超过解压大小限制。'); });
    signal.throwIfAborted();
    const binary = findBinary(tar, release.filename);
    const dir = dirname(destination);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    stage = await mkdtemp(join(dir, '.install-'));
    const candidate = join(stage, release.filename);
    await writeFile(candidate, binary, { flag: 'wx', mode: 0o700, signal });
    if (process.platform !== 'win32') await chmod(candidate, 0o700);
    await verify(candidate, stage, release.version, signal);
    signal.throwIfAborted();
    try { await rename(candidate, destination); }
    catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || !await alreadyInstalled(destination, binary)) throw error;
    }
  } catch (error) {
    if (timeout.aborted) throw installError('ArkCli 安装超时，请检查 DSH Host 网络后重试。');
    if (signal.aborted) throw installError('ArkCli 安装已取消。');
    if (error.code === 'ARKCLI_INSTALL') throw error;
    throw installError('无法在当前 DSH Host 的插件数据目录安装 ArkCli；请检查目录权限和可用空间。');
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
