import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { sha256Commitment } from './canonical.js';
import {
  ChainOperationFailedError,
  JobNotFoundError,
  JobNotReputableError,
} from './errors.js';
import { InMemoryExclusiveExecutor, type ExclusiveExecutor } from './exclusive-executor.js';
import type { JobActor } from './job.js';
import type { IdempotencyClaim, JobRepository } from './job-repository.js';
import type { VerificationRepository } from './verification.js';

export const recordReputationInputSchema = z.object({}).strict();
export type ReputationOperationStatus = 'CREATED' | 'PREPARED' | 'BROADCAST' | 'CONFIRMED';

export type ReputationFeedbackCommand = {
  providerAgentId: string;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: `0x${string}`;
};

export type PreparedReputationTransaction = {
  agentTokenId: string;
  transactionHash: `0x${string}`;
  serializedTransaction: `0x${string}`;
  contractAddress: `0x${string}`;
  identityRegistryAddress: `0x${string}`;
  signerAddress: `0x${string}`;
};

export interface ReputationGateway {
  prepareFeedback(command: ReputationFeedbackCommand): Promise<PreparedReputationTransaction>;
  broadcastPreparedFeedback(prepared: PreparedReputationTransaction): Promise<`0x${string}`>;
  confirmFeedback(
    command: ReputationFeedbackCommand,
    prepared: PreparedReputationTransaction,
  ): Promise<{
    transactionHash: `0x${string}`;
    blockNumber: string;
    feedbackIndex: string;
    clientAddress: `0x${string}`;
  }>;
}

export type ReputationOperation = {
  id: string;
  jobId: string;
  verificationRunId: string;
  providerAgentId: string;
  outcome: 'PASS' | 'FAIL';
  value: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  feedbackUri: string;
  feedbackHash: `0x${string}`;
  status: ReputationOperationStatus;
  agentTokenId: string | null;
  contractAddress: `0x${string}` | null;
  identityRegistryAddress: `0x${string}` | null;
  signerAddress: `0x${string}` | null;
  serializedTransaction: `0x${string}` | null;
  transactionHash: `0x${string}` | null;
  blockNumber: string | null;
  feedbackIndex: string | null;
  idempotencyScope: string;
  idempotencyKey: string;
  requestHash: `0x${string}`;
  createdAt: string;
  updatedAt: string;
};

export type ReputationEvent = {
  jobId: string;
  providerAgentId: string;
  registryAddress: `0x${string}`;
  identityRegistryAddress: `0x${string}`;
  agentTokenId: string;
  clientAddress: `0x${string}`;
  value: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  feedbackUri: string;
  feedbackHash: `0x${string}`;
  transactionHash: `0x${string}`;
  blockNumber: string;
  feedbackIndex: string;
  createdAt: string;
};

export type ReputationPersistenceResult = {
  operation: ReputationOperation;
  reputation: ReputationEvent | null;
  replayed: boolean;
};

export interface ReputationRepository {
  findByIdempotency(scope: string, key: string): Promise<ReputationPersistenceResult | null>;
  beginReputation(input: {
    operation: ReputationOperation;
    idempotency: IdempotencyClaim;
  }): Promise<ReputationPersistenceResult>;
  savePrepared(
    operationId: string,
    prepared: PreparedReputationTransaction,
    updatedAt: string,
  ): Promise<ReputationOperation>;
  markBroadcast(operationId: string, updatedAt: string): Promise<ReputationOperation>;
  confirmReputation(input: {
    operationId: string;
    transactionHash: `0x${string}`;
    blockNumber: string;
    feedbackIndex: string;
    clientAddress: `0x${string}`;
    createdAt: string;
  }): Promise<ReputationPersistenceResult>;
}

