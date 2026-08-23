import { loadRuntimeConfig } from '@agentclear/config';
import {
  createPrivateKeyEscrowGateway,
  defineAgentClearChain,
} from '@agentclear/chain';
import {
  createDatabaseClient,
  PostgresExclusiveExecutor,
  PostgresAssignmentRepository,
  PostgresEscrowRepository,
  PostgresJobRepository,
  PostgresSubmissionRepository,
  PostgresVerificationRepository,
} from '@agentclear/db';
import {
  AssignmentService,
  FundingService,
  JobService,
  SubmissionQueryService,
  SubmissionService,
  VerificationQueryService,
  VerificationService,
} from '@agentclear/domain';
import { ZeroGStorageClient } from '@agentclear/storage';

import { buildApp } from './app.js';
import { BootstrapApiKeyAuthenticator, CompositeAuthenticator } from './auth.js';

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
const chainWriteExecutor = new PostgresExclusiveExecutor(database.pool);
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
const storage =
  config.storage === undefined
    ? undefined
    : new ZeroGStorageClient({
        rpcUrl: config.storage.rpcUrl,
        indexerUrl: config.storage.indexerUrl,
        signerPrivateKey: config.storage.signerPrivateKey,
        maxPayloadBytes: config.storage.maxPayloadBytes,
      });
const submissionRepository = new PostgresSubmissionRepository(database.db);
const verificationRepository = new PostgresVerificationRepository(database.db);
const submissionService =
  config.storage === undefined || storage === undefined
    ? undefined
    : new SubmissionService({
        jobRepository,
        submissionRepository,
        storage,
        maxPayloadBytes: config.storage.maxPayloadBytes,
        executor: chainWriteExecutor,
      });
const verificationService =
  config.storage === undefined || storage === undefined
    ? undefined
    : new VerificationService({
        jobRepository,
        submissionRepository,
        verificationRepository,
        storage,
        maxReportBytes: config.storage.maxPayloadBytes,
        executor: chainWriteExecutor,
      });
const authenticators = [
  new BootstrapApiKeyAuthenticator(
    config.auth.bootstrapApiKey,
    config.auth.apiKeyPepper,
    config.auth.bootstrapPrincipalId,
  ),
];
if (config.auth.providerBootstrap !== undefined) {
  authenticators.push(
    new BootstrapApiKeyAuthenticator(
      config.auth.providerBootstrap.apiKey,
      config.auth.apiKeyPepper,
      config.auth.providerBootstrap.agentId,
      'agent',
      new Set(['jobs:read', 'jobs:submit']),
    ),
  );
}
const authenticator = new CompositeAuthenticator(authenticators);

const app = await buildApp({
  jobService,
  jobRepository,
  authenticator,
  submissionQueryService: new SubmissionQueryService(jobRepository, submissionRepository),
  verificationQueryService: new VerificationQueryService(jobRepository, verificationRepository),
  ...(fundingService === undefined ? {} : { fundingService }),
  ...(assignmentService === undefined ? {} : { assignmentService }),
  ...(submissionService === undefined ? {} : { submissionService }),
  ...(verificationService === undefined ? {} : { verificationService }),
  ...(chain === undefined ? {} : { chainHealth: async () => chain.health() }),
  ...(storage === undefined ? {} : { storageHealth: async () => storage.health() }),
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
