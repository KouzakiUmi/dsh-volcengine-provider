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

/**
 * 逐模型关闭工具调用时，服务端只接受 tools 非空搭配 tool_choice:none。
 * 没有工具声明时不发送 tool_choice，工具声明与历史保持原样。
 */
function withToolChoice(payload, toolsEnabled) {
  if (toolsEnabled !== false) return payload;
  const result = { ...payload };
  if (Array.isArray(result.tools) && result.tools.length) result.tool_choice = { type: 'none' };
  else delete result.tool_choice;
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
    return withToolChoice(result, control.toolsEnabled);
  }
  const mappedOff = effort === 'off' && typeof control.offWire === 'string';
  if (effort === 'off' && !mappedOff) {
    if (control.canDisableThinking === false) {
      const error = new Error('该模型不支持关闭思考');
      error.code = 'UNSUPPORTED_REASONING_EFFORT';
      throw error;
    }
    return withToolChoice({ ...withoutEffort(payload), thinking: { type: 'disabled' } }, control.toolsEnabled);
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
  return withToolChoice(result, control.toolsEnabled);
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
