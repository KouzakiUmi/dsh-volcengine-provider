// 额度中间层：Host 定期采集的额度结果先落到这里，Client 只读这份快照。
//
// 设计取舍：
// - 快照是加速层，不是权威数据；文件损坏、版本不符或字段异常都直接丢弃，从空开始重建。
// - 只保存展示所需字段，不保存凭据、CLI 原始输出或请求参数。
// - 写入走「临时文件 + rename」，与状态文件同目录；写失败不影响采集结果的内存可用性。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SNAPSHOT_VERSION = 1;

/** 额度快照允许保存的字段：其余一律丢弃，避免把内部错误对象写进磁盘。 */
const VALUE_FIELDS = ['accountId', 'plan', 'state', 'windows', 'error', 'errorKind', 'planName', 'updatedAt', 'refreshError', 'refreshFailedAt'];

function cleanValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const field of VALUE_FIELDS) {
    if (!Object.hasOwn(value, field) || value[field] === undefined) continue;
    try { out[field] = structuredClone(value[field]); }
    catch { /* 不可序列化的值不写入快照 */ }
  }
  return Object.keys(out).length ? out : undefined;
}

export class QuotaSnapshotStore {
  constructor({ path }) { this.path = path; this.entries = new Map(); this.queue = Promise.resolve(); this.closed = false; }

  /** 读取上次进程留下的快照；任何异常都退回空快照。 */
  async load() {
    if (!this.path) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (!parsed || parsed.version !== SNAPSHOT_VERSION || !parsed.entries || typeof parsed.entries !== 'object') return;
      for (const [key, raw] of Object.entries(parsed.entries)) {
        if (!raw || typeof raw !== 'object' || typeof raw.fingerprint !== 'string' || typeof raw.at !== 'number') continue;
        const value = cleanValue(raw.value);
        if (!value) continue;
        this.entries.set(key, { fingerprint: raw.fingerprint, at: raw.at, value });
      }
    } catch { /* 缺失或损坏都从空开始 */ }
  }

  /** 取一条快照；传 fingerprint 时只有身份一致才返回，避免账号切换后串用旧结果。 */
  get(key, fingerprint) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (fingerprint && entry.fingerprint !== fingerprint) return undefined;
    return entry;
  }

  set(key, fingerprint, value, at = Date.now()) {
    const clean = cleanValue(value);
    if (!clean || typeof fingerprint !== 'string') return;
    this.entries.set(key, { fingerprint, at, value: clean });
    this.save();
  }

  delete(key) {
    if (this.entries.delete(key)) this.save();
  }

  /** 丢弃不再需要的条目（账号删除、套餐停用等）。 */
  prune(isValid) {
    let changed = false;
    for (const key of [...this.entries.keys()]) {
      if (isValid(key)) continue;
      this.entries.delete(key);
      changed = true;
    }
    if (changed) this.save();
  }

  /** 供 RPC 下发的只读视图：key → { at, value }。 */
  map() {
    const out = {};
    for (const [key, entry] of this.entries) out[key] = { at: entry.at, value: structuredClone(entry.value) };
    return out;
  }

  /** 关闭后不再写入；已排队任务仍会完成，调用方可用 whenIdle() 等待。 */
  close() { this.closed = true; return this.queue; }

  /** 等待所有已排队的落盘任务结束（测试与卸载收尾用）。 */
  whenIdle() { return this.queue; }

  /** 串行原子写入；写失败只丢快照，不影响内存结果。 */
  save() {
    const path = this.path;
    if (!path || this.closed) return;
    this.queue = this.queue.then(async () => {
      const entries = {};
      for (const [key, entry] of this.entries) entries[key] = { fingerprint: entry.fingerprint, at: entry.at, value: entry.value };
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temp, JSON.stringify({ version: SNAPSHOT_VERSION, entries }) + '\n', { mode: 0o600 });
        await rename(temp, path);
      } catch {
        await rm(temp, { force: true }).catch(() => {});
      }
    }).catch(() => {});
  }
}
