import { z } from 'zod';

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
  })
  .strict()
  .superRefine((value, context) => {
    if (value.NODE_ENV !== 'production') {
      return;
    }

    const forbiddenFragments = ['replace-with', 'change-me', 'local-only'];
    for (const [field, secret] of [
      ['API_KEY_PEPPER', value.API_KEY_PEPPER],
      ['BOOTSTRAP_API_KEY', value.BOOTSTRAP_API_KEY],
    ] as const) {
      if (forbiddenFragments.some((fragment) => secret.toLowerCase().includes(fragment))) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Placeholder credentials are forbidden in production.',
        });
      }
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
  });

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
    },
  };
}
