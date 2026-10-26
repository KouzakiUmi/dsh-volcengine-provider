import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACTS_DIR,
  PACKAGE_NAME,
  REPOSITORY,
  WORKFLOW_FILE,
  assertToolVersions,
  assertTrustedEnvironment,
  assertVersionNotPublished,
  buildPublishArgs,
  findForbiddenTokenVars,
  main,
  resolvePackageInfo,
  selectDistTag,
  verifyPublishedVersion,
  verifyTarball,
} from '../scripts/npm-publish.mjs';

function trustedEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/tags/v0.1.0',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW_FILE}@refs/tags/v0.1.0`,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-token',
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function fakeSpawn(calls, exitCode = 0) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const handlers = new Map();
    const child = {
      on(event, handler) {
        handlers.set(event, handler);
        return child;
      },
    };
    setImmediate(() => {
      const close = handlers.get('close');
      if (close) close(exitCode);
    });
    return child;
  };
}

async function fixtureWorkspace({ version = '0.1.0', content = 'tarball-bytes' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-npm-publish-'));
  const artifacts = path.join(root, ARTIFACTS_DIR);
  await mkdir(artifacts, { recursive: true });
  const file = `${PACKAGE_NAME}-${version}.tgz`;
  await writeFile(path.join(artifacts, file), content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const info = { file, version, sha256, files: 1 };
  await writeFile(path.join(artifacts, 'package-info.json'), JSON.stringify(info));
  return { root, artifacts, file, info, sha256 };
}

test('ordinary versions use latest and only prereleases use next', () => {
  assert.equal(selectDistTag('0.1.0'), 'latest');
  assert.equal(selectDistTag('0.9.9'), 'latest');
  assert.equal(selectDistTag('1.0.0'), 'latest');
  assert.equal(selectDistTag('1.2.3'), 'latest');
  assert.equal(selectDistTag('2.0.0'), 'latest');
  assert.equal(selectDistTag('1.0.0-beta.1'), 'next');
  assert.equal(selectDistTag('0.1.0-rc.1'), 'next');
});

test('tool versions below the trusted-publishing minimum are rejected', () => {
  assert.doesNotThrow(() => assertToolVersions({ nodeVersion: 'v22.14.0', npmVersion: '11.5.1' }));
  assert.doesNotThrow(() => assertToolVersions({ nodeVersion: 'v24.0.0', npmVersion: '11.9.0' }));
  assert.throws(() => assertToolVersions({ nodeVersion: 'v22.13.0', npmVersion: '11.5.1' }), /Node/);
  assert.throws(() => assertToolVersions({ nodeVersion: 'v24.0.0', npmVersion: '11.5.0' }), /npm/);
});

test('long-lived npm credentials are rejected in every spelling', () => {
  assert.deepEqual(findForbiddenTokenVars(trustedEnv()), []);
  assert.deepEqual(findForbiddenTokenVars(trustedEnv({ NODE_AUTH_TOKEN: 'npm_x' })), ['NODE_AUTH_TOKEN']);
  assert.deepEqual(findForbiddenTokenVars(trustedEnv({ NPM_TOKEN: 'npm_x' })), ['NPM_TOKEN']);
  assert.deepEqual(findForbiddenTokenVars(trustedEnv({ 'npm_config//registry.npmjs.org/:_authToken': 'npm_x' })), ['npm_config//registry.npmjs.org/:_authToken']);
  assert.throws(() => assertTrustedEnvironment(trustedEnv({ NODE_AUTH_TOKEN: 'npm_x' })), /long-lived npm credentials/);
});

test('only a tagged push of this repository in this workflow is trusted', () => {
  assert.throws(() => assertTrustedEnvironment(trustedEnv({ GITHUB_ACTIONS: 'false' })), /GITHUB_ACTIONS/);
  assert.throws(() => assertTrustedEnvironment(trustedEnv({ GITHUB_EVENT_NAME: 'pull_request' })), /GITHUB_EVENT_NAME/);
  assert.throws(() => assertTrustedEnvironment(trustedEnv({ GITHUB_REF: 'refs/heads/main' })), /GITHUB_REF/);
  assert.throws(() => assertTrustedEnvironment(trustedEnv({ GITHUB_REPOSITORY: 'someone/dsh-volcengine-provider' })), /GITHUB_REPOSITORY/);
  assert.throws(() => assertTrustedEnvironment(trustedEnv({ GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/other.yml@refs/tags/v0.1.0` })), /GITHUB_WORKFLOW_REF/);
  assert.throws(() => assertTrustedEnvironment(trustedEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: '' })), /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.throws(() => assertTrustedEnvironment(trustedEnv({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' })), /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.equal(assertTrustedEnvironment(trustedEnv()).tag, 'v0.1.0');
});

test('package info file name must match the project name and version', () => {
  assert.deepEqual(resolvePackageInfo({ file: `${PACKAGE_NAME}-0.1.0.tgz`, version: '0.1.0', sha256: 'a'.repeat(64) }).file, `${PACKAGE_NAME}-0.1.0.tgz`);
  assert.throws(() => resolvePackageInfo({ file: 'other-0.1.0.tgz', version: '0.1.0', sha256: 'a'.repeat(64) }), /named/);
  assert.throws(() => resolvePackageInfo({ file: `${PACKAGE_NAME}-0.2.0.tgz`, version: '0.1.0', sha256: 'a'.repeat(64) }), /named/);
  assert.throws(() => resolvePackageInfo({ file: `../${PACKAGE_NAME}-0.1.0.tgz`, version: '0.1.0', sha256: 'a'.repeat(64) }), /bare file name/);
  assert.throws(() => resolvePackageInfo({ file: `release-artifacts\\${PACKAGE_NAME}-0.1.0.tgz`, version: '0.1.0', sha256: 'a'.repeat(64) }), /bare file name/);
  assert.throws(() => resolvePackageInfo({ file: `${PACKAGE_NAME}-0.1.0.tgz`, version: '0.1.0', sha256: 'not-a-digest' }), /sha256/);
});

test('tarball checksum must match the verified package info', async () => {
  const workspace = await fixtureWorkspace();
  const verified = await verifyTarball({ info: workspace.info, artifactsDir: workspace.artifacts });
  assert.equal(verified.sha256, workspace.sha256);
  assert.equal(verified.file, `${PACKAGE_NAME}-0.1.0.tgz`);
  await writeFile(path.join(workspace.artifacts, workspace.file), 'tampered');
  await assert.rejects(() => verifyTarball({ info: workspace.info, artifactsDir: workspace.artifacts }), /checksum mismatch/);
});

test('registry pre-check treats only 404 as absent', async () => {
  const notFound = async () => jsonResponse(404, { error: 'Not found' });
  await assert.doesNotReject(() => assertVersionNotPublished(notFound, PACKAGE_NAME, '0.1.0'));
  await assert.rejects(() => assertVersionNotPublished(async () => jsonResponse(200, { name: PACKAGE_NAME }), PACKAGE_NAME, '0.1.0'), /already published/);
  await assert.rejects(() => assertVersionNotPublished(async () => jsonResponse(401, {}), PACKAGE_NAME, '0.1.0'), /HTTP 401/);
  await assert.rejects(() => assertVersionNotPublished(async () => jsonResponse(500, {}), PACKAGE_NAME, '0.1.0'), /HTTP 500/);
  await assert.rejects(() => assertVersionNotPublished(async () => { throw new Error('network down'); }, PACKAGE_NAME, '0.1.0'), /pre-check failed/);
});

test('publish arguments carry the trusted registry, channel and provenance', () => {
  const args = buildPublishArgs({ file: `${PACKAGE_NAME}-0.1.0.tgz`, channel: 'latest' });
  assert.deepEqual(args, [
    'publish',
    `./${ARTIFACTS_DIR}/${PACKAGE_NAME}-0.1.0.tgz`,
    '--access',
    'public',
    '--tag',
    'latest',
    '--provenance',
    '--ignore-scripts',
    '--registry=https://registry.npmjs.org/',
  ]);
});

test('a full run publishes exactly once and verifies the published state', async () => {
  const workspace = await fixtureWorkspace();
  const calls = [];
  const requests = [];
  const sha512 = createHash('sha512').update('tarball-bytes').digest('base64');
  let versionRequests = 0;
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('/dist-tags')) return jsonResponse(200, { latest: '0.1.0' });
    if (url.includes('/-/npm/v1/attestations/')) return jsonResponse(200, { attestations: [{ predicateType: 'https://github.com/npm/attestation/dsl' }] });
    versionRequests += 1;
    if (versionRequests === 1) return jsonResponse(404, { error: 'Not found' });
    return jsonResponse(200, { name: PACKAGE_NAME, version: '0.1.0', dist: { integrity: `sha512-${sha512}` } });
  };
  const result = await main({
    env: trustedEnv(),
    cwd: workspace.root,
    fetchImpl,
    spawnImpl: fakeSpawn(calls),
    run: async () => '11.5.1',
    nodeVersion: 'v24.0.0',
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(result.version, '0.1.0');
  assert.equal(result.channel, 'latest');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'publish');
  assert.ok(requests.some((url) => url.includes('/-/package/') && url.includes('dist-tags')));
  assert.ok(requests.some((url) => url.includes('/-/npm/v1/attestations/')));
});

test('an already published version stops before npm publish', async () => {
  const workspace = await fixtureWorkspace();
  const calls = [];
  await assert.rejects(() => main({
    env: trustedEnv(),
    cwd: workspace.root,
    fetchImpl: async () => jsonResponse(200, { name: PACKAGE_NAME, version: '0.1.0' }),
    spawnImpl: fakeSpawn(calls),
    run: async () => '11.5.1',
    nodeVersion: 'v24.0.0',
    sleep: async () => {},
    log: () => {},
  }), /already published/);
  assert.equal(calls.length, 0);
});

test('verification allows asynchronous registry indexing beyond the former 30 second window', async () => {
  const sha512 = createHash('sha512').update('tarball-bytes').digest('base64');
  let versionReads = 0;
  const delays = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/dist-tags')) return jsonResponse(200, { latest: '0.1.0' });
    if (url.includes('/-/npm/v1/attestations/')) return jsonResponse(200, { attestations: [{ predicateType: 'https://slsa.dev/provenance/v1' }] });
    versionReads += 1;
    if (versionReads <= 12) return jsonResponse(404, { error: 'Still processing' });
    return jsonResponse(200, { name: PACKAGE_NAME, version: '0.1.0', dist: { integrity: `sha512-${sha512}` } });
  };
  const result = await verifyPublishedVersion({ fetchImpl, name: PACKAGE_NAME, version: '0.1.0', channel: 'latest', sha512, sleep: async ms => { delays.push(ms); } });
  assert.equal(result.attempts, 13);
  assert.equal(delays.length, 12);
  assert.ok(delays.every(ms => ms === 5000));
});

test('published state verification fails on mismatched integrity or missing attestation', async () => {
  const sha512 = createHash('sha512').update('tarball-bytes').digest('base64');
  const good = async (url) => {
    if (url.endsWith('/dist-tags')) return jsonResponse(200, { latest: '0.1.0' });
    if (url.includes('/-/npm/v1/attestations/')) return jsonResponse(200, { attestations: [{ predicateType: 'x' }] });
    return jsonResponse(200, { name: PACKAGE_NAME, version: '0.1.0', dist: { integrity: `sha512-${sha512}` } });
  };
  await assert.doesNotReject(() => verifyPublishedVersion({ fetchImpl: good, name: PACKAGE_NAME, version: '0.1.0', channel: 'latest', sha512, attempts: 1, sleep: async () => {} }));
  const wrongIntegrity = async (url) => {
    if (url.endsWith('/dist-tags')) return jsonResponse(200, { latest: '0.1.0' });
    if (url.includes('/-/npm/v1/attestations/')) return jsonResponse(200, { attestations: [{ predicateType: 'x' }] });
    return jsonResponse(200, { name: PACKAGE_NAME, version: '0.1.0', dist: { integrity: 'sha512-wrong' } });
  };
  await assert.rejects(() => verifyPublishedVersion({ fetchImpl: wrongIntegrity, name: PACKAGE_NAME, version: '0.1.0', channel: 'latest', sha512, attempts: 1, sleep: async () => {} }), /integrity mismatch/);
  const noAttestation = async (url) => {
    if (url.endsWith('/dist-tags')) return jsonResponse(200, { latest: '0.1.0' });
    if (url.includes('/-/npm/v1/attestations/')) return jsonResponse(200, { attestations: [] });
    return jsonResponse(200, { name: PACKAGE_NAME, version: '0.1.0', dist: { integrity: `sha512-${sha512}` } });
  };
  await assert.rejects(() => verifyPublishedVersion({ fetchImpl: noAttestation, name: PACKAGE_NAME, version: '0.1.0', channel: 'latest', sha512, attempts: 1, sleep: async () => {} }), /attestation/);
});
