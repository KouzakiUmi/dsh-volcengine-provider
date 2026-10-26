#!/usr/bin/env node
/**
 * Publish the packaged plugin to npm through npm Trusted Publishing (OIDC).
 *
 * The script never handles a long-lived npm token: the GitHub Actions OIDC
 * identity is the only credential. Every reusable decision is exported as a
 * pure function so it can be unit tested without touching the network.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE_NAME = 'dsh-volcengine-provider';
export const REPOSITORY = 'KouzakiUmi/dsh-volcengine-provider';
export const WORKFLOW_FILE = '.github/workflows/ci.yml';
export const REGISTRY = 'https://registry.npmjs.org/';
export const ARTIFACTS_DIR = 'release-artifacts';
export const PACKAGE_INFO_FILE = 'package-info.json';
export const MIN_NODE_VERSION = '22.14.0';
export const MIN_NPM_VERSION = '11.5.1';
export const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export class PublishError extends Error {}

function fail(message) {
  throw new PublishError(message);
}

/* ---------------------------------------------------------------- versions */

export function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(raw ?? '').trim());
  if (!match) fail(`Invalid version: ${raw}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function parseToolVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(raw ?? '').trim());
  if (!match) fail(`Cannot parse version: ${raw}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareToolVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function isAtLeast(raw, minimum) {
  return compareToolVersions(parseToolVersion(raw), parseToolVersion(minimum)) >= 0;
}

/** Only versions with a prerelease suffix use `next`; ordinary versions use `latest`. */
export function selectDistTag(version) {
  const parsed = parseVersion(version);
  return parsed.prerelease ? 'next' : 'latest';
}

/* ------------------------------------------------------------ environment */

export function findForbiddenTokenVars(env) {
  const flagged = [];
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper === 'NODE_AUTH_TOKEN' || upper === 'NPM_TOKEN' || upper === 'NPM_CONFIG__AUTH' || upper === 'NPM_CONFIG__AUTH_TOKEN' || upper.endsWith(':_AUTHTOKEN') || upper.endsWith(':_AUTH_TOKEN')) {
      flagged.push(name);
    }
  }
  return flagged;
}

/**
 * Accept only a trusted-publishing run: this repository, this workflow file,
 * a pushed version tag, and a GitHub OIDC request endpoint.
 */
export function assertTrustedEnvironment(env) {
  const problems = [];
  if (env.GITHUB_ACTIONS !== 'true') problems.push('GITHUB_ACTIONS is not "true"');
  if (env.GITHUB_EVENT_NAME !== 'push') problems.push('GITHUB_EVENT_NAME is not "push"');
  const ref = env.GITHUB_REF ?? '';
  if (!ref.startsWith('refs/tags/v')) problems.push(`GITHUB_REF is not a version tag ref: ${ref}`);
  if (env.GITHUB_REPOSITORY !== REPOSITORY) problems.push(`GITHUB_REPOSITORY must be ${REPOSITORY}`);
  const expectedWorkflowRef = `${REPOSITORY}/${WORKFLOW_FILE}@${ref}`;
  if (env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) problems.push(`GITHUB_WORKFLOW_REF must be ${expectedWorkflowRef}`);
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) problems.push('ACTIONS_ID_TOKEN_REQUEST_URL is missing');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) problems.push('ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing');
  const forbidden = findForbiddenTokenVars(env);
  if (forbidden.length > 0) problems.push(`long-lived npm credentials must not be present: ${forbidden.join(', ')}`);
  if (problems.length > 0) fail(problems.join('; '));
  return { ref, tag: ref.replace('refs/tags/', '') };
}

export function assertToolVersions({ nodeVersion, npmVersion }) {
  if (!isAtLeast(nodeVersion, MIN_NODE_VERSION)) fail(`Node ${nodeVersion} is older than the required ${MIN_NODE_VERSION}`);
  if (!isAtLeast(npmVersion, MIN_NPM_VERSION)) fail(`npm ${npmVersion} is older than the required ${MIN_NPM_VERSION}`);
}

function defaultRun(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new PublishError(`${command} exited with code ${code}`));
    });
  });
}

/** Read the versions actually installed on the runner; never infer them from the Node release. */
export async function readToolVersions({ run = defaultRun, nodeVersion = process.version } = {}) {
  const npmVersion = await run(NPM_COMMAND, ['--version']);
  return { nodeVersion, npmVersion: String(npmVersion).trim() };
}

/* ---------------------------------------------------------- package files */

/** Validate the package info document produced by scripts/verify-package.py. */
export function resolvePackageInfo(info, expectedName = PACKAGE_NAME) {
  if (!info || typeof info !== 'object') fail('package info must be an object');
  const { file, version, sha256 } = info;
  if (typeof file !== 'string' || file.length === 0) fail('package info is missing the file name');
  const normalized = file.replace(/\\/g, '/');
  if (normalized !== file || path.posix.basename(normalized) !== normalized) fail(`package info file must be a bare file name: ${file}`);
  if (typeof version !== 'string') fail('package info is missing the version');
  parseVersion(version);
  if (file !== `${expectedName}-${version}.tgz`) fail(`package file must be named ${expectedName}-${version}.tgz`);
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail('package info is missing a valid sha256 digest');
  return { file, version, sha256 };
}

