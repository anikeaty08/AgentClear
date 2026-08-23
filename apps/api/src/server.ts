import { loadRuntimeConfig } from '@agentclear/config';
import {
  createPrivateKeyEscrowGateway,
  defineAgentClearChain,
} from '@agentclear/chain';
import {
  createDatabaseClient,
  PostgresAssignmentRepository,
  PostgresEscrowRepository,
  PostgresJobRepository,
} from '@agentclear/db';
import {
  AssignmentService,
  FundingService,
  InMemoryExclusiveExecutor,
  JobService,
} from '@agentclear/domain';

import { buildApp } from './app.js';
import { BootstrapApiKeyAuthenticator } from './auth.js';

const config = loadRuntimeConfig();
const database = createDatabaseClient(config.databaseUrl);
const jobRepository = new PostgresJobRepository(database.db);
const jobService = new JobService({ repository: jobRepository });
const chain =
  config.chain === undefined
    ? undefined
    : createPrivateKeyEscrowGateway({
        rpcUrl: config.chain.rpcUrl,
        chain: defineAgentClearChain({
          chainId: config.chain.chainId,
          name: config.chain.name,
          nativeCurrencySymbol: config.chain.nativeCurrencySymbol,
          rpcUrl: config.chain.rpcUrl,
          ...(config.chain.explorerUrl === undefined
            ? {}
            : { explorerUrl: config.chain.explorerUrl }),
        }),
        contractAddress: config.chain.escrowAddress,
        privateKey: config.chain.signerPrivateKey,
        confirmations: config.chain.confirmations,
      });
const chainWriteExecutor = new InMemoryExclusiveExecutor();
const fundingService =
  config.chain === undefined || chain === undefined
    ? undefined
    : new FundingService({
        jobRepository,
        escrowRepository: new PostgresEscrowRepository(database.db),
        gateway: chain,
        maxPerJobBaseUnits: config.chain.maxPerJobBaseUnits,
        executor: chainWriteExecutor,
      });
const assignmentService =
  config.chain === undefined || chain === undefined
    ? undefined
    : new AssignmentService({
        jobRepository,
        assignmentRepository: new PostgresAssignmentRepository(database.db),
        gateway: chain,
        executor: chainWriteExecutor,
      });
const authenticator = new BootstrapApiKeyAuthenticator(
  config.auth.bootstrapApiKey,
  config.auth.apiKeyPepper,
  config.auth.bootstrapPrincipalId,
);

const app = await buildApp({
  jobService,
  jobRepository,
  authenticator,
  ...(fundingService === undefined ? {} : { fundingService }),
  ...(assignmentService === undefined ? {} : { assignmentService }),
  ...(chain === undefined ? {} : { chainHealth: async () => chain.health() }),
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
