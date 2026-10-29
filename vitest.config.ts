import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/foundation/**/*.test.ts', 'tests/web/**/*.test.ts'], testTimeout: 5000 },
});
