import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'storage-integration',
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
