import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { sha256Commitment } from './canonical.js';
import {
  ChainOperationFailedError,
  JobNotFoundError,
  JobNotSettleableError,
} from './errors.js';
import { InMemoryExclusiveExecutor, type ExclusiveExecutor } from './exclusive-executor.js';
import type { Job, JobActor, JobStateEvent } from './job.js';
import type { IdempotencyClaim, JobRepository } from './job-repository.js';
import type { SubmissionRepository } from './submission.js';
import type { VerificationRepository } from './verification.js';

export const settleJobInputSchema = z.object({}).strict();

export type FinalSettlementOutcome = 'PASS' | 'FAIL';
export type SettlementOperationStatus =
  | 'CREATED'
  | 'OUTCOME_PREPARED'
  | 'OUTCOME_BROADCAST'
  | 'OUTCOME_CONFIRMED'
  | 'ESCROW_PREPARED'
  | 'ESCROW_BROADCAST'
  | 'CONFIRMED';

export type PreparedSettlementTransaction = {
  jobKey: `0x${string}`;
  transactionHash: `0x${string}`;
  serializedTransaction: `0x${string}`;
  contractAddress: `0x${string}`;
  signerAddress: `0x${string}`;
};

export type SettlementCommitments = {
  jobId: string;
  agreementHash: `0x${string}`;
  submissionHash: `0x${string}`;
  verificationReportHash: `0x${string}`;
  buyerAgentId: string;
  providerAgentId: string;
  outcome: FinalSettlementOutcome;
};

export interface OutcomeAnchorGateway {
  prepareRecordOutcome(command: SettlementCommitments): Promise<PreparedSettlementTransaction>;
  broadcastPreparedOutcome(prepared: PreparedSettlementTransaction): Promise<`0x${string}`>;
  confirmRecordOutcome(
    command: SettlementCommitments,
    prepared: PreparedSettlementTransaction,
  ): Promise<{ transactionHash: `0x${string}`; blockNumber: string }>;
}

export interface EscrowFinalizationGateway {
  prepareSettle(command: {
    jobId: string;
    verificationReportHash: `0x${string}`;
  }): Promise<PreparedSettlementTransaction>;
  prepareFailedRefund(command: {
    jobId: string;
    verificationReportHash: `0x${string}`;
  }): Promise<PreparedSettlementTransaction>;
  broadcastPreparedTransaction(prepared: PreparedSettlementTransaction): Promise<`0x${string}`>;
  confirmSettle(
    command: { jobId: string; verificationReportHash: `0x${string}` },
    prepared: PreparedSettlementTransaction,
  ): Promise<{ transactionHash: `0x${string}`; blockNumber: string }>;
  confirmFailedRefund(
    command: { jobId: string; verificationReportHash: `0x${string}` },
    prepared: PreparedSettlementTransaction,
  ): Promise<{ transactionHash: `0x${string}`; blockNumber: string }>;
}

export type SettlementOperation = {
  id: string;
  jobId: string;
  submissionId: string;
  verificationRunId: string;
  outcome: FinalSettlementOutcome;
  status: SettlementOperationStatus;
  agreementHash: `0x${string}`;
  submissionHash: `0x${string}`;
  verificationReportHash: `0x${string}`;
  buyerAgentId: string;
  providerAgentId: string;
  jobKey: `0x${string}` | null;
  outcomeContractAddress: `0x${string}` | null;
  outcomeSerializedTransaction: `0x${string}` | null;
  outcomeTransactionHash: `0x${string}` | null;
  outcomeBlockNumber: string | null;
  escrowContractAddress: `0x${string}` | null;
  escrowSerializedTransaction: `0x${string}` | null;
  escrowTransactionHash: `0x${string}` | null;
  escrowBlockNumber: string | null;
  signerAddress: `0x${string}` | null;
  idempotencyScope: string;
  idempotencyKey: string;
  requestHash: `0x${string}`;
  createdAt: string;
  updatedAt: string;
};

export type FinalizationRecord = {
  jobId: string;
  kind: 'PAYMENT' | 'REFUND';
  amountBaseUnits: string;
  outcomeTransactionHash: `0x${string}`;
  outcomeBlockNumber: string;
  escrowTransactionHash: `0x${string}`;
  escrowBlockNumber: string;
  finalizedAt: string;
};

export type SettlementPersistenceResult = {
  job: Job;
  operation: SettlementOperation;
  finalization: FinalizationRecord | null;
  replayed: boolean;
};

export type BeginSettlementInput = {
  operation: SettlementOperation;
  idempotency: IdempotencyClaim;
  startEvent: JobStateEvent;
};

