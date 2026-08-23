import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { sha256Commitment } from './canonical.js';
import {
  ChainOperationFailedError,
  DomainError,
  JobNotFoundError,
  ProviderMismatchError,
} from './errors.js';
import { InMemoryExclusiveExecutor, type ExclusiveExecutor } from './exclusive-executor.js';
import type { Job, JobActor, JobStateEvent } from './job.js';
import type { IdempotencyClaim, JobRepository } from './job-repository.js';
import type { PreparedFundingTransaction } from './funding.js';

const agentIdSchema = z.string().regex(/^erc8004:\d+:\d+$/);
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((address) => !/^0x0{40}$/i.test(address), 'Provider address cannot be zero.');

export const assignProviderInputSchema = z
  .object({
    providerAgentId: agentIdSchema,
    providerAddress: addressSchema,
  })
  .strict();

export type AssignProviderInput = z.infer<typeof assignProviderInputSchema>;
export type AssignmentOperationStatus = 'CREATED' | 'PREPARED' | 'BROADCAST' | 'CONFIRMED';

export type AssignmentOperation = {
  id: string;
  jobId: string;
  status: AssignmentOperationStatus;
  chainId: number;
  contractAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  providerAgentId: string;
  providerAddress: `0x${string}`;
  jobKey: `0x${string}` | null;
  serializedTransaction: `0x${string}` | null;
  transactionHash: `0x${string}` | null;
  blockNumber: string | null;
  idempotencyScope: string;
  idempotencyKey: string;
  requestHash: `0x${string}`;
  createdAt: string;
  updatedAt: string;
};

export type ConfirmedAssignment = {
  transactionHash: `0x${string}`;
  blockNumber: string;
  contractAddress: `0x${string}`;
  escrow: { provider: `0x${string}` | null };
};

export interface AssignmentGateway {
  readonly chainId: number;
  readonly contractAddress: `0x${string}`;
  readonly signerAddress: `0x${string}`;
  prepareAssignProvider(
    jobId: string,
    providerAddress: `0x${string}`,
  ): Promise<PreparedFundingTransaction>;
  broadcastPreparedTransaction(prepared: PreparedFundingTransaction): Promise<`0x${string}`>;
  confirmAssignProvider(
    jobId: string,
    providerAddress: `0x${string}`,
    prepared: PreparedFundingTransaction,
  ): Promise<ConfirmedAssignment>;
}

export type BeginAssignmentInput = {
  operation: AssignmentOperation;
  idempotency: IdempotencyClaim;
  openEvent: JobStateEvent;
};

export type AssignmentResult = {
  job: Job;
  operation: AssignmentOperation;
  replayed: boolean;
};

export type ConfirmAssignmentPersistenceInput = {
  operationId: string;
  confirmation: ConfirmedAssignment;
  event: JobStateEvent;
};

export interface AssignmentRepository {
  beginAssignment(input: BeginAssignmentInput): Promise<AssignmentResult>;
  savePreparedAssignment(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<AssignmentOperation>;
  markAssignmentBroadcast(operationId: string, updatedAt: string): Promise<AssignmentOperation>;
  confirmAssignment(input: ConfirmAssignmentPersistenceInput): Promise<AssignmentResult>;
}

export type AssignmentServiceDependencies = {
  jobRepository: JobRepository;
  assignmentRepository: AssignmentRepository;
  gateway: AssignmentGateway;
  executor?: ExclusiveExecutor;
  clock?: () => Date;
  idGenerator?: () => string;
};

export class AssignmentService {
  readonly #jobRepository: JobRepository;
  readonly #repository: AssignmentRepository;
  readonly #gateway: AssignmentGateway;
  readonly #executor: ExclusiveExecutor;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(dependencies: AssignmentServiceDependencies) {
    this.#jobRepository = dependencies.jobRepository;
    this.#repository = dependencies.assignmentRepository;
    this.#gateway = dependencies.gateway;
    this.#executor = dependencies.executor ?? new InMemoryExclusiveExecutor();
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  public async assignProvider(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<AssignmentResult> {
    const input = assignProviderInputSchema.parse(rawInput);
    return this.#executor.runExclusive(async () => {
      const job = await this.#jobRepository.findById(jobId);
      if (job === null) throw new JobNotFoundError(jobId);
      if (
        input.providerAgentId === job.agreement.buyerAgentId
        || (job.agreement.providerAgentId !== undefined
          && job.agreement.providerAgentId !== input.providerAgentId)
      ) {
        throw new ProviderMismatchError();
      }

      const now = this.#clock();
      const idempotencyScope = `jobs:assign:${context.actor.id}:${jobId}`;
      const requestHash = sha256Commitment({ jobId, ...input });
      let result = await this.#repository.beginAssignment({
        operation: {
          id: this.#idGenerator(),
          jobId,
          status: 'CREATED',
          chainId: this.#gateway.chainId,
          contractAddress: this.#gateway.contractAddress,
          signerAddress: this.#gateway.signerAddress,
          providerAgentId: input.providerAgentId,
          providerAddress: input.providerAddress as `0x${string}`,
          jobKey: null,
          serializedTransaction: null,
          transactionHash: null,
          blockNumber: null,
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
        openEvent: {
          id: this.#idGenerator(),
          jobId,
          fromState: 'FUNDED',
          toState: 'OPEN',
          actorType: context.actor.type,
          actorId: context.actor.id,
          reason: 'Funded job opened for provider assignment.',
          occurredAt: now.toISOString(),
        },
      });
      if (result.operation.status === 'CONFIRMED') return result;

      try {
        if (result.operation.status === 'CREATED') {
          const prepared = await this.#gateway.prepareAssignProvider(
            jobId,
            input.providerAddress as `0x${string}`,
          );
          result = {
            ...result,
            operation: await this.#repository.savePreparedAssignment(
              result.operation.id,
              prepared,
              this.#clock().toISOString(),
            ),
          };
        }
        const prepared = this.#requirePrepared(result.operation);
        await this.#gateway.broadcastPreparedTransaction(prepared);
        if (result.operation.status === 'PREPARED') {
          result = {
            ...result,
            operation: await this.#repository.markAssignmentBroadcast(
              result.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        const confirmation = await this.#gateway.confirmAssignProvider(
          jobId,
          input.providerAddress as `0x${string}`,
          prepared,
        );
        return this.#repository.confirmAssignment({
          operationId: result.operation.id,
          confirmation,
          event: {
            id: this.#idGenerator(),
            jobId,
            fromState: 'OPEN',
            toState: 'ASSIGNED',
            actorType: context.actor.type,
            actorId: context.actor.id,
            reason: `Provider ${input.providerAgentId} assigned and contract state attested.`,
            transactionHash: confirmation.transactionHash,
            occurredAt: this.#clock().toISOString(),
          },
        });
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new ChainOperationFailedError();
      }
    });
  }

  #requirePrepared(operation: AssignmentOperation): PreparedFundingTransaction {
    if (
      operation.jobKey === null
      || operation.serializedTransaction === null
      || operation.transactionHash === null
    ) {
      throw new ChainOperationFailedError();
    }
    return {
      jobKey: operation.jobKey,
      serializedTransaction: operation.serializedTransaction,
      transactionHash: operation.transactionHash,
      contractAddress: operation.contractAddress,
      signerAddress: operation.signerAddress,
    };
  }
}
