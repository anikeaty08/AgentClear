import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { sha256Commitment } from './canonical.js';
import {
  ChainOperationFailedError,
  ChainUnavailableError,
  DomainError,
  JobCancellationForbiddenError,
  JobExpiryRefundDisabledError,
  JobNotExpiredError,
  JobNotFoundError,
} from './errors.js';
import { InMemoryExclusiveExecutor, type ExclusiveExecutor } from './exclusive-executor.js';
import type { PreparedFundingTransaction } from './funding.js';
import type { Job, JobActor, JobStateEvent } from './job.js';
import type { IdempotencyClaim, JobRepository } from './job-repository.js';
import type { JobState } from './job-state.js';

export const closeJobInputSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type CloseJobInput = z.infer<typeof closeJobInputSchema>;
export type JobClosureKind = 'CANCEL' | 'EXPIRE';
export type JobClosureOperationStatus = 'CREATED' | 'PREPARED' | 'BROADCAST' | 'CONFIRMED';

export type JobClosureCommand = {
  jobId: string;
  agreementHash: `0x${string}`;
  amountBaseUnits: string;
};

export type ConfirmedJobClosure = {
  transactionHash: `0x${string}`;
  blockNumber: string;
  contractAddress: `0x${string}`;
  escrow: {
    jobKey: `0x${string}`;
    buyer: `0x${string}`;
    provider: `0x${string}` | null;
    amountBaseUnits: string;
    deadline: string;
    state: number;
    agreementHash: `0x${string}`;
  };
};

export interface JobClosureGateway {
  readonly chainId: number;
  readonly contractAddress: `0x${string}`;
  readonly signerAddress: `0x${string}`;
  prepareCancelUnassigned(command: JobClosureCommand): Promise<PreparedFundingTransaction>;
  prepareExpiredRefund(command: JobClosureCommand): Promise<PreparedFundingTransaction>;
  broadcastPreparedTransaction(prepared: PreparedFundingTransaction): Promise<`0x${string}`>;
  confirmCancelUnassigned(
    command: JobClosureCommand,
    prepared: PreparedFundingTransaction,
  ): Promise<ConfirmedJobClosure>;
  confirmExpiredRefund(
    command: JobClosureCommand,
    prepared: PreparedFundingTransaction,
  ): Promise<ConfirmedJobClosure>;
}

