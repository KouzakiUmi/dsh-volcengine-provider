import { parentPort, workerData } from 'node:worker_threads';
import { authorizeWithChromium } from './oauth-browser.mjs';

const controller = new AbortController();
parentPort.on('message', message => { if (message?.type === 'cancel') controller.abort(); });
try {
  await authorizeWithChromium(workerData.url, controller.signal);
} catch {
  // Never send driver errors, URLs, page content or credentials to host logs.
  process.exitCode = 1;
} finally {
  parentPort.close();
}
