import { loadRuntimeConfig } from '@agentclear/config';
import { createZeroGComputeVerifier } from '@agentclear/compute';
import {
  createPrivateKeyEscrowGateway,
  createPrivateKeyOutcomeRegistryGateway,
  createPrivateKeyErc8004ReputationGateway,
  defineAgentClearChain,
} from '@agentclear/chain';
import {
  createDatabaseClient,
  PostgresApiKeyRepository,
  PostgresExclusiveExecutor,
  PostgresAssignmentRepository,
  PostgresEscrowRepository,
  PostgresJobRepository,
  PostgresSubmissionRepository,
  PostgresVerificationRepository,
  PostgresSettlementRepository,
  PostgresReputationRepository,
  PostgresReceiptRepository,
  PostgresSpendingPolicyRepository,
} from '@agentclear/db';
import {
  ApiKeyService,
  AssignmentService,
  FundingService,
  JobService,
  SubmissionQueryService,
  SubmissionService,
  VerificationQueryService,
  VerificationService,
  SettlementService,
  ReputationService,
  ReceiptService,
  SpendingPolicyService,
} from '@agentclear/domain';
import { ZeroGStorageClient } from '@agentclear/storage';
import { DockerSandboxVerifier, createWslDockerSandbox } from '@agentclear/sandbox';

import { buildApp } from './app.js';
import {
  BootstrapApiKeyAuthenticator,
  CompositeAuthenticator,
  DurableApiKeyAuthenticator,
} from './auth.js';

const config = loadRuntimeConfig();
const database = createDatabaseClient(config.databaseUrl);
const jobRepository = new PostgresJobRepository(database.db);
const jobService = new JobService({ repository: jobRepository, listRepository: jobRepository });
const apiKeyService = new ApiKeyService({
  repository: new PostgresApiKeyRepository(database.db),
  pepper: config.auth.apiKeyPepper,
});
const spendingPolicyRepository = new PostgresSpendingPolicyRepository(database.db);
const spendingPolicyService = new SpendingPolicyService({ repository: spendingPolicyRepository });
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
const outcomeGateway =
  config.chain?.outcomeRegistryAddress === undefined
    ? undefined
    : createPrivateKeyOutcomeRegistryGateway({
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
        contractAddress: config.chain.outcomeRegistryAddress,
        privateKey: config.chain.signerPrivateKey,
        confirmations: config.chain.confirmations,
      });
const reputationGateway =
  config.chain?.erc8004 === undefined
    ? undefined
    : createPrivateKeyErc8004ReputationGateway({
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
        identityRegistryAddress: config.chain.erc8004.identityRegistryAddress,
        reputationRegistryAddress: config.chain.erc8004.reputationRegistryAddress,
        privateKey: config.chain.signerPrivateKey,
        confirmations: config.chain.confirmations,
      });
