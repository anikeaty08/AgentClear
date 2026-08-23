import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'chain-integration',
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