export interface SettlementRepository {
  findByIdempotency(
    scope: string,
    key: string,
  ): Promise<SettlementPersistenceResult | null>;
  beginSettlement(input: BeginSettlementInput): Promise<SettlementPersistenceResult>;
  saveOutcomePrepared(
    operationId: string,
    prepared: PreparedSettlementTransaction,
    updatedAt: string,
  ): Promise<SettlementOperation>;
  markOutcomeBroadcast(operationId: string, updatedAt: string): Promise<SettlementOperation>;
  confirmOutcome(
    operationId: string,
    transactionHash: `0x${string}`,
    blockNumber: string,
    updatedAt: string,
  ): Promise<SettlementOperation>;
  saveEscrowPrepared(
    operationId: string,
    prepared: PreparedSettlementTransaction,
    updatedAt: string,
  ): Promise<SettlementOperation>;
  markEscrowBroadcast(operationId: string, updatedAt: string): Promise<SettlementOperation>;
  confirmSettlement(input: {
    operationId: string;
    transactionHash: `0x${string}`;
    blockNumber: string;
    event: JobStateEvent;
  }): Promise<SettlementPersistenceResult>;
}

export class SettlementService {
  readonly #jobRepository: JobRepository;
  readonly #submissionRepository: SubmissionRepository;
  readonly #verificationRepository: VerificationRepository;
  readonly #settlementRepository: SettlementRepository;
  readonly #outcomeGateway: OutcomeAnchorGateway;
  readonly #escrowGateway: EscrowFinalizationGateway;
  readonly #executor: ExclusiveExecutor;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(dependencies: {
    jobRepository: JobRepository;
    submissionRepository: SubmissionRepository;
    verificationRepository: VerificationRepository;
    settlementRepository: SettlementRepository;
    outcomeGateway: OutcomeAnchorGateway;
    escrowGateway: EscrowFinalizationGateway;
    executor?: ExclusiveExecutor;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.#jobRepository = dependencies.jobRepository;
    this.#submissionRepository = dependencies.submissionRepository;
    this.#verificationRepository = dependencies.verificationRepository;
    this.#settlementRepository = dependencies.settlementRepository;
    this.#outcomeGateway = dependencies.outcomeGateway;
    this.#escrowGateway = dependencies.escrowGateway;
    this.#executor = dependencies.executor ?? new InMemoryExclusiveExecutor();
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  public async settleJob(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<SettlementPersistenceResult> {
    settleJobInputSchema.parse(rawInput);
    return this.#executor.runExclusive(async () => {
      const job = await this.#jobRepository.findById(jobId);
      if (job === null) throw new JobNotFoundError(jobId);
      const idempotencyScope = `jobs:settle:${context.actor.id}:${jobId}`;
      const existing = await this.#settlementRepository.findByIdempotency(
        idempotencyScope,
        context.idempotencyKey,
      );
      if (existing?.operation.status === 'CONFIRMED') {
        return { ...existing, replayed: true };
      }
      const submissions = await this.#submissionRepository.listByJob(jobId);
      const verifications = await this.#verificationRepository.listByJob(jobId);
      const submission = submissions.at(-1);
      const verification = verifications.at(-1);
      if (
        submission === undefined
        || verification === undefined
        || job.providerAgentId === null
        || verification.submissionId !== submission.id
      ) {
        throw new JobNotSettleableError();
      }
      const outcome: FinalSettlementOutcome = verification.outcome === 'PASS'
        ? 'PASS'
        : verification.outcome === 'FAIL'
          ? 'FAIL'
          : (() => { throw new JobNotSettleableError(); })();
      if (outcome === 'FAIL' && !job.agreement.refundPolicy.onFinalFailure) {
        throw new JobNotSettleableError();
      }

      const now = this.#clock();
      const requestHash = sha256Commitment({
        jobId,
        verificationRunId: verification.runId,
        outcome,
      });
      let persisted = await this.#settlementRepository.beginSettlement({
        operation: {
          id: this.#idGenerator(),
          jobId,
          submissionId: submission.id,
          verificationRunId: verification.runId,
          outcome,
          status: 'CREATED',
          agreementHash: job.agreementHash,
          submissionHash: submission.submissionHash,
          verificationReportHash: verification.reportHash,
          buyerAgentId: job.agreement.buyerAgentId,
          providerAgentId: job.providerAgentId,
          jobKey: null,
          outcomeContractAddress: null,
          outcomeSerializedTransaction: null,
          outcomeTransactionHash: null,
          outcomeBlockNumber: null,
          escrowContractAddress: null,
          escrowSerializedTransaction: null,
          escrowTransactionHash: null,
          escrowBlockNumber: null,
          signerAddress: null,
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
        startEvent: {
          id: this.#idGenerator(),
          jobId,
          fromState: outcome === 'PASS' ? 'PASSED' : 'FAILED',
          toState: outcome === 'PASS' ? 'SETTLING' : 'FAILED_FINAL',
          actorType: context.actor.type,
          actorId: context.actor.id,
          reason: outcome === 'PASS'
            ? 'Verified payment settlement started.'
            : 'Final verification failure accepted for refund.',
          evidenceReference: `0g://${verification.reportStorageRootHash}`,
          occurredAt: now.toISOString(),
        },
      });
      if (persisted.operation.status === 'CONFIRMED') return persisted;

