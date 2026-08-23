import { describe, expect, it } from 'vitest';

import { loadRuntimeConfig } from '../src/index.js';

const validEnvironment = {
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3001',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://agentclear:test@localhost:5432/agentclear',
  API_KEY_PEPPER: 'a'.repeat(32),
  BOOTSTRAP_API_KEY: 'b'.repeat(32),
  BOOTSTRAP_PRINCIPAL_ID: 'operator_test',
};

describe('loadRuntimeConfig', () => {
  it('maps validated environment variables to runtime configuration', () => {
    const config = loadRuntimeConfig(validEnvironment);

    expect(config.api.port).toBe(3001);
    expect(config.auth.bootstrapPrincipalId).toBe('operator_test');
  });

  it('rejects placeholder credentials in production', () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        API_KEY_PEPPER: 'replace-with-a-secure-production-pepper',
      }),
    ).toThrow('Placeholder credentials are forbidden in production.');
  });
});
