import { z } from 'zod';

const optionalEnvironmentValue = <T>(schema: z.ZodType<T>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'Only HTTP(S) URLs are supported.');

const commaSeparatedListSchema = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
  .refine((items) => items.length > 0, 'At least one value is required.');

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
    OUTCOME_REGISTRY_ADDRESS: optionalEnvironmentValue(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    ERC8004_IDENTITY_REGISTRY_ADDRESS: optionalEnvironmentValue(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    ERC8004_REPUTATION_REGISTRY_ADDRESS: optionalEnvironmentValue(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    CHAIN_SIGNER_PRIVATE_KEY: optionalEnvironmentValue(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
    CHAIN_CONFIRMATIONS: optionalEnvironmentValue(z.coerce.number().int().min(1).max(100)),
    CHAIN_MAX_PER_JOB_BASE_UNITS: optionalEnvironmentValue(z.string().regex(/^[1-9]\d*$/)),
    STORAGE_INDEXER_URL: optionalEnvironmentValue(z.url()),
    STORAGE_MAX_PAYLOAD_BYTES: optionalEnvironmentValue(
      z.coerce.number().int().min(1_024).max(1_048_576),
    ),
    COMPUTE_RPC_URL: optionalEnvironmentValue(z.url()),
    COMPUTE_SIGNER_PRIVATE_KEY: optionalEnvironmentValue(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
    COMPUTE_PROVIDER_ADDRESS: optionalEnvironmentValue(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    COMPUTE_MODEL: optionalEnvironmentValue(z.string().trim().min(1).max(300)),
    COMPUTE_TIMEOUT_MS: optionalEnvironmentValue(
      z.coerce.number().int().min(1_000).max(300_000),
    ),
    COMPUTE_MAX_RESPONSE_BYTES: optionalEnvironmentValue(
      z.coerce.number().int().min(1_024).max(4_194_304),
    ),
    COMPUTE_REQUIRE_TEE: optionalEnvironmentValue(
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ),
    SANDBOX_NODE_IMAGE: optionalEnvironmentValue(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[0-9a-f]{64}$/),
    ),
    SANDBOX_CONTAINER_CLI: optionalEnvironmentValue(z.enum(['docker', 'wsl-docker'])),
    SANDBOX_TIMEOUT_MS: optionalEnvironmentValue(
      z.coerce.number().int().min(1_000).max(30_000),
    ),
    SANDBOX_MAX_OUTPUT_BYTES: optionalEnvironmentValue(
      z.coerce.number().int().min(1_024).max(1_048_576),
    ),
    SANDBOX_MAX_FILE_BYTES: optionalEnvironmentValue(
      z.coerce.number().int().min(1_024).max(262_144),
    ),
    SANDBOX_MAX_TOTAL_FILE_BYTES: optionalEnvironmentValue(
      z.coerce.number().int().min(1_024).max(1_048_576),
    ),
    SANDBOX_MEMORY_MB: optionalEnvironmentValue(
      z.coerce.number().int().min(32).max(512),
    ),
    SANDBOX_CPU_LIMIT: optionalEnvironmentValue(
      z.string().regex(/^(?:0\.[1-9]|[1-9]\d*(?:\.\d+)?)$/),
    ),
    SANDBOX_PROCESS_LIMIT: optionalEnvironmentValue(
      z.coerce.number().int().min(1).max(128),
    ),
    SANDBOX_TMPFS_MB: optionalEnvironmentValue(
      z.coerce.number().int().min(1).max(64),
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
    if (value.OUTCOME_REGISTRY_ADDRESS !== undefined && configuredChainFields.length !== requiredChainFields.length) {
      context.addIssue({
        code: 'custom',
        path: ['OUTCOME_REGISTRY_ADDRESS'],
        message: 'Outcome settlement requires the complete chain signer configuration.',
      });
    }
    if (
      (value.ERC8004_IDENTITY_REGISTRY_ADDRESS === undefined)
      !== (value.ERC8004_REPUTATION_REGISTRY_ADDRESS === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ERC8004_REPUTATION_REGISTRY_ADDRESS'],
        message: 'ERC-8004 identity and reputation registry addresses must be configured together.',
      });
    }
    if (
      value.ERC8004_IDENTITY_REGISTRY_ADDRESS !== undefined
      && configuredChainFields.length !== requiredChainFields.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ERC8004_IDENTITY_REGISTRY_ADDRESS'],
        message: 'ERC-8004 reputation requires the complete chain signer configuration.',
      });
    }
    const requiredComputeFields = [
      'COMPUTE_RPC_URL',
      'COMPUTE_SIGNER_PRIVATE_KEY',
      'COMPUTE_PROVIDER_ADDRESS',
    ] as const;
    const configuredComputeFields = requiredComputeFields.filter(
      (field) => value[field] !== undefined,
    );
    if (
      configuredComputeFields.length > 0
      && configuredComputeFields.length !== requiredComputeFields.length
    ) {
      for (const field of requiredComputeFields) {
        if (value[field] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'All required 0G Compute settings must be configured together.',
          });
        }
      }
    }
    if (
      value.COMPUTE_SIGNER_PRIVATE_KEY !== undefined
      && value.COMPUTE_SIGNER_PRIVATE_KEY.toLowerCase()
        === value.CHAIN_SIGNER_PRIVATE_KEY?.toLowerCase()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['COMPUTE_SIGNER_PRIVATE_KEY'],
        message: '0G Compute and protocol chain writers must use separate signer keys.',
      });
    }
    if (
      value.SANDBOX_MAX_FILE_BYTES !== undefined
      && value.SANDBOX_MAX_TOTAL_FILE_BYTES !== undefined
      && value.SANDBOX_MAX_FILE_BYTES > value.SANDBOX_MAX_TOTAL_FILE_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SANDBOX_MAX_TOTAL_FILE_BYTES'],
        message: 'The total sandbox file limit cannot be lower than the per-file limit.',
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
    const computeHostname =
      value.COMPUTE_RPC_URL === undefined ? undefined : new URL(value.COMPUTE_RPC_URL).hostname;
    if (
      computeHostname === 'localhost'
      || computeHostname === '127.0.0.1'
      || computeHostname === '[::1]'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['COMPUTE_RPC_URL'],
        message: 'Local 0G Compute RPC settings are forbidden in production.',
      });
    }
    if (value.SANDBOX_CONTAINER_CLI === 'wsl-docker') {
      context.addIssue({
        code: 'custom',
        path: ['SANDBOX_CONTAINER_CLI'],
        message: 'The WSL Docker bridge is for local development only.',
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
    outcomeRegistryAddress?: `0x${string}`;
    erc8004?: {
      identityRegistryAddress: `0x${string}`;
      reputationRegistryAddress: `0x${string}`;
    };
  };
  storage?: {
    rpcUrl: string;
    indexerUrl: string;
    signerPrivateKey: `0x${string}`;
    maxPayloadBytes: number;
  };
  compute?: {
    rpcUrl: string;
    signerPrivateKey: `0x${string}`;
    providerAddress: `0x${string}`;
    model?: string;
    timeoutMs: number;
    maxResponseBytes: number;
    requireTee: boolean;
  };
  sandbox?: {
    image: string;
    containerCli: 'docker' | 'wsl-docker';
    timeoutMs: number;
    maxOutputBytes: number;
    maxFileBytes: number;
    maxTotalFileBytes: number;
    memoryMb: number;
    cpuLimit: string;
    processLimit: number;
    temporaryFilesystemMb: number;
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
    OUTCOME_REGISTRY_ADDRESS: environment['OUTCOME_REGISTRY_ADDRESS'],
    ERC8004_IDENTITY_REGISTRY_ADDRESS: environment['ERC8004_IDENTITY_REGISTRY_ADDRESS'],
    ERC8004_REPUTATION_REGISTRY_ADDRESS: environment['ERC8004_REPUTATION_REGISTRY_ADDRESS'],
    CHAIN_SIGNER_PRIVATE_KEY: environment['CHAIN_SIGNER_PRIVATE_KEY'],
    CHAIN_CONFIRMATIONS: environment['CHAIN_CONFIRMATIONS'],
    CHAIN_MAX_PER_JOB_BASE_UNITS: environment['CHAIN_MAX_PER_JOB_BASE_UNITS'],
    STORAGE_INDEXER_URL: environment['STORAGE_INDEXER_URL'],
    STORAGE_MAX_PAYLOAD_BYTES: environment['STORAGE_MAX_PAYLOAD_BYTES'],
    COMPUTE_RPC_URL: environment['COMPUTE_RPC_URL'],
    COMPUTE_SIGNER_PRIVATE_KEY: environment['COMPUTE_SIGNER_PRIVATE_KEY'],
    COMPUTE_PROVIDER_ADDRESS: environment['COMPUTE_PROVIDER_ADDRESS'],
    COMPUTE_MODEL: environment['COMPUTE_MODEL'],
    COMPUTE_TIMEOUT_MS: environment['COMPUTE_TIMEOUT_MS'],
    COMPUTE_MAX_RESPONSE_BYTES: environment['COMPUTE_MAX_RESPONSE_BYTES'],
    COMPUTE_REQUIRE_TEE: environment['COMPUTE_REQUIRE_TEE'],
    SANDBOX_NODE_IMAGE: environment['SANDBOX_NODE_IMAGE'],
    SANDBOX_CONTAINER_CLI: environment['SANDBOX_CONTAINER_CLI'],
    SANDBOX_TIMEOUT_MS: environment['SANDBOX_TIMEOUT_MS'],
    SANDBOX_MAX_OUTPUT_BYTES: environment['SANDBOX_MAX_OUTPUT_BYTES'],
    SANDBOX_MAX_FILE_BYTES: environment['SANDBOX_MAX_FILE_BYTES'],
    SANDBOX_MAX_TOTAL_FILE_BYTES: environment['SANDBOX_MAX_TOTAL_FILE_BYTES'],
    SANDBOX_MEMORY_MB: environment['SANDBOX_MEMORY_MB'],
    SANDBOX_CPU_LIMIT: environment['SANDBOX_CPU_LIMIT'],
    SANDBOX_PROCESS_LIMIT: environment['SANDBOX_PROCESS_LIMIT'],
    SANDBOX_TMPFS_MB: environment['SANDBOX_TMPFS_MB'],
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
          ...(parsed.OUTCOME_REGISTRY_ADDRESS === undefined
            ? {}
            : { outcomeRegistryAddress: parsed.OUTCOME_REGISTRY_ADDRESS as `0x${string}` }),
          ...(parsed.ERC8004_IDENTITY_REGISTRY_ADDRESS === undefined
            ? {}
            : {
                erc8004: {
                  identityRegistryAddress: parsed.ERC8004_IDENTITY_REGISTRY_ADDRESS as `0x${string}`,
                  reputationRegistryAddress: parsed.ERC8004_REPUTATION_REGISTRY_ADDRESS as `0x${string}`,
                },
              }),
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
  const compute =
    parsed.COMPUTE_RPC_URL === undefined
      ? undefined
      : {
          rpcUrl: parsed.COMPUTE_RPC_URL,
          signerPrivateKey: parsed.COMPUTE_SIGNER_PRIVATE_KEY! as `0x${string}`,
          providerAddress: parsed.COMPUTE_PROVIDER_ADDRESS! as `0x${string}`,
          ...(parsed.COMPUTE_MODEL === undefined ? {} : { model: parsed.COMPUTE_MODEL }),
          timeoutMs: parsed.COMPUTE_TIMEOUT_MS ?? 120_000,
          maxResponseBytes: parsed.COMPUTE_MAX_RESPONSE_BYTES ?? 1_048_576,
          requireTee: parsed.COMPUTE_REQUIRE_TEE ?? true,
        };
  const sandbox =
    parsed.SANDBOX_NODE_IMAGE === undefined
      ? undefined
      : {
          image: parsed.SANDBOX_NODE_IMAGE,
          containerCli: parsed.SANDBOX_CONTAINER_CLI ?? 'docker',
          timeoutMs: parsed.SANDBOX_TIMEOUT_MS ?? 10_000,
          maxOutputBytes: parsed.SANDBOX_MAX_OUTPUT_BYTES ?? 65_536,
          maxFileBytes: parsed.SANDBOX_MAX_FILE_BYTES ?? 65_536,
          maxTotalFileBytes: parsed.SANDBOX_MAX_TOTAL_FILE_BYTES ?? 262_144,
          memoryMb: parsed.SANDBOX_MEMORY_MB ?? 128,
          cpuLimit: parsed.SANDBOX_CPU_LIMIT ?? '0.5',
          processLimit: parsed.SANDBOX_PROCESS_LIMIT ?? 32,
          temporaryFilesystemMb: parsed.SANDBOX_TMPFS_MB ?? 16,
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
    ...(compute === undefined ? {} : { compute }),
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

const mcpRuntimeConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    MCP_HOST: z.string().min(1).default('127.0.0.1'),
    MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
    AGENTCLEAR_API_BASE_URL: httpUrlSchema.default('http://127.0.0.1:3001'),
    MCP_ALLOWED_HOSTS: optionalEnvironmentValue(commaSeparatedListSchema),
    MCP_ALLOWED_ORIGINS: optionalEnvironmentValue(commaSeparatedListSchema),
    MCP_MAX_BODY_BYTES: optionalEnvironmentValue(
      z.coerce.number().int().min(1_024).max(4_194_304),
    ),
    MCP_MAX_RESPONSE_BYTES: optionalEnvironmentValue(
      z.coerce.number().int().min(1_024).max(8_388_608),
    ),
    MCP_UPSTREAM_TIMEOUT_MS: optionalEnvironmentValue(
      z.coerce.number().int().min(1_000).max(300_000),
    ),
    MCP_RATE_LIMIT_PER_MINUTE: optionalEnvironmentValue(
      z.coerce.number().int().min(1).max(10_000),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.MCP_HOST === '0.0.0.0' || value.MCP_HOST === '::')
      && value.MCP_ALLOWED_HOSTS === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MCP_ALLOWED_HOSTS'],
        message: 'Public MCP binds require an explicit allowed-host list.',
      });
    }
    for (const [index, origin] of (value.MCP_ALLOWED_ORIGINS ?? []).entries()) {
      try {
        const parsed = new URL(origin);
        if (
          (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
          || parsed.origin !== origin.replace(/\/$/u, '')
        ) {
          throw new TypeError();
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['MCP_ALLOWED_ORIGINS', index],
          message: 'Allowed origins must be exact HTTP(S) origins without paths.',
        });
      }
    }
  });

