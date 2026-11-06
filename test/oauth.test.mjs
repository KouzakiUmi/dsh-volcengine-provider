import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArkOAuth } from '../src/oauth.mjs';
import { approvedLoginUrl, extractLoginUrl } from '../src/login-url.mjs';
import { cliEnvironment, parseJsonOutput } from '../src/cli.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const url = 'https://ark.volcengine.com/region:cn-beijing/arkcli/login?state=test-session-123456789';
const code = 'AbCdEf1234567890-_=';

async function fixture(t, onSuccess = async () => {}) {
  const home = await mkdtemp(join(tmpdir(), 'ark-oauth-test-'));
  const launches = [];
  const oauth = new ArkOAuth({ onSuccess, timeoutMs: 1000,
    spawn: (exe, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
      child.kill = () => { child.killed = true; return true; };
      launches.push({ exe, args, options, child });
      return child;
    }
  });
  t.after(async () => {
    oauth.dispose(); await oauth.current?.done;
    assert.ok(home.startsWith(join(tmpdir(), 'ark-oauth-test-')));
    await rm(home, { recursive: true, force: true });
  });
  const start = async () => {
    const status = oauth.start({ accountId: 'a', executable: 'fake', home, homeId: 'h', revision: 'rev' });
    await tick();
    return status;
  };
  const phase1 = async (text = `打开链接完成登录:\n${url}\n`, exitCode = 0) => {
    const launch = launches[0];
    launch.child.stdout.emit('data', Buffer.from(text));
    launch.child.exitCode = exitCode;
    launch.child.emit('close', exitCode);
    await tick();
  };
  const submit = async (jobId, value = code) => {
    oauth.submitCode(jobId, value);
    await tick();
  };
  const phase2 = async (exitCode = 0) => {
    const launch = launches[1];
    launch.child.exitCode = exitCode;
    launch.child.emit('close', exitCode);
    await tick();
    await oauth.current.done;
  };
  return { oauth, home, start, phase1, submit, phase2, launches };
}

test('只放行官方主机与路径的登录链接', () => {
  assert.equal(approvedLoginUrl(url), url);
  assert.equal(extractLoginUrl(`请在浏览器打开 ${url} 完成登录`), url);
  assert.equal(approvedLoginUrl('https://signin.volcengine.com/authorize/oauth/authorize'), 'https://signin.volcengine.com/authorize/oauth/authorize');
  for (const raw of [
    url.replace('ark.volcengine.com', 'ark.volcengine.com.evil.test'),
    url.replace('https:', 'http:'),
    url.replace('ark.volcengine.com', 'user:pass@ark.volcengine.com'),
    'https://ark.volcengine.com/evil/path'
  ]) assert.equal(approvedLoginUrl(raw), undefined);
  assert.equal(extractLoginUrl('no link here'), undefined);
});

test('CLI 身份保持隔离，云凭据不继承', () => {
  const env = cliEnvironment('C:/fake-account', { PATH: 'safe', VOLC_ACCESSKEY: 'fake', ARK_API_KEY: 'fake', USERPROFILE: 'original' });
  assert.equal(env.HOME, 'C:/fake-account');
  assert.equal(env.USERPROFILE, 'C:/fake-account');
  assert.equal(env.VOLC_ACCESSKEY, undefined);
  assert.equal(env.ARK_API_KEY, undefined);
  assert.equal(env.ARKCLI_NO_UPDATE_NOTIFIER, '1');
});

test('CLI JSON 解析错误不回显原始输出', () => {
  assert.deepEqual(parseJsonOutput('{"models":[]}'), { models: [] });
  assert.throws(() => parseJsonOutput('fake-sensitive-output'), error => !error.message.includes('fake-sensitive-output'));
});

test('Phase 1 使用官方跨设备 volc-sso 命令，不启动浏览器桥', async t => {
  const f = await fixture(t);
  await f.start();
  assert.deepEqual(f.launches[0].args, ['auth', 'login', 'volc-sso', '--no-browser']);
  assert.equal(f.launches[0].options.env.USERPROFILE, f.home);
  assert.equal(f.launches[0].options.stdio[0], 'ignore');
  assert.ok(!f.launches[0].options.env.PATH?.includes('browser-bridge'));
  assert.throws(() => f.oauth.start({}), /已有登录/);
});

test('Phase 1 只把白名单链接下发给设置页，CLI 其它输出不进入状态', async t => {
  const f = await fixture(t);
  await f.start();
  await f.phase1(`fake-secret-token\n${url}\n`);
  const status = f.oauth.status();
  assert.equal(status.state, 'waiting');
  assert.equal(status.url, url);
  assert.ok(!JSON.stringify(status).includes('fake-secret-token'));
  assert.equal(f.launches.length, 1);
});