export type JobClosureOperation = {
  id: string;
  jobId: string;
  kind: JobClosureKind;
  initialState: JobState;
  status: JobClosureOperationStatus;
  actorType: JobActor['type'];
  actorId: string;
  reason: string;
  chainId: number;
  contractAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  amountBaseUnits: string;
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

export type BeginJobClosureInput = {
  operation: JobClosureOperation | null;
  idempotency: IdempotencyClaim;
  startEvent: JobStateEvent;
  requestedAt: string;
};

export type JobClosureResult = {
  job: Job;
  operation: JobClosureOperation | null;
  replayed: boolean;
};

export type ConfirmJobClosureInput = {
  operationId: string;
  confirmation: ConfirmedJobClosure;
  finalEvent: JobStateEvent;
};

export interface JobClosureRepository {
  beginClosure(input: BeginJobClosureInput): Promise<JobClosureResult>;
  savePrepared(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<JobClosureOperation>;
  markBroadcast(operationId: string, updatedAt: string): Promise<JobClosureOperation>;
  confirmClosure(input: ConfirmJobClosureInput): Promise<JobClosureResult>;
}

export type JobClosureServiceDependencies = {
  jobRepository: JobRepository;
  closureRepository: JobClosureRepository;
  gateway?: JobClosureGateway;
  clock?: () => Date;
  idGenerator?: () => string;
  executor?: ExclusiveExecutor;
};

export class JobClosureService {
  readonly #jobRepository: JobRepository;
  readonly #closureRepository: JobClosureRepository;
  readonly #gateway: JobClosureGateway | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #executor: ExclusiveExecutor;

  public constructor(dependencies: JobClosureServiceDependencies) {
    this.#jobRepository = dependencies.jobRepository;
    this.#closureRepository = dependencies.closureRepository;
    this.#gateway = dependencies.gateway;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
    this.#executor = dependencies.executor ?? new InMemoryExclusiveExecutor();
  }

  public async cancelJob(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<JobClosureResult> {
    return this.#close('CANCEL', jobId, rawInput, context);
  }

  public async expireJob(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<JobClosureResult> {
    return this.#close('EXPIRE', jobId, rawInput, context);
  }

  async #close(
    kind: JobClosureKind,
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<JobClosureResult> {
    const input = closeJobInputSchema.parse(rawInput ?? {});
    return this.#executor.runExclusive(async () => {
      const job = await this.#jobRepository.findById(jobId);
      if (job === null) throw new JobNotFoundError(jobId);
      if (context.actor.type === 'agent' && context.actor.id !== job.agreement.buyerAgentId) {
        throw new JobCancellationForbiddenError();
      }
      const now = this.#clock();
      if (kind === 'EXPIRE') {
        if (!job.agreement.refundPolicy.onExpiry) throw new JobExpiryRefundDisabledError();
        if (now.getTime() <= new Date(job.agreement.deadline).getTime()) {
          throw new JobNotExpiredError();
        }
      }
      const reason = input.reason
        ?? (kind === 'CANCEL'
          ? 'Buyer cancelled the job before provider work began.'
          : 'Job deadline passed and the frozen expiry refund policy was applied.');
      const targetState = kind === 'CANCEL' ? 'CANCELLED' : 'EXPIRED';
      const idempotencyScope = `jobs:${kind.toLowerCase()}:${context.actor.id}:${jobId}`;
      const requestHash = sha256Commitment({ jobId, kind, reason });
      const operation: JobClosureOperation | null = this.#gateway === undefined
        ? null
        : {
          id: this.#idGenerator(),
          jobId,
          kind,
          initialState: job.state,
          status: 'CREATED',
          actorType: context.actor.type,
          actorId: context.actor.id,
          reason,
          chainId: this.#gateway.chainId,
          contractAddress: this.#gateway.contractAddress,
          signerAddress: this.#gateway.signerAddress,
          amountBaseUnits: job.budgetAmountBaseUnits,
          jobKey: null,
          serializedTransaction: null,
          transactionHash: null,
          blockNumber: null,
          idempotencyScope,
          idempotencyKey: context.idempotencyKey,
          requestHash,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
      let result = await this.#closureRepository.beginClosure({
        operation,
        idempotency: {
          scope: idempotencyScope,
          key: context.idempotencyKey,
          requestHash,
          resourceId: jobId,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        },
        startEvent: {
          id: this.#idGenerator(),
          jobId,
          fromState: job.state,
          toState: targetState,
          actorType: context.actor.type,
          actorId: context.actor.id,
          reason,
          occurredAt: now.toISOString(),
        },
        requestedAt: now.toISOString(),
      });
      if (result.operation === null || result.operation.status === 'CONFIRMED') return result;
      const gateway = this.#gateway;
      if (gateway === undefined) throw new ChainUnavailableError();

      const command: JobClosureCommand = {
        jobId,
        agreementHash: job.agreementHash,
        amountBaseUnits: job.budgetAmountBaseUnits,
      };
      try {
        if (result.operation.status === 'CREATED') {
          const prepared = result.operation.kind === 'CANCEL'
            ? await gateway.prepareCancelUnassigned(command)
            : await gateway.prepareExpiredRefund(command);
          result = {
            ...result,
            operation: await this.#closureRepository.savePrepared(
              result.operation.id,
              prepared,
              this.#clock().toISOString(),
            ),
          };
        }
        if (result.operation?.status === 'PREPARED') {
          if (result.operation.serializedTransaction === null || result.operation.jobKey === null) {
            throw new Error('Prepared closure operation is missing its signed transaction.');
          }
          const prepared = operationToPrepared(result.operation);
          await gateway.broadcastPreparedTransaction(prepared);
          result = {
            ...result,
            operation: await this.#closureRepository.markBroadcast(
              result.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        if (result.operation?.status === 'BROADCAST') {
          const prepared = operationToPrepared(result.operation);
          const confirmation = result.operation.kind === 'CANCEL'
            ? await gateway.confirmCancelUnassigned(command, prepared)
            : await gateway.confirmExpiredRefund(command, prepared);
          result = await this.#closureRepository.confirmClosure({
            operationId: result.operation.id,
            confirmation,
            finalEvent: {
              id: this.#idGenerator(),
              jobId,
              fromState: result.operation.kind === 'CANCEL' ? 'FUNDED' : 'EXPIRED',
              toState: result.operation.kind === 'CANCEL' ? 'CANCELLED' : 'REFUNDED',
              actorType: result.operation.actorType,
              actorId: result.operation.actorId,
              reason: result.operation.reason,
              transactionHash: confirmation.transactionHash,
              occurredAt: this.#clock().toISOString(),
            },
          });
        }
        return result;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new ChainOperationFailedError();
      }
    });
  }
}

function operationToPrepared(operation: JobClosureOperation): PreparedFundingTransaction {
  if (
    operation.jobKey === null
    || operation.transactionHash === null
    || operation.serializedTransaction === null
  ) {
    throw new Error('Closure operation does not contain a prepared transaction.');
  }
  return {
    jobKey: operation.jobKey,
    transactionHash: operation.transactionHash,
    serializedTransaction: operation.serializedTransaction,
    contractAddress: operation.contractAddress,
    signerAddress: operation.signerAddress,
  };
}
