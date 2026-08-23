import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db-unit',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
  },
});

