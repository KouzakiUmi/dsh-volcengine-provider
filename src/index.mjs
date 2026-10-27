import { join } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { LlmAdapter, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ArkController } from './manager.mjs';
import { ROUTES, PLANS } from './state.mjs';
import { profilesFor, getModelRows } from './catalog.mjs';
import { arkRemote } from './remote.mjs';
import { captureModelDefaults, getModelDefaults, applyModelDefaults, describeModelDefaults } from './model-defaults.mjs';
import { createAdapterLease, leasedStream } from './adapter-lease.mjs';
import { createArkAdapter } from './ark-adapter.mjs';

export const name = 'dsh-volcengine-provider';
export const inject = ['llm'];
export const Config = z.object({
  statePath: z.string().description('账号元数据文件（不存密钥）；默认使用用户目录').default(''),
  arkCliPath: z.string().description('可选：官方 ArkCli 原生可执行文件绝对路径').default('')
});
export function apply(ctx, config) {
  const root = config.statePath || join(homedir(), '.dsh', 'dsh-volcengine-provider', 'state.json');
  const controller = new ArkController({ statePath: root, arkCliPath: config.arkCliPath, resolveRef: async ref => {
    const credentials = ctx.get('credentials');
    const value = credentials ? (await credentials.resolve(credentialRef(ref)))?.value : launchEnvironmentOf(ctx).get(ref)?.value;
    return typeof value === 'string' && value.length ? value : undefined;
  } });
  let registration, currentGeneration;
  const generations = new Set();
  const finalizers = new FinalizationRegistry(release => {
    void release().catch(() => ctx.logger.error('旧模型适配器清理失败'));
  });
  function generation() {
    if (!currentGeneration?.adapter || currentGeneration.lease.closed) throw new Error('模型路由未启用');
    return currentGeneration;
  }
  function requestOptions(options, defaults) {
    return {
      ...applyModelDefaults(options, defaults),
      signal: options.signal ? AbortSignal.any([options.signal, controller.life.signal]) : controller.life.signal
    };
  }
  async function withGeneration(operation) {
    const held = generation();
    const release = held.lease.retain();
    try { return await operation(held); } finally { await release(); }
  }
  // Each prepared call retains its adapter scope and defaults until consumption or collection.
  class ManagedAdapter extends LlmAdapter {
    providerInfo(provider) { return generation().adapter.providerInfo(provider); }
    providerRetryPolicy(provider) { return generation().adapter.providerRetryPolicy(provider); }
    imageRequestPricing(provider, model) { return generation().adapter.imageRequestPricing(provider, model); }
    imageRequestTarget(provider, model, image) { return generation().adapter.imageRequestTarget(provider, model, image); }
    listModels(provider) { return withGeneration(held => held.adapter.listModels(provider)); }
    resolveModel(provider, model, signal) {
      return withGeneration(async held => describeModelDefaults(await held.adapter.resolveModel(provider, model, signal), getModelDefaults(held.defaults, provider, model)));
    }
    async prepareCall(provider, model, signal) {
      const held = generation();
      const release = held.lease.retain();
      try {
        const defaults = getModelDefaults(held.defaults, provider, model);
        const prepared = await held.adapter.prepareCall(provider, model, signal);
        const token = {};
        let consumed = false;
        const wrapped = {
          ...prepared,
          model: describeModelDefaults(prepared.model, defaults),
          stream: options => {
            if (consumed) throw new Error('已准备的模型请求只能使用一次');
            consumed = true;
            finalizers.unregister(token);
            return leasedStream(() => prepared.stream(requestOptions(options, defaults)), held.lease, release, finalizers);
          }
        };
        finalizers.register(wrapped, release, token);
        return wrapped;
      } catch (error) { await release(); throw error; }
    }
    stream(options) {
      const held = generation();
      const defaults = getModelDefaults(held.defaults, options.provider, options.model);
      return leasedStream(() => held.adapter.stream(requestOptions(options, defaults)), held.lease, undefined, finalizers);
    }
  }
  const managedAdapter = new ManagedAdapter();
  async function refreshAdapters() {
    if (controller.disposed) return;
    const state = structuredClone(controller.store.current);
    const providers = profilesFor(state);
    const nextDefaults = captureModelDefaults(state);
    const routes = Object.keys(providers);
    const factsByProvider = new Map(PLANS.filter(plan => providers[ROUTES[plan]]).map(plan => [
      ROUTES[plan], new Map(getModelRows(state, state.active[plan], plan).map(row => [row.id, row]))
    ]));
    const previous = currentGeneration;
    let nextGeneration, nextAdapter;
    try {
      nextAdapter = await createArkAdapter({ LlmAdapter, LlmError, PiAiAdapter, InMemoryCredentialStore, anthropicMessagesApi, resolveRetryPolicy }, {
        providers, factsByProvider,
        resolveApiKey: async provider => {
          const plan = PLANS.find(value => ROUTES[value] === provider);
          const owner = plan && state.accounts.find(account => account.id === state.active[plan]);
          return owner ? controller.inferenceKey(owner, plan, { binding: state.oauth[owner.id] }) : undefined;
        },
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref)
      });
      if (controller.disposed) { await nextAdapter.dispose(); return; }
      nextGeneration = { adapter: nextAdapter, defaults: nextDefaults };
      nextGeneration.lease = createAdapterLease(async () => {
        try { await nextAdapter.dispose(); } finally { generations.delete(nextGeneration); }
      }, () => ctx.logger.error('旧模型适配器清理失败'));
      generations.add(nextGeneration);
      currentGeneration = nextGeneration;
      try {
        if (registration) registration.replace(routes);
        else if (routes.length) registration = ctx.llm.registerAdapter(routes, managedAdapter);
      } catch (error) { currentGeneration = previous; throw error; }
      controller.appliedAccounts = Object.fromEntries(PLANS.map(plan => {
        const owner = state.accounts.find(a => a.id === state.active[plan]);
        const identity = owner && state.oauth[owner.id]?.identity;
        return [plan, owner && routes.includes(ROUTES[plan])
          ? { id: owner.id, displayName: identity?.name || (identity?.accountId ? `方舟账号 ${identity.accountId}` : owner.label) }
          : null];
      }));
      controller.routingError = undefined;
    } catch {
      if (nextGeneration) await nextGeneration.lease.dispose(); else await nextAdapter?.dispose();
      controller.routingError = '模型路由更新失败；已保留此前可用路由。请检查路由冲突、模型缓存或 Core 兼容性后重试。';
      throw new Error(controller.routingError);
    }
    if (previous) await previous.lease.retire().catch(() => ctx.logger.error('旧模型适配器清理失败'));
  }
  let routingQueue = Promise.resolve();
  const queueRoutingUpdate = () => {
    const operation = routingQueue.then(refreshAdapters).catch(error => {
      controller.routingError ??= '模型缓存或路由校验失败；已保留此前可用路由，请重新拉取模型后重试。';
      throw error;
    });
    routingQueue = operation.catch(() => {});
    return operation;
  };
  controller.onChange = queueRoutingUpdate;
  class ArkService extends TypertRemoteService {
    constructor(scope) { super(scope, 'volcengineProvider'); }
    async invoke(request) { await controller.ready; return controller.invoke(request); }
  }
  ctx.inject(['typert'], scope => scope.effect(() => scope.typert.register({ package: arkRemote.package, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: arkRemote.descriptors })));
  ctx.plugin(ArkService);
  ctx.on('credentials/reference-updated', () => controller.clearCaches());
  controller.ready = controller.store.load().then(queueRoutingUpdate).catch(() => {
    controller.routingError ??= '初始化失败：请检查账号元数据和模型缓存；原文件未覆盖。';
    ctx.logger.error('火山方舟 Provider 初始化失败；请在设置页查看状态');
  });
  ctx.on('dispose', async () => {
    controller.dispose();
    if (registration) registration();
    const results = await Promise.allSettled([...generations].map(held => held.lease.dispose()));
    if (results.some(result => result.status === 'rejected')) ctx.logger.error('模型适配器卸载失败');
  });
}
