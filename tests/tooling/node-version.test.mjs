import { expect, it } from 'vitest';
import { isSupportedNode, supportedNodeMessage } from '../../scripts/lib/node-version.mjs';

it('accepts the two verified majors', () => {
  expect(isSupportedNode('v24.22.2')).toBe(true);
  expect(isSupportedNode('v25.5.0')).toBe(true);
});

it('rejects Node 22 and 26', () => {
  expect(isSupportedNode('v22.21.1')).toBe(false);
  expect(isSupportedNode('v26.13.0')).toBe(false);
});

it('explains the supported runtime', () => {
  expect(supportedNodeMessage('v26.13.0')).toContain('24.22.2');
  expect(supportedNodeMessage('v26.13.0')).toContain('.nvmrc');
});
