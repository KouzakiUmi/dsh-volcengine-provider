import { join } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ArkController } from './manager.mjs';
import { ROUTES, PLANS } from './state.mjs';
import { profilesFor } from './catalog.mjs';
import { arkRemote } from './remote.mjs';
import { captureModelDefaults, getModelDefaults, applyModelDefaults, describeModelDefaults } from './model-defaults.mjs';
import { createAdapterLease, leasedStream } from './adapter-lease.mjs';

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
    const staged = { adapter: undefined, routes: [], released: false };
    class AccountCredentials extends CredentialProvider {
      async resolve(ref) {
        const plan = PLANS.find(p => `ARK_PROVIDER_${p === 'agent-plan' ? 'AGENT' : 'CODING'}` === ref);
        if (plan) {
          const owner = state.accounts.find(a => a.id === state.active[plan]);
          const value = owner ? await controller.inferenceKey(owner, plan, { binding: state.oauth[owner.id] }) : undefined;
          return value ? { value, source: 'dsh-volcengine-provider' } : undefined;
        }
        const value = await controller.resolveRef(ref);
        return value ? { value, source: 'inherited' } : undefined;
      }
      async listRecords() { return []; }
      async readRecord() { return undefined; }
      async modifyRecord() { throw new Error('请通过火山方舟 Provider 的网页登录管理账号'); }
      async describe(ref) { return { configured: Boolean(await this.resolve(ref)) }; }
    }
    for (const plan of PLANS) if (providers[ROUTES[plan]]) providers[ROUTES[plan]].apiKeyEnv = `ARK_PROVIDER_${plan === 'agent-plan' ? 'AGENT' : 'CODING'}`;
    // Stage only the public transport. Generic pi-ai settings/discovery belong to the host's
    // existing instance; this plugin has a separate account/model management UI.
    class StagingRegistry extends Service {
      constructor(scope) { super(scope, 'llm'); }
      registerAdapter(routes, adapter) {
        staged.adapter = adapter; staged.routes = [...routes];
        const release = () => { staged.released = true; };
        release.replace = next => { staged.routes = [...next]; };
        this.ctx.effect(() => release);
        return release;
      }
      registerConfigurableProviders() {
        const release = () => {};
        release.replace = () => {};
        return release;
      }
      registerModelDiscovery() { return () => {}; }
    }
    const isolated = ctx.isolate('credentials').isolate('llm');
    const nextFork = isolated.plugin({
      name: 'dsh-volcengine-provider-routing',
      async apply(child) {
        await child.plugin(AccountCredentials);
        await child.plugin(StagingRegistry);
        await child.inject(['credentials', 'llm'], async scope => { await scope.plugin(piAi, { providers }); });
      }
    });
    const previous = currentGeneration;
    let nextGeneration;
    try {
      await nextFork;
      if (controller.disposed) { await nextFork.dispose(); return; }
      if (Object.keys(providers).length && (!staged.adapter || staged.released)) throw new Error('Core 适配器未完成校验');
      nextGeneration = { adapter: staged.adapter, defaults: nextDefaults };
      nextGeneration.lease = createAdapterLease(async () => {
        try { await nextFork.dispose(); } finally { generations.delete(nextGeneration); }
      }, () => ctx.logger.error('旧模型适配器清理失败'));
      generations.add(nextGeneration);
      currentGeneration = nextGeneration;
      try {
        if (registration) registration.replace(staged.routes);
        else if (staged.routes.length) registration = ctx.llm.registerAdapter(staged.routes, managedAdapter);
      } catch (error) { currentGeneration = previous; throw error; }
      controller.routingError = undefined;
    } catch {
      if (nextGeneration) await nextGeneration.lease.dispose(); else await nextFork.dispose();
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
