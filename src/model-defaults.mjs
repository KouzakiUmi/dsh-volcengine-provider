import { PLANS, ROUTES } from './state.mjs';
import { getModelRows } from './catalog.mjs';

const keyFor = (provider, model) => `${provider}\0${model}`;

/** Capture only defaults owned by the currently selected account and route. */
export function captureModelDefaults(state) {
  const defaults = new Map();
  for (const plan of PLANS) {
    if (state.enabled?.[plan] === false) continue;
    const accountId = state.active[plan];
    if (!state.accounts.some(account => account.id === accountId)) continue;
    for (const row of getModelRows(state, accountId, plan)) {
      if (!row.enabled) continue;
      const value = {};
      if (row.effective.temperature !== undefined) value.temperature = row.effective.temperature;
      if (row.effective.defaultReasoning != null) value.reasoningEffort = row.effective.defaultReasoning;
      defaults.set(keyFor(ROUTES[plan], row.id), Object.freeze(value));
    }
  }
  return defaults;
}

export function getModelDefaults(defaults, provider, model) {
  return defaults.get(keyFor(provider, model));
}

/** Explicit call controls always win over saved model defaults. */
export function applyModelDefaults(options, defaults = {}) {
  const patch = {};
  for (const field of ['temperature', 'reasoningEffort']) {
    if (options[field] === undefined && defaults[field] !== undefined) patch[field] = defaults[field];
  }
  return Object.keys(patch).length ? { ...options, ...patch } : options;
}

/** Expose the same default effort that will be applied at dispatch. */
export function describeModelDefaults(info, defaults = {}) {
  if (!info.reasoning) {
    if (defaults.reasoningEffort !== undefined) throw new Error('非思考模型不能配置默认思考档位');
    return info;
  }
  const { defaultEffort: _previousDefault, ...reasoning } = info.reasoning;
  const effort = defaults.reasoningEffort;
  if (effort !== undefined && !reasoning.efforts.some(item => item.id === effort)) throw new Error('默认思考档位与模型能力不匹配');
  return { ...info, reasoning: { ...reasoning, ...(effort === undefined ? {} : { defaultEffort: effort }) } };
}
