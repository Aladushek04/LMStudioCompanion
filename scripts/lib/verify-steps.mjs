import { resolve } from 'node:path';

export function buildSteps({ root, node, full }) {
  const at = (...parts) => resolve(root, ...parts);
  const steps = [
    ['Node', node, [at('scripts/check-node.mjs')]],
    ['TypeScript (root)', node, [at('node_modules/typescript/bin/tsc'), '--noEmit']],
    [
      'TypeScript (Core)',
      node,
      [at('node_modules/typescript/bin/tsc'), '-p', 'packages/conversation-engine/tsconfig.json'],
    ],
    ['Unit tests', node, [at('node_modules/vitest/vitest.mjs'), 'run']],
    [
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
    ],
    // Required gates: a missing script or tool must fail the run, never be skipped.
    ['Import boundaries', node, [at('scripts/check-boundaries.mjs')]],
    ['Style (Biome)', node, [at('node_modules/@biomejs/biome/bin/biome'), 'check', '.']],
    ['Build', node, [at('scripts/build.mjs')]],
  ];

  if (full) {
    steps.push(['Python checks', node, [at('scripts/verify-python.mjs')]]);
    steps.push(['Panel E2E', node, [at('scripts/check-panel.mjs')]]);
  }

  return steps;
}
