import { readFile } from 'node:fs/promises';
import { assertPlan, LABELS, ROUTES } from './state.mjs';
export const snapshot = JSON.parse(await readFile(new URL('./catalog-snapshot.json', import.meta.url), 'utf8'));
const modelId = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
export function normalizeCatalog(plan, response) {
  assertPlan(plan);
  if (response?.plan !== plan || !Array.isArray(response.models)) throw new Error('模型目录响应与所选订阅不匹配');
  if (response.models.length > 1000) throw new Error('模型目录过大');
  const seen = new Set();
  const models = response.models.map(row => {
    const id = row.output_name || row.model_id;
    if (typeof id !== 'string' || !modelId.test(id) || seen.has(id)) throw new Error('模型目录包含非法或重复 ID');
    seen.add(id);
    const known = snapshot[plan].models.find(m => m.id === id || m.id === row.model_id);
    return {
      ...(known ? structuredClone(known) : { contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: false, compat: { forceAdaptiveThinking: false } }),
      id, name: typeof row.model_name === 'string' && row.model_name.length <= 200 ? row.model_name : id,
      ...(known ? {} : { capabilityUnverified: true })
    };
  });
  return { models, source: 'arkcli', updatedAt: new Date().toISOString() };
}
export function usableModels(catalog, plan) {
  const rows = catalog === undefined || catalog === null ? snapshot[plan].models : catalog.models;
  if (!Array.isArray(rows)) throw new Error('本地模型缓存格式错误');
  return rows.map(row => {
    if (!modelId.test(row.id)) throw new Error('本地模型缓存包含非法 ID');
    const { capabilityUnverified: _unverified, ...model } = row;
    return model;
  });
}
export function providerProfile(plan, models) {
  const base = snapshot[assertPlan(plan)];
  return { ...base, models, displayName: LABELS[plan] };
}
export function profilesFor(state) {
  const providers = {};
  for (const plan of Object.keys(ROUTES)) {
    const id = state.active[plan];
    const owner = state.accounts.find(a => a.id === id);
    if (!owner) continue;
    const models = usableModels(state.catalogs[`${id}:${plan}`], plan);
    // Credentials are resolved by a host-owned adapter closure, never in this document.
    providers[ROUTES[plan]] = providerProfile(plan, models);
  }
  return providers;
}
