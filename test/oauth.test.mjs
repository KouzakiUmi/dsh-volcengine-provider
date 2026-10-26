import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArkOAuth, approvedLoginUrl } from '../src/oauth.mjs';
import { cliEnvironment, parseJsonOutput } from '../src/cli.mjs';
const tick = () => new Promise(r => setTimeout(r, 10));
async function fixture(t, onSuccess = async () => {}) {
  const home = await mkdtemp(join(tmpdir(), 'ark-oauth-test-'));
  t.after(() => { assert.ok(home.startsWith(join(tmpdir(), 'ark-oauth-test-'))); return rm(home, { recursive: true, force: true }); });
  let child, launch;
  const oauth = new ArkOAuth({ onSuccess, timeoutMs: 1000, spawn: (exe, args, options) => {
    launch = { exe, args, options };
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
    child.kill = () => { child.killed = true; return true; };
    return child;
  } });
  t.after(() => oauth.dispose());
  return { oauth, home, get child() { return child; }, get launch() { return launch; } };
}
test('OAuth only permits official HTTPS login URLs, not lookalikes or embedded credentials', () => {
  assert.ok(approvedLoginUrl('https://ark.volcengine.com/region:cn-beijing/arkcli/login?callbackNonce=fake-test'));
  assert.ok(approvedLoginUrl('https://signin.volcengine.com/authorize/oauth/authorize?state=fake'));
  for (const s of ['https://ark.volcengine.com.evil.test/arkcli/login', 'http://ark.volcengine.com/arkcli/login', 'https://user:pass@ark.volcengine.com/arkcli/login', 'https://ark.volcengine.com:8443/arkcli/login', 'javascript:alert(1)', 'https://signin.volcengine.com/evil']) assert.equal(approvedLoginUrl(s), undefined);
});
test('isolated CLI environment excludes ambient cloud identity and disables update notifier', () => {
  const env = cliEnvironment('C:/fake-account', { PATH: 'safe', VOLC_ACCESSKEY: 'not-real', ARK_API_KEY: 'not-real', USERPROFILE: 'original' });
  assert.equal(env.HOME, 'C:/fake-account'); assert.equal(env.USERPROFILE, 'C:/fake-account'); assert.equal(env.VOLC_ACCESSKEY, undefined); assert.equal(env.ARK_API_KEY, undefined); assert.equal(env.ARKCLI_NO_UPDATE_NOTIFIER, '1'); assert.equal(env.PATH, 'safe');
});
test('CLI JSON errors never echo raw output', () => {
  assert.deepEqual(parseJsonOutput('{"models":[]}'), { models: [] });
  assert.throws(() => parseJsonOutput('fake-sensitive-output'), error => !error.message.includes('fake-sensitive-output'));
});
test('login uses explicit OAuth subcommand without interactive root menu', async t => {
  const f = await fixture(t); const status = f.oauth.start({ accountId: 'a', executable: 'fake.exe', home: f.home, revision: 'rev' });
  assert.equal(status.state, 'launching'); await tick();
  assert.deepEqual(f.launch.args, ['auth', 'login', 'volc-sso']);
  assert.equal(f.launch.options.env.USERPROFILE, f.home); assert.equal(f.launch.options.stdio[0], 'ignore');
  assert.equal(f.oauth.status().state, 'waiting');
  assert.throws(() => f.oauth.start({}), /已有登录/);
});
test('never forwards raw CLI credentials or arbitrary URLs', async t => {
  const f = await fixture(t); f.oauth.start({ accountId: 'a', executable: 'fake', home: f.home, revision: 'rev' }); await tick();
  f.child.stderr.emit('data', Buffer.from('fake-secret https://evil.test/?token=fake-secret'));
  assert.equal(f.oauth.status().url, undefined); assert.ok(!JSON.stringify(f.oauth.status()).includes('fake-secret'));
  f.child.stdout.emit('data', Buffer.from('https://ark.volcengine.com/region:cn-beijing/arkcli/login?callbackNonce=fake-test\n'));
  assert.match(f.oauth.status().url, /arkcli\/login/);
});
test('success requires verification and clears transient authorize URL', async t => {
  let verified = false;
  const f = await fixture(t, async (id, rev) => { assert.equal(id, 'a'); assert.equal(rev, 'rev'); verified = true; });
  f.oauth.start({ accountId: 'a', executable: 'fake', home: f.home, revision: 'rev' }); await tick();
  f.child.exitCode = 0; f.child.emit('close', 0); await tick();
  assert.equal(verified, true); assert.equal(f.oauth.status().state, 'success'); assert.equal(f.oauth.status().url, undefined);
});
test('cancel kills only owned process and ignores late success', async t => {
  let verified = false; const f = await fixture(t, async () => { verified = true; });
  const s = f.oauth.start({ accountId: 'a', executable: 'fake', home: f.home, revision: 'rev' }); await tick();
  assert.equal(f.oauth.cancel('wrong-id').state, 'waiting');
  assert.equal(f.oauth.cancel(s.jobId).state, 'cancelled'); assert.equal(f.child.killed, true);
  f.child.emit('close', 0); await tick(); assert.equal(verified, false);
});
test('verification failure cannot claim login succeeded', async t => {
  const f = await fixture(t, async () => { throw new Error('fake-secret'); });
  f.oauth.start({ accountId: 'a', executable: 'fake', home: f.home, revision: 'rev' }); await tick();
  f.child.exitCode = 0; f.child.emit('close', 0); await tick();
  assert.equal(f.oauth.status().state, 'error'); assert.ok(!JSON.stringify(f.oauth.status()).includes('fake-secret'));
});