const fundingService =
  config.chain === undefined || chain === undefined
    ? undefined
    : new FundingService({
        jobRepository,
        escrowRepository: new PostgresEscrowRepository(database.db),
        gateway: chain,
        maxPerJobBaseUnits: config.chain.maxPerJobBaseUnits,
        spendingAuthorizer: spendingPolicyRepository,
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
const computeVerifier =
  config.compute === undefined
    ? undefined
    : await createZeroGComputeVerifier({
        rpcUrl: config.compute.rpcUrl,
        signerPrivateKey: config.compute.signerPrivateKey,
        providerAddress: config.compute.providerAddress,
        ...(config.compute.model === undefined ? {} : { model: config.compute.model }),
        timeoutMs: config.compute.timeoutMs,
        maxResponseBytes: config.compute.maxResponseBytes,
        requireTee: config.compute.requireTee,
      });
const sandboxVerifier =
  config.sandbox === undefined
    ? undefined
    : config.sandbox.containerCli === 'wsl-docker'
      ? createWslDockerSandbox({
          image: config.sandbox.image,
          timeoutMs: config.sandbox.timeoutMs,
          maxOutputBytes: config.sandbox.maxOutputBytes,
          maxFileBytes: config.sandbox.maxFileBytes,
          maxTotalFileBytes: config.sandbox.maxTotalFileBytes,
          memoryMb: config.sandbox.memoryMb,
          cpuLimit: config.sandbox.cpuLimit,
          processLimit: config.sandbox.processLimit,
          temporaryFilesystemMb: config.sandbox.temporaryFilesystemMb,
        })
      : new DockerSandboxVerifier({
          image: config.sandbox.image,
          timeoutMs: config.sandbox.timeoutMs,
          maxOutputBytes: config.sandbox.maxOutputBytes,
          maxFileBytes: config.sandbox.maxFileBytes,
          maxTotalFileBytes: config.sandbox.maxTotalFileBytes,
          memoryMb: config.sandbox.memoryMb,
          cpuLimit: config.sandbox.cpuLimit,
          processLimit: config.sandbox.processLimit,
          temporaryFilesystemMb: config.sandbox.temporaryFilesystemMb,
        });
const submissionRepository = new PostgresSubmissionRepository(database.db);
const verificationRepository = new PostgresVerificationRepository(database.db);
const settlementRepository = new PostgresSettlementRepository(database.db);
const reputationRepository = new PostgresReputationRepository(database.db);
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
        ...(computeVerifier === undefined ? {} : { aiVerifier: computeVerifier }),
        ...(sandboxVerifier === undefined ? {} : { sandboxVerifier }),
        requireVerifiedAiResponse: config.compute?.requireTee ?? true,
        executor: chainWriteExecutor,
      });
const settlementService =
  chain === undefined || outcomeGateway === undefined
    ? undefined
    : new SettlementService({
        jobRepository,
        submissionRepository,
        verificationRepository,
        settlementRepository,
        outcomeGateway,
        escrowGateway: chain,
        executor: chainWriteExecutor,
      });
const reputationService =
  reputationGateway === undefined
    ? undefined
    : new ReputationService({
        jobRepository,
        verificationRepository,
        reputationRepository,
        gateway: reputationGateway,
        executor: chainWriteExecutor,
      });
const receiptService =
  config.storage === undefined || storage === undefined
    ? undefined
    : new ReceiptService({
        repository: new PostgresReceiptRepository(database.db),
        storage,
        maxPayloadBytes: config.storage.maxPayloadBytes,
        executor: chainWriteExecutor,
      });
const authenticators = [
  new BootstrapApiKeyAuthenticator(
    config.auth.bootstrapApiKey,
    config.auth.apiKeyPepper,
    config.auth.bootstrapPrincipalId,
  ),
  new DurableApiKeyAuthenticator(apiKeyService),
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
  apiKeyService,
  spendingPolicyService,
  jobService,
  jobRepository,
  authenticator,
  submissionQueryService: new SubmissionQueryService(jobRepository, submissionRepository),
  verificationQueryService: new VerificationQueryService(jobRepository, verificationRepository),
  ...(fundingService === undefined ? {} : { fundingService }),
  ...(assignmentService === undefined ? {} : { assignmentService }),
  ...(submissionService === undefined ? {} : { submissionService }),
  ...(verificationService === undefined ? {} : { verificationService }),
  ...(settlementService === undefined ? {} : { settlementService }),
  ...(reputationService === undefined ? {} : { reputationService }),
  ...(receiptService === undefined ? {} : { receiptService }),
  ...(chain === undefined
    ? {}
    : {
        chainHealth: async () => ({
          escrow: await chain.health(),
          ...(outcomeGateway === undefined
            ? {}
            : { outcomeRegistry: await outcomeGateway.health() }),
          ...(reputationGateway === undefined
            ? {}
            : { erc8004: await reputationGateway.health() }),
        }),
      }),
  ...(storage === undefined ? {} : { storageHealth: async () => storage.health() }),
  ...(computeVerifier === undefined
    ? {}
    : { computeHealth: async () => computeVerifier.health() }),
  ...(sandboxVerifier === undefined
    ? {}
    : {
        sandboxHealth: async () => {
          const health = await sandboxVerifier.health();
          if (!health.ready) throw new Error('Configured sandbox image is unavailable.');
          return health;
        },
      }),
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
