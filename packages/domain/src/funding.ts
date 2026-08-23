import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { sha256Commitment } from './canonical.js';
import {
  ChainOperationFailedError,
  DomainError,
  JobNotFoundError,
  SpendingPolicyExceededError,
} from './errors.js';
import type { Job, JobActor, JobStateEvent } from './job.js';
import type { IdempotencyClaim, JobRepository } from './job-repository.js';
import { InMemoryExclusiveExecutor, type ExclusiveExecutor } from './exclusive-executor.js';

export const fundJobInputSchema = z.object({}).strict();

export type FundJobInput = z.infer<typeof fundJobInputSchema>;

export type FundingOperationStatus = 'CREATED' | 'PREPARED' | 'BROADCAST' | 'CONFIRMED';

export type FundEscrowCommand = {
  jobId: string;
  agreementHash: `0x${string}`;
  providerAddress?: `0x${string}`;
  amountBaseUnits: string;
  deadline: string;
};

export type PreparedFundingTransaction = {
  jobKey: `0x${string}`;
  transactionHash: `0x${string}`;
  serializedTransaction: `0x${string}`;
  contractAddress: `0x${string}`;
  signerAddress: `0x${string}`;
};

export type ConfirmedFunding = {
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

export interface EscrowGateway {
  readonly chainId: number;
  readonly contractAddress: `0x${string}`;
  readonly signerAddress: `0x${string}`;
  prepareFundJob(command: FundEscrowCommand): Promise<PreparedFundingTransaction>;
  broadcastPreparedFunding(prepared: PreparedFundingTransaction): Promise<`0x${string}`>;
  confirmFundJob(
    command: FundEscrowCommand,
    prepared: PreparedFundingTransaction,
  ): Promise<ConfirmedFunding>;
}

export type FundingOperation = {
  id: string;
  jobId: string;
  status: FundingOperationStatus;
  chainId: number;
  contractAddress: `0x${string}`;
  signerAddress: `0x${string}`;
  providerAddress: `0x${string}` | null;
  amountBaseUnits: string;
  deadline: string;
  agreementHash: `0x${string}`;
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

export type BeginFundingInput = {
  operation: FundingOperation;
  idempotency: IdempotencyClaim;
};

export type BeginFundingResult = {
  job: Job;
  operation: FundingOperation;
  replayed: boolean;
};

export type ConfirmFundingPersistenceInput = {
  operationId: string;
  confirmation: ConfirmedFunding;
  event: JobStateEvent;
};

export interface EscrowRepository {
  beginFunding(input: BeginFundingInput): Promise<BeginFundingResult>;
  savePrepared(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<FundingOperation>;
  markBroadcast(operationId: string, updatedAt: string): Promise<FundingOperation>;
  confirmFunding(input: ConfirmFundingPersistenceInput): Promise<BeginFundingResult>;
}

export type FundingServiceDependencies = {
  jobRepository: JobRepository;
  escrowRepository: EscrowRepository;
  gateway: EscrowGateway;
  maxPerJobBaseUnits: string;
  clock?: () => Date;
  idGenerator?: () => string;
  executor?: ExclusiveExecutor;
};

export type FundJobResult = {
  job: Job;
  operation: FundingOperation;
  replayed: boolean;
};

export class FundingService {
  readonly #jobRepository: JobRepository;
  readonly #escrowRepository: EscrowRepository;
  readonly #gateway: EscrowGateway;
  readonly #maxPerJobBaseUnits: bigint;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #executor: ExclusiveExecutor;

  public constructor(dependencies: FundingServiceDependencies) {
    this.#jobRepository = dependencies.jobRepository;
    this.#escrowRepository = dependencies.escrowRepository;
    this.#gateway = dependencies.gateway;
    this.#maxPerJobBaseUnits = BigInt(dependencies.maxPerJobBaseUnits);
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
    this.#executor = dependencies.executor ?? new InMemoryExclusiveExecutor();
  }

  public async fundJob(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<FundJobResult> {
    fundJobInputSchema.parse(rawInput ?? {});
    return this.#executor.runExclusive(async () => {
      const job = await this.#jobRepository.findById(jobId);
      if (job === null) {
        throw new JobNotFoundError(jobId);
      }
      if (BigInt(job.budgetAmountBaseUnits) > this.#maxPerJobBaseUnits) {
        throw new SpendingPolicyExceededError();
      }

      const now = this.#clock();
      const command: FundEscrowCommand = {
        jobId,
        agreementHash: job.agreementHash,
        amountBaseUnits: job.budgetAmountBaseUnits,
        deadline: job.agreement.deadline,
      };
      const idempotencyScope = `jobs:fund:${context.actor.id}:${jobId}`;
      const requestHash = sha256Commitment({ jobId });
      let result = await this.#escrowRepository.beginFunding({
        operation: {
          id: this.#idGenerator(),
          jobId,
          status: 'CREATED',
          chainId: this.#gateway.chainId,
          contractAddress: this.#gateway.contractAddress,
          signerAddress: this.#gateway.signerAddress,
          providerAddress: null,
          amountBaseUnits: job.budgetAmountBaseUnits,
          deadline: job.agreement.deadline,
          agreementHash: job.agreementHash,
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
      });

      if (result.operation.status === 'CONFIRMED') {
        return result;
      }

      try {
        if (result.operation.status === 'CREATED') {
          const prepared = await this.#gateway.prepareFundJob(command);
          result = {
            ...result,
            operation: await this.#escrowRepository.savePrepared(
              result.operation.id,
              prepared,
              this.#clock().toISOString(),
            ),
          };
        }

        const prepared = this.#requirePrepared(result.operation);
        await this.#gateway.broadcastPreparedFunding(prepared);
        if (result.operation.status === 'PREPARED') {
          result = {
            ...result,
            operation: await this.#escrowRepository.markBroadcast(
              result.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        const confirmation = await this.#gateway.confirmFundJob(command, prepared);
        return this.#escrowRepository.confirmFunding({
          operationId: result.operation.id,
          confirmation,
          event: {
            id: this.#idGenerator(),
            jobId,
            fromState: 'QUOTED',
            toState: 'FUNDED',
            actorType: context.actor.type,
            actorId: context.actor.id,
            reason: 'Native-asset escrow funded and contract state attested.',
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

  #requirePrepared(operation: FundingOperation): PreparedFundingTransaction {
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
