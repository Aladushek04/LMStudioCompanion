import { expect, it } from 'vitest';
import { buildSteps } from '../../scripts/lib/verify-steps.mjs';

const labels = full => buildSteps({ root: 'C:/repo', node: 'node', full }).map(([label]) => label);

it('always includes every required gate', () => {
  expect(labels(false)).toEqual([
    'Node',
    'TypeScript (root)',
    'TypeScript (Core)',
    'Unit tests',
    'Core tests',
    'Import boundaries',
    'Style (Biome)',
    'Build',
  ]);
});

it('adds Python and panel E2E only in full mode', () => {
  expect(labels(true).slice(-2)).toEqual(['Python checks', 'Panel E2E']);
});
