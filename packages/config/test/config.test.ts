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
      OUTCOME_REGISTRY_ADDRESS: `0x${'3'.repeat(40)}`,
      CHAIN_SIGNER_PRIVATE_KEY: `0x${'2'.repeat(64)}`,
      CHAIN_MAX_PER_JOB_BASE_UNITS: '5000000000000000000',
    });

    expect(config.chain).toMatchObject({
      chainId: 31_337,
      confirmations: 1,
      outcomeRegistryAddress: `0x${'3'.repeat(40)}`,
    });
  });

  it('does not enable outcome settlement from an address without complete signer settings', () => {
    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      OUTCOME_REGISTRY_ADDRESS: `0x${'3'.repeat(40)}`,
    })).toThrow('Outcome settlement requires the complete chain signer configuration.');
  });

  it('maps ERC-8004 registries only when both addresses and the signer are configured', () => {
    const config = loadRuntimeConfig({
      ...validEnvironment,
      CHAIN_RPC_URL: 'http://127.0.0.1:8545',
      CHAIN_ID: '31337',
      CHAIN_NAME: 'AgentClear Anvil',
      CHAIN_NATIVE_CURRENCY_SYMBOL: 'A0GI',
      JOB_ESCROW_ADDRESS: `0x${'1'.repeat(40)}`,
      CHAIN_SIGNER_PRIVATE_KEY: `0x${'2'.repeat(64)}`,
      CHAIN_MAX_PER_JOB_BASE_UNITS: '5000000000000000000',
      ERC8004_IDENTITY_REGISTRY_ADDRESS: `0x${'3'.repeat(40)}`,
      ERC8004_REPUTATION_REGISTRY_ADDRESS: `0x${'4'.repeat(40)}`,
    });

    expect(config.chain?.erc8004).toEqual({
      identityRegistryAddress: `0x${'3'.repeat(40)}`,
      reputationRegistryAddress: `0x${'4'.repeat(40)}`,
    });
  });

  it('rejects partial ERC-8004 registry configuration', () => {
    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      ERC8004_IDENTITY_REGISTRY_ADDRESS: `0x${'3'.repeat(40)}`,
    })).toThrow('ERC-8004 identity and reputation registry addresses must be configured together.');
  });

  it('rejects ERC-8004 registries without the complete signer configuration', () => {
    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      ERC8004_IDENTITY_REGISTRY_ADDRESS: `0x${'3'.repeat(40)}`,
      ERC8004_REPUTATION_REGISTRY_ADDRESS: `0x${'4'.repeat(40)}`,
    })).toThrow('ERC-8004 reputation requires the complete chain signer configuration.');
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

  it('requires a complete, distinct provider bootstrap credential pair', () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment,
        PROVIDER_BOOTSTRAP_API_KEY: 'c'.repeat(32),
      }),
    ).toThrow('Provider bootstrap key and agent ID must be configured together.');
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment,
        PROVIDER_BOOTSTRAP_API_KEY: validEnvironment.BOOTSTRAP_API_KEY,
        PROVIDER_BOOTSTRAP_AGENT_ID: 'erc8004:16602:456',
      }),
    ).toThrow('Operator and provider bootstrap keys must be distinct.');
  });

  it('derives 0G Storage signer settings only from a complete chain configuration', () => {
    expect(() =>
      loadRuntimeConfig({
        ...validEnvironment,
        STORAGE_INDEXER_URL: 'https://indexer-storage-testnet-turbo.0g.ai',
      }),
    ).toThrow('0G Storage requires the complete chain signer configuration.');

    const config = loadRuntimeConfig({
      ...validEnvironment,
      CHAIN_RPC_URL: 'http://127.0.0.1:8545',
      CHAIN_ID: '31337',
      CHAIN_NAME: 'AgentClear Anvil',
      CHAIN_NATIVE_CURRENCY_SYMBOL: 'A0GI',
      JOB_ESCROW_ADDRESS: `0x${'1'.repeat(40)}`,
      CHAIN_SIGNER_PRIVATE_KEY: `0x${'2'.repeat(64)}`,
      CHAIN_MAX_PER_JOB_BASE_UNITS: '5000000000000000000',
      STORAGE_INDEXER_URL: 'http://127.0.0.1:5678',
      STORAGE_MAX_PAYLOAD_BYTES: '8192',
    });

    expect(config.storage).toMatchObject({
      rpcUrl: 'http://127.0.0.1:8545',
      indexerUrl: 'http://127.0.0.1:5678',
      maxPayloadBytes: 8_192,
    });
  });
});
