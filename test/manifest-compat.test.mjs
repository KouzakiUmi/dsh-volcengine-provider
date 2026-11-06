import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const CORE_PEERS = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-typert-protocol',
];
const CORE_RANGE = '>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0';
const PI_AI_RANGE = '>=1.1.0 <2.0.0';

// 本项目 peer 范围只使用 >=、< 与 ||。这里实现该子集的比较，用于回归
// 断言：声明在 npm 默认 semver 与宿主 includePrerelease 两种判定下都匹配
// 已核验的两个宿主版本；不替代 npm 的完整 semver 实现。
function parse(version) {
  const [core, pre] = String(version).split('-');
  return { tuple: core.split('.').map(Number), pre: pre ?? null };
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a.tuple[i] !== b.tuple[i]) return a.tuple[i] < b.tuple[i] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function comparator(raw) {
  const match = /^(>=|<=|>|<|=)?(.+)$/.exec(raw);
  return { op: match[1] || '=', version: parse(match[2]) };
}

function satisfies(version, range, { includePrerelease = false } = {}) {
  const candidate = parse(version);
  return range.split('||').some(clause => {
    const parts = clause.trim().split(/\s+/).map(comparator);
    // npm semver 默认只允许与集合中同元组预发行比较器匹配的预发行版本。
    if (!includePrerelease && candidate.pre !== null &&
        !parts.some(part => part.version.pre !== null && part.version.tuple.every((n, i) => n === candidate.tuple[i]))) {
      return false;
    }
    return parts.every(part => {
      const cmp = compare(candidate, part.version);
      switch (part.op) {
        case '>=': return cmp >= 0;
        case '>': return cmp > 0;
        case '<': return cmp < 0;
        case '<=': return cmp <= 0;
        default: return cmp === 0;
      }
    });
  });
}

test('五个 Core peer 使用覆盖两个已核验宿主的范围', () => {
  for (const name of CORE_PEERS) assert.equal(manifest.peerDependencies[name], CORE_RANGE, name);
});

test('pi-ai peer 覆盖 1.1.0 与本机 1.5.0', () => {
  assert.equal(manifest.peerDependencies['@earendil-works/pi-ai'], PI_AI_RANGE);
  assert.ok(satisfies('1.1.0', PI_AI_RANGE));
  assert.ok(satisfies('1.5.0', PI_AI_RANGE));
  assert.ok(!satisfies('2.0.0', PI_AI_RANGE));
});

test('Core 范围在 npm 默认 semver 与宿主 includePrerelease 下都匹配已核验版本', () => {
  for (const version of ['0.2.1-rc.4', '0.2.1-rc.5', '0.2.1', '0.2.2-rc.1', '0.2.2', '0.2.9']) {
    for (const opts of [{}, { includePrerelease: true }]) {
      assert.ok(satisfies(version, CORE_RANGE, opts), `${version} ${JSON.stringify(opts)}`);
    }
  }
  assert.ok(!satisfies('0.2.0', CORE_RANGE));
  assert.ok(!satisfies('0.3.0', CORE_RANGE));
});

test('manifest 版本为普通版本，发布到 latest 渠道', () => {
  assert.equal(manifest.version, '0.2.14');
  assert.doesNotMatch(manifest.version, /-/);
});
