import { z } from 'zod';

const optionalEnvironmentValue = <T>(schema: z.ZodType<T>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const runtimeConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().min(1),
    API_KEY_PEPPER: z.string().min(32),
    BOOTSTRAP_API_KEY: z.string().min(32),
    BOOTSTRAP_PRINCIPAL_ID: z.string().min(1).default('local-operator'),
    PROVIDER_BOOTSTRAP_API_KEY: optionalEnvironmentValue(z.string().min(32)),
    PROVIDER_BOOTSTRAP_AGENT_ID: optionalEnvironmentValue(
      z.string().regex(/^erc8004:\d+:\d+$/),
    ),
    CHAIN_RPC_URL: optionalEnvironmentValue(z.url()),
    CHAIN_ID: optionalEnvironmentValue(z.coerce.number().int().positive().safe()),
    CHAIN_NAME: optionalEnvironmentValue(z.string().min(1)),
    CHAIN_NATIVE_CURRENCY_SYMBOL: optionalEnvironmentValue(z.string().min(1).max(12)),
    CHAIN_EXPLORER_URL: optionalEnvironmentValue(z.url()),
    JOB_ESCROW_ADDRESS: optionalEnvironmentValue(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    CHAIN_SIGNER_PRIVATE_KEY: optionalEnvironmentValue(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
    CHAIN_CONFIRMATIONS: optionalEnvironmentValue(z.coerce.number().int().min(1).max(100)),
    CHAIN_MAX_PER_JOB_BASE_UNITS: optionalEnvironmentValue(z.string().regex(/^[1-9]\d*$/)),
    STORAGE_INDEXER_URL: optionalEnvironmentValue(z.url()),
    STORAGE_MAX_PAYLOAD_BYTES: optionalEnvironmentValue(
      z.coerce.number().int().min(1_024).max(1_048_576),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const requiredChainFields = [
      'CHAIN_RPC_URL',
      'CHAIN_ID',
      'CHAIN_NAME',
      'CHAIN_NATIVE_CURRENCY_SYMBOL',
      'JOB_ESCROW_ADDRESS',
      'CHAIN_SIGNER_PRIVATE_KEY',
      'CHAIN_MAX_PER_JOB_BASE_UNITS',
    ] as const;
    const configuredChainFields = requiredChainFields.filter((field) => value[field] !== undefined);
    if (configuredChainFields.length > 0 && configuredChainFields.length !== requiredChainFields.length) {
      for (const field of requiredChainFields) {
        if (value[field] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'All required chain settings must be configured together.',
          });
        }
      }
    }

    if (
      (value.PROVIDER_BOOTSTRAP_API_KEY === undefined)
      !== (value.PROVIDER_BOOTSTRAP_AGENT_ID === undefined)
    ) {
      for (const field of ['PROVIDER_BOOTSTRAP_API_KEY', 'PROVIDER_BOOTSTRAP_AGENT_ID'] as const) {
        if (value[field] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Provider bootstrap key and agent ID must be configured together.',
          });
        }
      }
    }
    if (value.PROVIDER_BOOTSTRAP_API_KEY === value.BOOTSTRAP_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['PROVIDER_BOOTSTRAP_API_KEY'],
        message: 'Operator and provider bootstrap keys must be distinct.',
      });
    }
    if (value.STORAGE_INDEXER_URL !== undefined && configuredChainFields.length !== requiredChainFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['STORAGE_INDEXER_URL'],
        message: '0G Storage requires the complete chain signer configuration.',
      });
    }

    if (value.NODE_ENV !== 'production') {
      return;
    }

    const forbiddenFragments = ['replace-with', 'change-me', 'local-only'];
    for (const [field, secret] of [
      ['API_KEY_PEPPER', value.API_KEY_PEPPER],
      ['BOOTSTRAP_API_KEY', value.BOOTSTRAP_API_KEY],
      ...(value.PROVIDER_BOOTSTRAP_API_KEY === undefined
        ? []
        : [['PROVIDER_BOOTSTRAP_API_KEY', value.PROVIDER_BOOTSTRAP_API_KEY] as const]),
    ] as const) {
      if (forbiddenFragments.some((fragment) => secret.toLowerCase().includes(fragment))) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Placeholder credentials are forbidden in production.',
        });
      }
    }

    const chainHostname =
      value.CHAIN_RPC_URL === undefined ? undefined : new URL(value.CHAIN_RPC_URL).hostname;
    if (
      value.CHAIN_ID === 31_337
      || chainHostname === 'localhost'
      || chainHostname === '127.0.0.1'
      || chainHostname === '[::1]'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['CHAIN_RPC_URL'],
        message: 'Local development chain settings are forbidden in production.',
      });
    }
    const storageHostname =
      value.STORAGE_INDEXER_URL === undefined
        ? undefined
        : new URL(value.STORAGE_INDEXER_URL).hostname;
    if (
      storageHostname === 'localhost'
      || storageHostname === '127.0.0.1'
      || storageHostname === '[::1]'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['STORAGE_INDEXER_URL'],
        message: 'Local development storage settings are forbidden in production.',
      });
    }
  });

