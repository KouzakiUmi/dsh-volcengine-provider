import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { arkCliRelease } from '../src/arkcli-release.mjs';
import { installManagedArkCli, managedArkCliPath } from '../src/arkcli-install.mjs';
import { ArkCliRuntime } from '../src/arkcli-runtime.mjs';
import { locateCli } from '../src/cli.mjs';

const host = arkCliRelease();
const missing = () => Object.assign(new Error('missing'), { code: 'ARKCLI_MISSING' });
const noPackages = { resolve: () => { throw Object.assign(new Error('not installed'), { code: 'MODULE_NOT_FOUND' }); } };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-arkcli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(bin) {
  await mkdir(dirname(bin), { recursive: true });
  await writeFile(bin, 'test executable', { mode: 0o700 });
}

test('official matrix: Linux proot ARM64 resolves to native ARM64, not the Windows client architecture', () => {
  assert.equal(arkCliRelease('linux', 'arm64').filename, 'arkcli-linux-arm64');
  assert.equal(arkCliRelease('linux', 'x64').filename, 'arkcli-linux-amd64');
  assert.equal(arkCliRelease('win32', 'arm64').filename, 'arkcli-windows-arm64.exe');
  assert.match(arkCliRelease('darwin', 'arm64').url, /^https:\/\/registry\.npmjs\.org\/@volcengine\/ark-cli-darwin-arm64\/-\/ark-cli-darwin-arm64-1\.0\.70\.tgz$/u);
  assert.equal(arkCliRelease('android', 'arm64'), null);
  assert.equal(arkCliRelease('linux', 'riscv64'), null);
  assert.equal(managedArkCliPath('local-state/state.json', arkCliRelease('linux', 'arm64')),
    resolve('local-state', 'arkcli', '1.0.70', 'linux-arm64', 'arkcli-linux-arm64'));
});

test('finds the official npm platform package even when the DSH Host has no npm bin on PATH', { skip: !host }, async t => {
  const home = await fixture(t);
  const prefix = join(home, 'volc-prefix');
  const modules = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  const wrapper = join(modules, '@volcengine', 'ark-cli', 'package.json');
  const bin = join(dirname(wrapper), 'node_modules', host.name, 'bin', host.filename);
  await write(bin);
  await writeFile(join(dirname(bin), '..', 'package.json'), '{}');
  await writeFile(wrapper, '{}');
  assert.equal(await locateCli('', { home, env: { PATH: '', npm_config_prefix: prefix }, loader: noPackages }), bin);
});

test('configured path comes first; stale configuration is not silently replaced by the managed copy', { skip: !host }, async t => {
  const home = await fixture(t);
  const managed = managedArkCliPath(join(home, 'state.json'), host);
  const fallback = join(home, 'bin', process.platform === 'win32' ? 'arkcli.exe' : 'arkcli');
  const explicit = join(home, host.filename);
  const options = { home, env: { PATH: dirname(fallback) }, managed, loader: noPackages };
  await write(managed);
  assert.equal(await locateCli('', options), managed);
  await mkdir(fallback, { recursive: true });
  assert.equal(await locateCli('', options), managed, 'a directory cannot be a CLI');
  await rm(fallback, { recursive: true });
  await write(fallback);
  assert.equal(await locateCli('', options), fallback);
  if (process.platform !== 'win32') {
    await chmod(fallback, 0o600);
    assert.equal(await locateCli('', options), managed);
  }
  await assert.rejects(locateCli(explicit, options), { code: 'ARKCLI_CONFIG' });
  await write(explicit);
  assert.equal(await locateCli(explicit, options), explicit);
});

function archiveOf(name, contents = 'fixture', type = '0') {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(data.length.toString(8).padStart(11, '0'), 124);
  header.write(type, 156);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)]));
}

function bundle(archive) {
  return { ...host, sha512: createHash('sha512').update(archive).digest('base64') };
}

test('installation verifies exact bytes and version before atomically exposing the native CLI', { skip: !host }, async t => {
  const dir = await fixture(t);
  const target = managedArkCliPath(join(dir, 'state.json'), host);
  const archive = archiveOf(`package/bin/${host.filename}`);
  await installManagedArkCli({ destination: target, release: bundle(archive),
    fetchImpl: async (url, { signal, redirect }) => {
      assert.equal(url, host.url); assert.equal(redirect, 'error'); assert.equal(signal.aborted, false);
      return new Response(archive);
    },
    verify: async (staged, cwd, version) => {
      assert.equal(dirname(staged), cwd);
      assert.equal(version, host.version);
      assert.equal(await readFile(staged, 'utf8'), 'fixture');
      await assert.rejects(readFile(target), { code: 'ENOENT' });
    }
  });
  assert.equal(await readFile(target, 'utf8'), 'fixture');
  assert.deepEqual(await readdir(dirname(target)), [host.filename]);
});

test('bad digest, unexpected file types, over-limit downloads and rejected executables leave no staging payload', { skip: !host }, async t => {
  const dir = await fixture(t);
  const destination = managedArkCliPath(join(dir, 'state.json'), host);
  const binaryPath = `package/bin/${host.filename}`;
  const good = archiveOf(binaryPath);
  const link = archiveOf(binaryPath, 'outside', '2');
  const verify = async () => { throw new Error('cannot run fixture'); };
  await assert.rejects(installManagedArkCli({ destination, release: host, fetchImpl: async () => new Response(good), verify }), /完整性校验失败/u);
  await assert.rejects(installManagedArkCli({ destination, release: bundle(link), fetchImpl: async () => new Response(link), verify }), /没有目标平台/u);
  await assert.rejects(installManagedArkCli({ destination, release: bundle(good), fetchImpl: async () => new Response(good, {
    headers: { 'content-length': '999999999' }
  }), verify }), /大小限制/u);
  await assert.rejects(installManagedArkCli({ destination, release: bundle(good), fetchImpl: async () => new Response(good), verify }));
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dirname(destination)), []);
});

async function untilStopped(runtime) {
  for (let i = 0; i < 50; i++) {
    const view = await runtime.status();
    if (view.state !== 'installing') return view;
    await sleep(5);
  }
  throw new Error('fixture install did not settle');
}

test('read-only checks do not install; a Host job is single-flight, cancelable and retries without reloading', { skip: !host }, async t => {
  const dir = await fixture(t);
  let installed = false, runs = 0, clearCount = 0;
  const runtime = new ArkCliRuntime({ statePath: join(dir, 'state.json'),
    locate: async (_explicit, { managed }) => { if (!installed) throw missing(); return managed; },
    install: async ({ signal }) => {
      runs++;
      if (runs === 1) return sleep(1000, undefined, { signal });
      installed = true;
    }, onInstalled: () => { clearCount++; }
  });
  const before = await runtime.status();
  assert.equal(before.state, 'missing');
  assert.equal(runs, 0);
  await assert.rejects(runtime.start({ ...before, version: '0.0.0' }), /平台或版本已变化/u);
  const results = await Promise.all([runtime.start(before), runtime.start(before)]);
  assert.deepEqual(results.map(r => r.state), ['installing', 'installing']);
  assert.equal(runs, 1);
  await runtime.cancel();
  assert.equal((await untilStopped(runtime)).state, 'failed');
  await runtime.start(before);
  assert.deepEqual(await untilStopped(runtime), { ...before, state: 'ready', source: 'managed' });
  assert.equal(await runtime.executable(), runtime.managed);
  await runtime.start(before);
  assert.equal(runs, 2); assert.equal(clearCount, 1);
});