test('授权码只进 Phase 2 的 argv，不进入公开状态', async t => {
  const f = await fixture(t);
  const s = await f.start();
  await f.phase1();
  await f.submit(s.jobId);
  assert.deepEqual(f.launches[1].args, ['auth', 'login', '--no-browser', '--code', code, '--credential-store', 'encrypted-file']);
  assert.ok(!JSON.stringify(f.oauth.status()).includes(code));
  await f.phase2();
});

test('完整两段式成功后才绑定账号并核验身份', async t => {
  let verified = false;
  const f = await fixture(t, async (id, rev) => { assert.equal(id, 'a'); assert.equal(rev, 'rev'); verified = true; });
  const s = await f.start();
  await f.phase1();
  assert.equal(verified, false);
  await f.submit(s.jobId);
  await f.phase2();
  assert.equal(verified, true);
  assert.equal(f.oauth.status().state, 'success');
});

test('CLI 未输出合法官方链接时安全失败', async t => {
  const f = await fixture(t);
  await f.start();
  await f.phase1('https://evil.example.test/login');
  assert.equal(f.oauth.status().state, 'error');
  assert.equal(f.launches.length, 1);
});

test('Phase 1 非零退出不会进入等待授权码状态', async t => {
  const f = await fixture(t);
  await f.start();
  await f.phase1(`打开 ${url}`, 1);
  assert.equal(f.oauth.status().state, 'error');
  assert.equal(f.oauth.status().url, null);
});

test('CLI 输出 ok:false 时即使退出码为 0 也算失败', async t => {
  const f = await fixture(t);
  await f.start();
  // 官方 CLI 的错误分支可能以退出码 0 返回 {"ok":false,...}（1.0.37 实测）。
  await f.phase1(`{"ok":false,"error":{"message":"x"}}\n${url}`, 0);
  assert.equal(f.oauth.status().state, 'error');
  assert.equal(f.oauth.status().url, null);
});

test('volc-sso 的真实 JSON 输出可提取白名单链接', async t => {
  const f = await fixture(t);
  await f.start();
  // ArkCli 1.0.37 实测 Phase 1 输出形态：中文提示行 + 官方 JSON（authorize_pending，无 ok 字段）。
  const jsonUrl = 'https://signin.volcengine.com/authorize/oauth/authorize?client_id=trn%3Asignin%3A%3A%3Adevtools%2Fcross-device&state=abc123';
  await f.phase1(`请在任意设备的浏览器中打开以下 URL 完成火山 SSO 认证：\n\n${jsonUrl}\n\n{"authorize_url":"${jsonUrl}","expires_in_sec":600,"method":"sso_no_browser","next_command":"arkcli auth login --no-browser --code <code>","stage":"authorize_pending"}`, 0);
  const status = f.oauth.status();
  assert.equal(status.state, 'waiting');
  assert.equal(status.url, jsonUrl);
});

test('授权码格式、任务 ID 与状态都校验', async t => {
  const f = await fixture(t);
  const s = await f.start();
  assert.throws(() => f.oauth.submitCode(s.jobId, code), /没有等待授权码/);
  await f.phase1();
  assert.throws(() => f.oauth.submitCode('wrong-id', code), /没有等待授权码/);
  assert.throws(() => f.oauth.submitCode(s.jobId, 'short'), /格式不正确/);
  assert.throws(() => f.oauth.submitCode(s.jobId, 'has spaces and\nnewline'), /格式不正确/);
  assert.equal(f.oauth.status().state, 'waiting');
});

test('取消后迟到的 CLI 成功不会绑定账号', async t => {
  let verified = false;
  const f = await fixture(t, async () => { verified = true; });
  const s = await f.start();
  await f.phase1();
  assert.equal(f.oauth.cancel('wrong-id').state, 'waiting');
  assert.equal(f.oauth.cancel(s.jobId).state, 'cancelled');
  f.launches[0].child.emit('close', 0);
  await tick();
  assert.equal(verified, false);
});

test('身份核验失败不能宣称登录成功', async t => {
  const f = await fixture(t, async () => { throw new Error('fake-secret'); });
  const s = await f.start();
  await f.phase1();
  await f.submit(s.jobId);
  await f.phase2();
  assert.equal(f.oauth.status().state, 'error');
  assert.ok(!JSON.stringify(f.oauth.status()).includes('fake-secret'));
});

test('超时终止等待中的两段式任务且不绑定', async t => {
  const f = await fixture(t);
  f.oauth.timeoutMs = 80;
  await f.start();
  await f.phase1();
  await new Promise(resolve => setTimeout(resolve, 110));
  await f.oauth.current.done;
  assert.equal(f.oauth.status().state, 'error');
});