      const commitments: SettlementCommitments = {
        jobId,
        agreementHash: persisted.operation.agreementHash,
        submissionHash: persisted.operation.submissionHash,
        verificationReportHash: persisted.operation.verificationReportHash,
        buyerAgentId: persisted.operation.buyerAgentId,
        providerAgentId: persisted.operation.providerAgentId,
        outcome: persisted.operation.outcome,
      };
      try {
        if (persisted.operation.status === 'CREATED') {
          const prepared = await this.#outcomeGateway.prepareRecordOutcome(commitments);
          persisted = {
            ...persisted,
            operation: await this.#settlementRepository.saveOutcomePrepared(
              persisted.operation.id,
              prepared,
              this.#clock().toISOString(),
            ),
          };
        }
        if (persisted.operation.status === 'OUTCOME_PREPARED') {
          await this.#outcomeGateway.broadcastPreparedOutcome(this.#outcomePrepared(persisted.operation));
          persisted = {
            ...persisted,
            operation: await this.#settlementRepository.markOutcomeBroadcast(
              persisted.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        if (persisted.operation.status === 'OUTCOME_BROADCAST') {
          const confirmed = await this.#outcomeGateway.confirmRecordOutcome(
            commitments,
            this.#outcomePrepared(persisted.operation),
          );
          persisted = {
            ...persisted,
            operation: await this.#settlementRepository.confirmOutcome(
              persisted.operation.id,
              confirmed.transactionHash,
              confirmed.blockNumber,
              this.#clock().toISOString(),
            ),
          };
        }
        const escrowCommand = {
          jobId,
          verificationReportHash: persisted.operation.verificationReportHash,
        };
        if (persisted.operation.status === 'OUTCOME_CONFIRMED') {
          const prepared = persisted.operation.outcome === 'PASS'
            ? await this.#escrowGateway.prepareSettle(escrowCommand)
            : await this.#escrowGateway.prepareFailedRefund(escrowCommand);
          persisted = {
            ...persisted,
            operation: await this.#settlementRepository.saveEscrowPrepared(
              persisted.operation.id,
              prepared,
              this.#clock().toISOString(),
            ),
          };
        }
        if (persisted.operation.status === 'ESCROW_PREPARED') {
          await this.#escrowGateway.broadcastPreparedTransaction(this.#escrowPrepared(persisted.operation));
          persisted = {
            ...persisted,
            operation: await this.#settlementRepository.markEscrowBroadcast(
              persisted.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        if (persisted.operation.status !== 'ESCROW_BROADCAST') throw new ChainOperationFailedError();
        const finalized = persisted.operation.outcome === 'PASS'
          ? await this.#escrowGateway.confirmSettle(escrowCommand, this.#escrowPrepared(persisted.operation))
          : await this.#escrowGateway.confirmFailedRefund(
              escrowCommand,
              this.#escrowPrepared(persisted.operation),
            );
        return this.#settlementRepository.confirmSettlement({
          operationId: persisted.operation.id,
          transactionHash: finalized.transactionHash,
          blockNumber: finalized.blockNumber,
          event: {
            id: this.#idGenerator(),
            jobId,
            fromState: persisted.operation.outcome === 'PASS' ? 'SETTLING' : 'FAILED_FINAL',
            toState: persisted.operation.outcome === 'PASS' ? 'PAID' : 'REFUNDED',
            actorType: 'service',
            actorId: 'agentclear-settlement-v1',
            reason: persisted.operation.outcome === 'PASS'
              ? 'Escrow released after verified PASS.'
              : 'Escrow refunded after final verified FAIL.',
            transactionHash: finalized.transactionHash,
            evidenceReference: `0g://${verification.reportStorageRootHash}`,
            occurredAt: this.#clock().toISOString(),
          },
        });
      } catch (error) {
        if (error instanceof ChainOperationFailedError) throw error;
        throw new ChainOperationFailedError();
      }
    });
  }

  #outcomePrepared(operation: SettlementOperation): PreparedSettlementTransaction {
    if (
      operation.outcomeContractAddress === null
      || operation.outcomeSerializedTransaction === null
      || operation.outcomeTransactionHash === null
      || operation.signerAddress === null
    ) throw new ChainOperationFailedError();
    return {
      jobKey: operation.jobKey ?? (() => { throw new ChainOperationFailedError(); })(),
      contractAddress: operation.outcomeContractAddress,
      serializedTransaction: operation.outcomeSerializedTransaction,
      transactionHash: operation.outcomeTransactionHash,
      signerAddress: operation.signerAddress,
    };
  }

  #escrowPrepared(operation: SettlementOperation): PreparedSettlementTransaction {
    if (
      operation.escrowContractAddress === null
      || operation.escrowSerializedTransaction === null
      || operation.escrowTransactionHash === null
      || operation.signerAddress === null
    ) throw new ChainOperationFailedError();
    return {
      jobKey: operation.jobKey ?? (() => { throw new ChainOperationFailedError(); })(),
      contractAddress: operation.escrowContractAddress,
      serializedTransaction: operation.escrowSerializedTransaction,
      transactionHash: operation.escrowTransactionHash,
      signerAddress: operation.signerAddress,
    };
  }
}