export class ReputationService {
  readonly #jobRepository: JobRepository;
  readonly #verificationRepository: VerificationRepository;
  readonly #repository: ReputationRepository;
  readonly #gateway: ReputationGateway;
  readonly #executor: ExclusiveExecutor;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(dependencies: {
    jobRepository: JobRepository;
    verificationRepository: VerificationRepository;
    reputationRepository: ReputationRepository;
    gateway: ReputationGateway;
    executor?: ExclusiveExecutor;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.#jobRepository = dependencies.jobRepository;
    this.#verificationRepository = dependencies.verificationRepository;
    this.#repository = dependencies.reputationRepository;
    this.#gateway = dependencies.gateway;
    this.#executor = dependencies.executor ?? new InMemoryExclusiveExecutor();
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  public async recordOutcome(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<ReputationPersistenceResult> {
    recordReputationInputSchema.parse(rawInput);
    return this.#executor.runExclusive(async () => {
      const job = await this.#jobRepository.findById(jobId);
      if (job === null) throw new JobNotFoundError(jobId);
      const idempotencyScope = `jobs:reputation:${context.actor.id}:${jobId}`;
      const existing = await this.#repository.findByIdempotency(
        idempotencyScope,
        context.idempotencyKey,
      );
      if (existing?.operation.status === 'CONFIRMED') return { ...existing, replayed: true };
      const verification = (await this.#verificationRepository.listByJob(jobId)).at(-1);
      if (
        verification === undefined
        || job.providerAgentId === null
        || (job.state !== 'PAID' && job.state !== 'REFUNDED')
        || (verification.outcome !== 'PASS' && verification.outcome !== 'FAIL')
        || (job.state === 'PAID' && verification.outcome !== 'PASS')
        || (job.state === 'REFUNDED' && verification.outcome !== 'FAIL')
      ) throw new JobNotReputableError();
      const outcome = verification.outcome;
      const command: ReputationFeedbackCommand = {
        providerAgentId: job.providerAgentId,
        value: outcome === 'PASS' ? 100n : 0n,
        valueDecimals: 0,
        tag1: 'agentclear.outcome',
        tag2: job.agreement.deliverable.type,
        endpoint: '',
        feedbackUri: `0g://${verification.reportStorageRootHash}`,
        feedbackHash: `0x${'0'.repeat(64)}`,
      };
      const now = this.#clock();
      const requestHash = sha256Commitment({
        jobId,
        verificationRunId: verification.runId,
        outcome,
      });
      let persisted = await this.#repository.beginReputation({
        operation: {
          id: this.#idGenerator(),
          jobId,
          verificationRunId: verification.runId,
          providerAgentId: job.providerAgentId,
          outcome,
          value: command.value.toString(),
          valueDecimals: command.valueDecimals,
          tag1: command.tag1,
          tag2: command.tag2,
          feedbackUri: command.feedbackUri,
          feedbackHash: command.feedbackHash,
          status: 'CREATED',
          agentTokenId: null,
          contractAddress: null,
          identityRegistryAddress: null,
          signerAddress: null,
          serializedTransaction: null,
          transactionHash: null,
          blockNumber: null,
          feedbackIndex: null,
          idempotencyScope,
          idempotencyKey: context.idempotencyKey,
          requestHash,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        idempotency: {
          scope: idempotencyScope,
          key: context.idempotencyKey,
          requestHash,
          resourceId: jobId,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        },
      });
      if (persisted.operation.status === 'CONFIRMED') return persisted;
      try {
        if (persisted.operation.status === 'CREATED') {
          const prepared = await this.#gateway.prepareFeedback(command);
          persisted = {
            ...persisted,
            operation: await this.#repository.savePrepared(
              persisted.operation.id,
              prepared,
              this.#clock().toISOString(),
            ),
          };
        }
        const prepared = this.#prepared(persisted.operation);
        await this.#gateway.broadcastPreparedFeedback(prepared);
        if (persisted.operation.status === 'PREPARED') {
          persisted = {
            ...persisted,
            operation: await this.#repository.markBroadcast(
              persisted.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        const confirmed = await this.#gateway.confirmFeedback(command, prepared);
        return this.#repository.confirmReputation({
          operationId: persisted.operation.id,
          transactionHash: confirmed.transactionHash,
          blockNumber: confirmed.blockNumber,
          feedbackIndex: confirmed.feedbackIndex,
          clientAddress: confirmed.clientAddress,
          createdAt: this.#clock().toISOString(),
        });
      } catch (error) {
        if (error instanceof ChainOperationFailedError) throw error;
        throw new ChainOperationFailedError();
      }
    });
  }

  #prepared(operation: ReputationOperation): PreparedReputationTransaction {
    if (
      operation.agentTokenId === null
      || operation.transactionHash === null
      || operation.serializedTransaction === null
      || operation.contractAddress === null
      || operation.identityRegistryAddress === null
      || operation.signerAddress === null
    ) throw new ChainOperationFailedError();
    return {
      agentTokenId: operation.agentTokenId,
      transactionHash: operation.transactionHash,
      serializedTransaction: operation.serializedTransaction,
      contractAddress: operation.contractAddress,
      identityRegistryAddress: operation.identityRegistryAddress,
      signerAddress: operation.signerAddress,
    };
  }
}
