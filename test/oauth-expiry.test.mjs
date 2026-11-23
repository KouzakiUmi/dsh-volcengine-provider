// OAuth 登录态到期元数据模块的隔离测试：node --test test/oauth-expiry.test.mjs
// 只使用临时目录与构造的假 JWT，不读取任何真实凭据、不发起网络请求。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refreshTokenExpiry, readOAuthExpiry } from '../src/oauth-expiry.mjs';

const dirs = [];
after(async () => {
	for (const dir of dirs) {
		assert.ok(dir.startsWith(join(tmpdir(), 'dsh-volc-expiry-')));
		await rm(dir, { recursive: true, force: true });
	}
});

/** 构造只含指定 claim 的假 JWT（签名段无意义，模块只解读 payload）。 */
function fakeJwt(payload) {
	return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
}

async function tempHome() {
	const dir = await mkdtemp(join(tmpdir(), 'dsh-volc-expiry-'));
	dirs.push(dir);
	return dir;
}

async function writeIdentity(home, name, data) {
	const dir = join(home, '.arkcli', 'identities', name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'token.json'), typeof data === 'string' ? data : JSON.stringify(data));
}

// ── refreshTokenExpiry ─────────────────────────────────────────────────────────

test('refreshTokenExpiry 只取 exp claim 并换算为毫秒', () => {
	assert.equal(refreshTokenExpiry(fakeJwt({ exp: 1700000000, sub: 'secret-subject' })), 1700000000000);
});

test('refreshTokenExpiry 对非法输入一律返回 null', () => {
	assert.equal(refreshTokenExpiry(undefined), null);
	assert.equal(refreshTokenExpiry(null), null);
	assert.equal(refreshTokenExpiry(123), null);
	assert.equal(refreshTokenExpiry(''), null);
	assert.equal(refreshTokenExpiry('not-a-jwt'), null);
	assert.equal(refreshTokenExpiry('a.b'), null);
	assert.equal(refreshTokenExpiry('a..c'), null);
	assert.equal(refreshTokenExpiry(fakeJwt({})), null);
	assert.equal(refreshTokenExpiry(fakeJwt({ exp: '1700000000' })), null);
	assert.equal(refreshTokenExpiry(fakeJwt({ exp: 0 })), null);
	assert.equal(refreshTokenExpiry(fakeJwt({ exp: -5 })), null);
	assert.equal(refreshTokenExpiry(fakeJwt({ exp: Infinity })), null);
	assert.equal(refreshTokenExpiry('a.!!!invalid-base64!!!.c'), null);
});

// ── readOAuthExpiry ────────────────────────────────────────────────────────────

test('readOAuthExpiry 目录缺失时返回 null，不抛错', async () => {
	const home = await tempHome();
	assert.equal(await readOAuthExpiry(home), null);
	assert.equal(await readOAuthExpiry(join(home, '不存在')), null);
});

test('readOAuthExpiry 读取身份目录的 refresh_token 到期时间', async () => {
	const home = await tempHome();
	await writeIdentity(home, 'volc-1', { refresh_token: fakeJwt({ exp: 1700000000 }) });
	assert.equal(await readOAuthExpiry(home), 1700000000000);
});

test('readOAuthExpiry 多身份取最晚到期，损坏文件跳过', async () => {
	const home = await tempHome();
	await writeIdentity(home, 'volc-old', { refresh_token: fakeJwt({ exp: 1600000000 }) });
	await writeIdentity(home, 'volc-new', { refresh_token: fakeJwt({ exp: 1800000000 }) });
	await writeIdentity(home, 'volc-broken', '{bad json');
	await writeIdentity(home, 'volc-empty', {});
	assert.equal(await readOAuthExpiry(home), 1800000000000);
});

test('readOAuthExpiry 忽略非目录条目与缺失 token.json 的身份', async () => {
	const home = await tempHome();
	await writeIdentity(home, 'volc-1', { refresh_token: fakeJwt({ exp: 1700000000 }) });
	const identities = join(home, '.arkcli', 'identities');
	await writeFile(join(identities, 'stray-file'), 'x');
	await mkdir(join(identities, 'volc-no-token'), { recursive: true });
	assert.equal(await readOAuthExpiry(home), 1700000000000);
});

test('readOAuthExpiry 全部不可读时返回 null', async () => {
	const home = await tempHome();
	await writeIdentity(home, 'volc-broken', '{bad json');
	await writeIdentity(home, 'volc-no-rt', { id_token: fakeJwt({ exp: 1700000000 }) });
	assert.equal(await readOAuthExpiry(home), null);
});