export type McpRuntimeConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  apiBaseUrl: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  maxResponseBytes: number;
  upstreamTimeoutMs: number;
  rateLimitPerMinute: number;
};

export function loadMcpRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): McpRuntimeConfig {
  const parsed = mcpRuntimeConfigSchema.parse({
    NODE_ENV: environment['NODE_ENV'],
    MCP_HOST: environment['MCP_HOST'],
    MCP_PORT: environment['MCP_PORT'],
    AGENTCLEAR_API_BASE_URL: environment['AGENTCLEAR_API_BASE_URL'],
    MCP_ALLOWED_HOSTS: environment['MCP_ALLOWED_HOSTS'],
    MCP_ALLOWED_ORIGINS: environment['MCP_ALLOWED_ORIGINS'],
    MCP_MAX_BODY_BYTES: environment['MCP_MAX_BODY_BYTES'],
    MCP_MAX_RESPONSE_BYTES: environment['MCP_MAX_RESPONSE_BYTES'],
    MCP_UPSTREAM_TIMEOUT_MS: environment['MCP_UPSTREAM_TIMEOUT_MS'],
    MCP_RATE_LIMIT_PER_MINUTE: environment['MCP_RATE_LIMIT_PER_MINUTE'],
  });
  const apiUrl = new URL(parsed.AGENTCLEAR_API_BASE_URL);
  if (apiUrl.pathname !== '/' || apiUrl.search !== '' || apiUrl.hash !== '') {
    throw new TypeError('AGENTCLEAR_API_BASE_URL must not include a path, query, or fragment.');
  }
  const defaultHosts = parsed.MCP_HOST === '127.0.0.1' || parsed.MCP_HOST === '::1'
    ? ['127.0.0.1', 'localhost', '::1']
    : [parsed.MCP_HOST];

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.MCP_HOST,
    port: parsed.MCP_PORT,
    apiBaseUrl: apiUrl.toString().replace(/\/$/u, ''),
    allowedHosts: parsed.MCP_ALLOWED_HOSTS ?? defaultHosts,
    allowedOrigins: (parsed.MCP_ALLOWED_ORIGINS ?? []).map(
      (origin) => origin.replace(/\/$/u, ''),
    ),
    maxBodyBytes: parsed.MCP_MAX_BODY_BYTES ?? 1_048_576,
    maxResponseBytes: parsed.MCP_MAX_RESPONSE_BYTES ?? 4_194_304,
    upstreamTimeoutMs: parsed.MCP_UPSTREAM_TIMEOUT_MS ?? 180_000,
    rateLimitPerMinute: parsed.MCP_RATE_LIMIT_PER_MINUTE ?? 60,
  };
}
