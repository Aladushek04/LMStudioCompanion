import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;
const full = process.argv.includes('--full');
const at = (...parts) => resolve(root, ...parts);
const steps = [];

steps.push(['Node', node, [at('scripts/check-node.mjs')]]);
steps.push(['TypeScript (root)', node, [at('node_modules/typescript/bin/tsc'), '--noEmit']]);
steps.push([
  'TypeScript (Core)',
  node,
  [at('node_modules/typescript/bin/tsc'), '-p', 'packages/conversation-engine/tsconfig.json'],
]);
steps.push(['Unit tests', node, [at('node_modules/vitest/vitest.mjs'), 'run']]);
steps.push([
  'Core tests',
  node,
  [
    at('node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'packages/conversation-engine/vitest.config.mts',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ],
]);

if (existsSync(at('scripts/check-boundaries.mjs'))) {
  steps.push(['Import boundaries', node, [at('scripts/check-boundaries.mjs')]]);
}

const biome = at('node_modules/@biomejs/biome/bin/biome');
if (existsSync(biome)) {
  steps.push(['Style (Biome)', node, [biome, 'check', '.']]);
}

steps.push(['Build', node, [at('scripts/build.mjs')]]);

if (full) {
  if (existsSync(at('scripts/verify-python.mjs'))) {
    steps.push(['Python checks', node, [at('scripts/verify-python.mjs')]]);
  }
  steps.push(['Panel E2E', node, [at('scripts/check-panel.mjs')]]);
}

const total = steps.length;
for (let index = 0; index < steps.length; index++) {
  const [label, command, args] = steps[index];
  const prefix = `[${index + 1}/${total}] ${label}`;
  console.log(`${prefix}…`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`${prefix} — FAILED: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${prefix} — FAILED (exit ${result.status ?? 'unknown'})`);
    process.exit(result.status ?? 1);
  }
  console.log(`${prefix} — OK`);
}

console.log(full ? 'VERIFY:FULL PASSED' : 'VERIFY PASSED');
