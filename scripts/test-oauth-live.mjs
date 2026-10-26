// Opt-in real OAuth acceptance. Uses only task-owned temporary identity/state;
// never installs a plugin, changes active production accounts or invokes models.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ArkController } from '../lib/manager.mjs';
import { authorizeInBrowser } from '../lib/oauth-browser.mjs';

if (!process.argv.includes('--confirm-real-login')) throw new Error('Real login requires --confirm-real-login and explicit user consent');
const workspace = process.cwd();
const root = await mkdtemp(resolve('.oauth-live-acceptance-'));
const browserTasks = new Set(), childTasks = new Set();
const controller = new ArkController({
  statePath: join(root, 'state.json'), resolveRef: async () => undefined,
  spawnImpl: (...args) => {
    const child = spawn(...args);
    const closed = new Promise(resolveClose => child.once('close', resolveClose));
    childTasks.add(closed); void closed.then(() => childTasks.delete(closed));
    return child;
  },
  browserAuthorize: (url, signal) => {
    const task = authorizeInBrowser(url, signal); browserTasks.add(task);
    void task.then(() => browserTasks.delete(task), () => browserTasks.delete(task));
    return task;
  }
});
try {
  await controller.store.load();
  const view = await controller.read();
  await controller.invoke({ op: 'startLogin', accountId: 'default', revision: view.revision });
  let previous;
  for (;;) {
    const status = controller.oauth.status();
    if (status.state !== previous) { console.log(`OAuth acceptance stage: ${status.state}`); previous = status.state; }
    if (status.state === 'success') {
      const binding = controller.store.current.oauth.default;
      assert.ok(binding?.homeId); assert.ok(binding.identity);
      assert.ok(Object.keys(binding.profiles).length > 0);
      console.log(JSON.stringify({ result: 'PASS', officialCallbackCompleted: true, cliLoginCompleted: true, identityVerified: true, isolatedBindingPersisted: true, personalPlanTypes: Object.keys(binding.profiles) }));
      break;
    }
    if (['error', 'cancelled'].includes(status.state)) throw new Error(status.message);
    await delay(250);
  }
} catch {
  console.error('FAIL: real OAuth acceptance did not complete; no production account changed. Raw driver/CLI output and identity are hidden.');
  console.error('Safe terminal status:', controller.oauth.status().message);
  process.exitCode = 1;
} finally {
  controller.dispose();
  await Promise.allSettled([...browserTasks, ...childTasks]);
  await controller.oauth.current?.done;
  if (dirname(root) !== workspace || !basename(root).startsWith('.oauth-live-acceptance-')) throw new Error('Unexpected cleanup target');
  await rm(root, { recursive: true, force: true });
  console.log('Temporary OAuth identity, pending session and metadata cleaned.');
}
