import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/foundation/**/*.test.ts', 'tests/web/**/*.test.ts', 'tests/memory/**/*.test.ts', 'tests/documents/**/*.test.{ts,mjs}'], testTimeout: 5000 },
});
