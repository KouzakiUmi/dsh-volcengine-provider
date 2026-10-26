import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PLANS = ['agent-plan', 'coding-plan'];
export const ROUTES = { 'agent-plan': 'volcengine-agent-plan', 'coding-plan': 'volcengine-coding-plan' };
export const LABELS = { 'agent-plan': '火山方舟 · Agent 套餐', 'coding-plan': '火山方舟 · 编程套餐' };
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const refPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export function assertPlan(plan) {
  if (!PLANS.includes(plan)) throw new Error('未知订阅类型');
  return plan;
}
export function account(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('账号格式错误');
  const allowed = ['id', 'label', 'apiKeyRefs', 'accessKeyRef', 'secretKeyRef', 'cliProfile'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('只接受凭据引用，不接受密钥');
  if (typeof input.id !== 'string' || !idPattern.test(input.id) || ['constructor', 'prototype', '__proto__'].includes(input.id)) throw new Error('账号 ID 须为小写字母、数字或连字符，且不能使用保留名称');
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80) throw new Error('账号名称不合法');
  const apiKeyRefs = {};
  for (const plan of PLANS) {
    const ref = input.apiKeyRefs?.[plan];
    if (ref !== undefined && (!refPattern.test(ref) || typeof ref !== 'string')) throw new Error('推理凭据引用不合法');
    if (ref) apiKeyRefs[plan] = ref;
  }
  for (const k of ['accessKeyRef', 'secretKeyRef']) if (input[k] !== undefined && (typeof input[k] !== 'string' || (input[k] !== '' && !refPattern.test(input[k])))) throw new Error('AK/SK 凭据引用不合法');
  if (input.cliProfile !== undefined && (typeof input.cliProfile !== 'string' || !/^[\w.-]{1,80}$/.test(input.cliProfile))) throw new Error('ArkCli profile 名称不合法');
  return { id: input.id, label: input.label.trim(), apiKeyRefs, accessKeyRef: input.accessKeyRef ?? '', secretKeyRef: input.secretKeyRef ?? '', ...(input.cliProfile ? { cliProfile: input.cliProfile } : {}) };
}
export function initialState() {
  return {
    version: 1,
    accounts: [account({ id: 'default', label: '现有方舟账号', apiKeyRefs: { 'agent-plan': 'ARKCLI_AGENT_PLAN_API_KEY', 'coding-plan': 'ARKCLI_CODING_PLAN_API_KEY' }, accessKeyRef: 'VOLC_ACCESSKEY', secretKeyRef: 'VOLC_SECRETKEY' })],
    active: { 'agent-plan': 'default', 'coding-plan': 'default' },
    catalogs: {},
    oauth: {}
  };
}
export function validateState(value) {
  if (value?.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 50) throw new Error('账号状态格式不兼容');
  const accounts = value.accounts.map(account);
  if (new Set(accounts.map(a => a.id)).size !== accounts.length) throw new Error('账号 ID 重复');
  const active = {};
  for (const plan of PLANS) {
    const id = value.active?.[plan];
    if (id !== null && !accounts.some(a => a.id === id)) throw new Error('所选账号不存在');
    active[plan] = id;
  }
  // Catalogs are validated at the point of use, never executable configuration.
  const catalogs = value.catalogs && typeof value.catalogs === 'object' && !Array.isArray(value.catalogs) ? value.catalogs : {};
  const oauth = {};
  for (const owner of accounts) {
    const binding = value.oauth?.[owner.id];
    if (!binding) continue;
    const profiles = {};
    for (const plan of PLANS) {
      const profile = binding.profiles?.[plan];
      if (profile !== undefined && (typeof profile !== 'string' || profile.length > 200 || /[\x00-\x1f]/.test(profile))) throw new Error('OAuth profile 绑定格式错误');
      if (profile) profiles[plan] = profile;
    }
    oauth[owner.id] = { profiles, loggedAt: typeof binding.loggedAt === 'string' ? binding.loggedAt : '' };
  }
  return { version: 1, accounts, active, catalogs, oauth };
}
export const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class StateStore {
  constructor(path) { this.path = path; this.current = null; this.queue = Promise.resolve(); }
  async load() {
    try { this.current = validateState(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取方舟账号状态；原文件未被覆盖'); this.current = initialState(); }
    return this.current;
  }
  mutate(expectedRevision, change) {
    const operation = this.queue.then(async () => {
      if (expectedRevision !== revision(this.current)) throw new Error('设置已改变，请刷新后重试');
      const next = validateState(change(structuredClone(this.current)));
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, this.path);
      this.current = next;
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
