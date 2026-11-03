import { expect, it } from 'vitest';
import { findViolations } from '../../scripts/lib/boundaries.mjs';

const check = (path, source) => findViolations([{ path, source }]);

it('allows host to import memory', () => {
  expect(
    check('packages/host/src/a.ts', "import { openMemoryStore } from '../../memory/src/store.js';"),
  ).toEqual([]);
});

it('rejects host importing the plugin', () => {
  const [violation] = check(
    'packages/host/src/a.ts',
    "import { selectIntegration } from '../../lmstudio-plugin/src/integration.js';",
  );
  expect(violation).toMatchObject({ from: 'host', to: 'lmstudio-plugin' });
});

it('rejects Core importing the plugin', () => {
  const [violation] = check(
    'packages/conversation-engine/src/companion/a.ts',
    "import { memoryRequest } from '../../../lmstudio-plugin/src/memory/client.js';",
  );
  expect(violation).toMatchObject({ from: 'conversation-engine', to: 'lmstudio-plugin' });
});

it('allows panel type-only imports from memory', () => {
  expect(
    check(
      'packages/control-panel/src/a.tsx',
      "import type { MemoryRecord } from '../../memory/src/types.js';",
    ),
  ).toEqual([]);
});

it('allows panel inline type imports from documents', () => {
  expect(
    check(
      'packages/control-panel/src/a.tsx',
      "import { type DocumentItem, type DocumentWorkspace } from '../../documents/src/types.js';",
    ),
  ).toEqual([]);
});

it('rejects panel runtime imports from memory', () => {
  const [violation] = check(
    'packages/control-panel/src/a.tsx',
    "import { openMemoryStore } from '../../memory/src/store.js';",
  );
  expect(violation).toMatchObject({ from: 'control-panel', to: 'memory' });
});

it('rejects core importing memory', () => {
  const [violation] = check(
    'packages/core/src/a.ts',
    "import { openMemoryStore } from '../../memory/src/store.js';",
  );
  expect(violation).toMatchObject({ from: 'core', to: 'memory' });
});