export type RuntimeConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  api: {
    host: string;
    port: number;
    logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  };
  databaseUrl: string;
  auth: {
    apiKeyPepper: string;
    bootstrapApiKey: string;
    bootstrapPrincipalId: string;
    providerBootstrap?: {
      apiKey: string;
      agentId: string;
    };
  };
  chain?: {
    rpcUrl: string;
    chainId: number;
    name: string;
    nativeCurrencySymbol: string;
    explorerUrl?: string;
    escrowAddress: `0x${string}`;
    signerPrivateKey: `0x${string}`;
    confirmations: number;
    maxPerJobBaseUnits: string;
  };
  storage?: {
    rpcUrl: string;
    indexerUrl: string;
    signerPrivateKey: `0x${string}`;
    maxPayloadBytes: number;
  };
};

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = runtimeConfigSchema.parse({
    NODE_ENV: environment['NODE_ENV'],
    API_HOST: environment['API_HOST'],
    API_PORT: environment['API_PORT'],
    LOG_LEVEL: environment['LOG_LEVEL'],
    DATABASE_URL: environment['DATABASE_URL'],
    API_KEY_PEPPER: environment['API_KEY_PEPPER'],
    BOOTSTRAP_API_KEY: environment['BOOTSTRAP_API_KEY'],
    BOOTSTRAP_PRINCIPAL_ID: environment['BOOTSTRAP_PRINCIPAL_ID'],
    PROVIDER_BOOTSTRAP_API_KEY: environment['PROVIDER_BOOTSTRAP_API_KEY'],
    PROVIDER_BOOTSTRAP_AGENT_ID: environment['PROVIDER_BOOTSTRAP_AGENT_ID'],
    CHAIN_RPC_URL: environment['CHAIN_RPC_URL'],
    CHAIN_ID: environment['CHAIN_ID'],
    CHAIN_NAME: environment['CHAIN_NAME'],
    CHAIN_NATIVE_CURRENCY_SYMBOL: environment['CHAIN_NATIVE_CURRENCY_SYMBOL'],
    CHAIN_EXPLORER_URL: environment['CHAIN_EXPLORER_URL'],
    JOB_ESCROW_ADDRESS: environment['JOB_ESCROW_ADDRESS'],
    CHAIN_SIGNER_PRIVATE_KEY: environment['CHAIN_SIGNER_PRIVATE_KEY'],
    CHAIN_CONFIRMATIONS: environment['CHAIN_CONFIRMATIONS'],
    CHAIN_MAX_PER_JOB_BASE_UNITS: environment['CHAIN_MAX_PER_JOB_BASE_UNITS'],
    STORAGE_INDEXER_URL: environment['STORAGE_INDEXER_URL'],
    STORAGE_MAX_PAYLOAD_BYTES: environment['STORAGE_MAX_PAYLOAD_BYTES'],
  });

  const chain =
    parsed.CHAIN_RPC_URL === undefined
      ? undefined
      : {
          rpcUrl: parsed.CHAIN_RPC_URL,
          chainId: parsed.CHAIN_ID!,
          name: parsed.CHAIN_NAME!,
          nativeCurrencySymbol: parsed.CHAIN_NATIVE_CURRENCY_SYMBOL!,
          ...(parsed.CHAIN_EXPLORER_URL === undefined
            ? {}
            : { explorerUrl: parsed.CHAIN_EXPLORER_URL }),
          escrowAddress: parsed.JOB_ESCROW_ADDRESS! as `0x${string}`,
          signerPrivateKey: parsed.CHAIN_SIGNER_PRIVATE_KEY! as `0x${string}`,
          confirmations: parsed.CHAIN_CONFIRMATIONS ?? 1,
          maxPerJobBaseUnits: parsed.CHAIN_MAX_PER_JOB_BASE_UNITS!,
        };
  const providerBootstrap =
    parsed.PROVIDER_BOOTSTRAP_API_KEY === undefined
      ? undefined
      : {
          apiKey: parsed.PROVIDER_BOOTSTRAP_API_KEY,
          agentId: parsed.PROVIDER_BOOTSTRAP_AGENT_ID!,
        };
  const storage =
    parsed.STORAGE_INDEXER_URL === undefined || chain === undefined
      ? undefined
      : {
          rpcUrl: chain.rpcUrl,
          indexerUrl: parsed.STORAGE_INDEXER_URL,
          signerPrivateKey: chain.signerPrivateKey,
          maxPayloadBytes: parsed.STORAGE_MAX_PAYLOAD_BYTES ?? 262_144,
        };

  return {
    nodeEnv: parsed.NODE_ENV,
    api: {
      host: parsed.API_HOST,
      port: parsed.API_PORT,
      logLevel: parsed.LOG_LEVEL,
    },
    databaseUrl: parsed.DATABASE_URL,
    auth: {
      apiKeyPepper: parsed.API_KEY_PEPPER,
      bootstrapApiKey: parsed.BOOTSTRAP_API_KEY,
      bootstrapPrincipalId: parsed.BOOTSTRAP_PRINCIPAL_ID,
      ...(providerBootstrap === undefined ? {} : { providerBootstrap }),
    },
    ...(chain === undefined ? {} : { chain }),
    ...(storage === undefined ? {} : { storage }),
  };
}
