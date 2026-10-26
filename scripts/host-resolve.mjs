import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_TEST_HOST_ROOT;
if (!root) throw new Error('Set DSH_TEST_HOST_ROOT to the target host dsh directory');
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, { ...context, parentURL: pathToFileURL(`${root}/package.json`).href });
  return nextResolve(specifier, context);
} });
