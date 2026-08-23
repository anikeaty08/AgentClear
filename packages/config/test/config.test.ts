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

  it('keeps chain writes disabled unless every required setting is present', () => {
    expect(loadRuntimeConfig(validEnvironment).chain).toBeUndefined();
    expect(() => loadRuntimeConfig({ ...validEnvironment, CHAIN_RPC_URL: 'http://127.0.0.1:8545' })).toThrow(
      'All required chain settings must be configured together.',
    );
  });

  it('maps a complete local chain configuration without logging or exposing it', () => {
    const config = loadRuntimeConfig({
      ...validEnvironment,
      CHAIN_RPC_URL: 'http://127.0.0.1:8545',
      CHAIN_ID: '31337',
      CHAIN_NAME: 'AgentClear Anvil',
      CHAIN_NATIVE_CURRENCY_SYMBOL: 'A0GI',
      JOB_ESCROW_ADDRESS: `0x${'1'.repeat(40)}`,
      CHAIN_SIGNER_PRIVATE_KEY: `0x${'2'.repeat(64)}`,
      CHAIN_MAX_PER_JOB_BASE_UNITS: '5000000000000000000',
    });

    expect(config.chain).toMatchObject({ chainId: 31_337, confirmations: 1 });
  });

  it('rejects local chain endpoints in production', () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        CHAIN_RPC_URL: 'http://127.0.0.1:8545',
        CHAIN_ID: '16661',
        CHAIN_NAME: 'Unexpected local endpoint',
        CHAIN_NATIVE_CURRENCY_SYMBOL: 'A0GI',
        JOB_ESCROW_ADDRESS: `0x${'1'.repeat(40)}`,
        CHAIN_SIGNER_PRIVATE_KEY: `0x${'2'.repeat(64)}`,
        CHAIN_MAX_PER_JOB_BASE_UNITS: '5000000000000000000',
      }),
    ).toThrow('Local development chain settings are forbidden in production.');
  });
});