/** Re-hash the tarball and confirm it matches the verified package info. */
export async function verifyTarball({ info, artifactsDir, expectedName = PACKAGE_NAME }) {
  const resolved = resolvePackageInfo(info, expectedName);
  const tarballPath = path.join(artifactsDir, resolved.file);
  let bytes;
  try {
    bytes = await readFile(tarballPath);
  } catch (error) {
    fail(`cannot read ${tarballPath}: ${error.message}`);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== resolved.sha256) fail(`checksum mismatch for ${resolved.file}`);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  return { ...resolved, sha512, tarballPath };
}

/* -------------------------------------------------------------- registry */

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response || typeof response.status !== 'number') fail(`invalid registry response for ${url}`);
  if (response.status !== 200) fail(`registry request to ${url} returned HTTP ${response.status}`);
  return await response.json();
}

/**
 * Refuse to publish over an existing version. Only a 404 proves absence;
 * network errors, 401 and 5xx must never be read as "not published".
 */
export async function assertVersionNotPublished(fetchImpl, name, version) {
  const url = `${REGISTRY}${name}/${version}`;
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    fail(`registry pre-check failed for ${name}@${version}: ${error.message}`);
  }
  const status = response?.status;
  if (status === 404) return { exists: false, status };
  if (status === 200) fail(`${name}@${version} is already published on npm; refusing to overwrite or promote it`);
  fail(`registry pre-check for ${name}@${version} returned HTTP ${status}; refusing to continue`);
}

export function buildPublishArgs({ file, channel, artifactsDir = ARTIFACTS_DIR }) {
  return [
    'publish',
    `./${artifactsDir}/${file}`,
    '--access',
    'public',
    '--tag',
    channel,
    '--provenance',
    '--ignore-scripts',
    `--registry=${REGISTRY}`,
  ];
}

/** Publish exactly once; a failing publish is never retried automatically. */
export async function runNpmPublish({ file, channel, artifactsDir = ARTIFACTS_DIR, spawnImpl = spawn, cwd = process.cwd() }) {
  const args = buildPublishArgs({ file, channel, artifactsDir });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(NPM_COMMAND, args, { cwd, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ command: NPM_COMMAND, args, code });
      else reject(new PublishError(`npm publish exited with code ${code}`));
    });
  });
}

/**
 * Confirm the published state: exact version, registry identity, tarball
 * integrity, the dist-tag, and a provenance attestation. Reads are bounded.
 */
export async function verifyPublishedVersion({ fetchImpl, name, version, channel, sha512, attempts = 61, delayMs = 5000, sleep = defaultSleep }) {
  const integrity = `sha512-${sha512}`;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const document = await fetchJson(fetchImpl, `${REGISTRY}${name}/${version}`);
      if (document?.name !== name) fail(`registry document reports the package name ${document?.name}`);
      if (document?.version !== version) fail(`registry document reports the version ${document?.version}`);
      if (document?.dist?.integrity !== integrity) fail(`integrity mismatch: expected ${integrity}, got ${document?.dist?.integrity}`);
      const tags = await fetchJson(fetchImpl, `${REGISTRY}-/package/${name}/dist-tags`);
      if (tags?.[channel] !== version) fail(`dist-tag ${channel} points to ${tags?.[channel]} instead of ${version}`);
      const attestations = await fetchJson(fetchImpl, `${REGISTRY}-/npm/v1/attestations/${name}@${version}`);
      if (!Array.isArray(attestations?.attestations) || attestations.attestations.length === 0) fail('provenance attestation is missing');
      return { integrity, channel, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  fail(`published version verification failed after ${attempts} attempts: ${lastError?.message ?? 'unknown error'}`);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------------- runtime */

export async function main({ env = process.env, cwd = process.cwd(), fetchImpl = fetch, spawnImpl = spawn, run = defaultRun, nodeVersion = process.version, sleep = defaultSleep, log = console.log } = {}) {
  const { tag } = assertTrustedEnvironment(env);
  const versions = await readToolVersions({ run, nodeVersion });
  log(`Node ${versions.nodeVersion}, npm ${versions.npmVersion}`);
  assertToolVersions(versions);
  const infoPath = path.join(cwd, ARTIFACTS_DIR, PACKAGE_INFO_FILE);
  let info;
  try {
    info = JSON.parse(await readFile(infoPath, 'utf8'));
  } catch (error) {
    fail(`cannot read ${infoPath}: ${error.message}`);
  }
  const artifact = await verifyTarball({ info, artifactsDir: path.join(cwd, ARTIFACTS_DIR) });
  if (tag !== `v${artifact.version}`) fail(`tag ${tag} does not match package version ${artifact.version}`);
  const channel = selectDistTag(artifact.version);
  log(`Publishing ${PACKAGE_NAME}@${artifact.version} to the ${channel} tag`);
  await assertVersionNotPublished(fetchImpl, PACKAGE_NAME, artifact.version);
  await runNpmPublish({ file: artifact.file, channel, artifactsDir: ARTIFACTS_DIR, spawnImpl, cwd });
  await verifyPublishedVersion({ fetchImpl, name: PACKAGE_NAME, version: artifact.version, channel, sha512: artifact.sha512, sleep });
  log(`Published ${PACKAGE_NAME}@${artifact.version} (${channel})`);
  return { version: artifact.version, channel };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`npm publish failed: ${error.message}`);
    process.exitCode = 1;
  });
}
