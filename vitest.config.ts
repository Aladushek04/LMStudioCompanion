import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/foundation/**/*.test.ts',
      'tests/web/**/*.test.ts',
      'tests/memory/**/*.test.ts',
      'tests/documents/**/*.test.{ts,mjs}',
      'tests/smoke/**/*.test.ts',
      'tests/tooling/**/*.test.mjs',
    ],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
