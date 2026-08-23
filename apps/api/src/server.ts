import { loadRuntimeConfig } from '@agentclear/config';
import { createDatabaseClient, PostgresJobRepository } from '@agentclear/db';
import { JobService } from '@agentclear/domain';

import { buildApp } from './app.js';
import { BootstrapApiKeyAuthenticator } from './auth.js';

const config = loadRuntimeConfig();
const database = createDatabaseClient(config.databaseUrl);
const jobRepository = new PostgresJobRepository(database.db);
const jobService = new JobService({ repository: jobRepository });
const authenticator = new BootstrapApiKeyAuthenticator(
  config.auth.bootstrapApiKey,
  config.auth.apiKeyPepper,
  config.auth.bootstrapPrincipalId,
);

const app = await buildApp({
  jobService,
  jobRepository,
  authenticator,
  logger: {
    level: config.api.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization'],
      censor: '[REDACTED]',
    },
  },
});

app.addHook('onClose', async () => {
  await database.close();
});

const shutdown = async (signal: NodeJS.Signals) => {
  app.log.info({ signal }, 'Shutting down API');
  await app.close();
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.api.host, port: config.api.port });
} catch (error) {
  app.log.fatal({ err: error }, 'API failed to start');
  await app.close();
  process.exitCode = 1;
}

