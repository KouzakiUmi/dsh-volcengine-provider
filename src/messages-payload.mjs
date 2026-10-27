const thinkingModes = new Set(['enabled', 'adaptive', 'server-default']);

function withoutEffort(payload) {
  const result = { ...payload };
  if (payload.output_config && typeof payload.output_config === 'object') {
    const { effort: _effort, ...rest } = payload.output_config;
    if (Object.keys(rest).length) result.output_config = rest;
    else delete result.output_config;
  }
  return result;
}

/** Normalize only request-level controls; replay blocks and signatures stay SDK-owned. */
export function messagesPayload(payload, control = {}) {
  const mode = control.messagesThinkingMode ?? 'server-default';
  if (!thinkingModes.has(mode)) throw new TypeError('方舟思考模式配置无效');
  const effort = control.reasoningEffort;
  if (effort === undefined || effort === null) {
    const result = withoutEffort(payload);
    delete result.thinking;
    return result;
  }
  const mappedOff = effort === 'off' && typeof control.offWire === 'string';
  if (effort === 'off' && !mappedOff) {
    if (control.canDisableThinking === false) {
      const error = new Error('该模型不支持关闭思考');
      error.code = 'UNSUPPORTED_REASONING_EFFORT';
      throw error;
    }
    return { ...withoutEffort(payload), thinking: { type: 'disabled' } };
  }
  const result = { ...payload };
  if (mappedOff) result.output_config = { ...payload.output_config, effort: control.offWire };
  const thinking = { ...(payload.thinking ?? {}) };
  delete thinking.display;
  delete thinking.block_binding;
  if (control.forceAdaptiveThinking !== false) {
    delete thinking.budget_tokens;
    if (mode !== 'server-default') thinking.type = mode;
  }
  // A fixed-budget override intentionally keeps the SDK's enabled + budget shape.
  if (Object.keys(thinking).length) result.thinking = thinking;
  else delete result.thinking;
  return result;
}

/** Compose the SDK callback, without replacing fetch globally or serializing history. */
export function messagesStreamOptions(options, control) {
  const upstreamFetch = options?.fetch ?? globalThis.fetch;
  return {
    ...options,
    cacheRetention: 'none',
    ...(typeof upstreamFetch === 'function' ? {
      fetch: (input, init) => upstreamFetch(input, { ...init, redirect: 'error' })
    } : {}),
    onPayload: async (payload, model) => {
      const amended = await options?.onPayload?.(payload, model);
      return messagesPayload(amended ?? payload, control);
    }
  };
}
