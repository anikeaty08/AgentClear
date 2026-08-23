import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, sha256Bytes, sha256Commitment, type JsonValue } from './canonical.js';
import {
  DomainError,
  JobNotReceiptableError,
  ReceiptIntegrityFailedError,
  ReceiptNotFoundError,
  ReceiptTooLargeError,
  StorageOperationFailedError,
} from './errors.js';
import { InMemoryExclusiveExecutor, type ExclusiveExecutor } from './exclusive-executor.js';
import type { Job, JobActor } from './job.js';
import type { IdempotencyClaim } from './job-repository.js';
import type { ReputationEvent } from './reputation.js';
import type { FinalizationRecord, SettlementOperation } from './settlement.js';
import type { EvidenceStorage, EvidenceStorageResult, Submission } from './submission.js';
import type { VerificationRecord } from './verification.js';

const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const unsignedIntegerSchema = z.string().regex(/^\d+$/);
const agentIdSchema = z.string().regex(/^erc8004:\d+:\d+$/);

export const publishReceiptInputSchema = z.object({}).strict();
export const portableReceiptSchema = z
  .object({
    version: z.literal('1'),
    receiptId: z.uuid(),
    jobId: z.uuid(),
    agreementHash: hashSchema,
    buyerAgent: agentIdSchema,
    providerAgent: agentIdSchema,
    submission: z.object({
      id: z.uuid(),
      hash: hashSchema,
      storageRef: z.string().startsWith('0g://'),
      storageTransactionHash: hashSchema.nullable(),
      storageTransactionSequence: z.number().int().nonnegative(),
      sizeBytes: z.number().int().positive(),
      submittedAt: z.iso.datetime({ offset: true }),
    }).strict(),
    verification: z.object({
      runId: z.uuid(),
      outcome: z.enum(['PASS', 'FAIL']),
      scoreBps: z.number().int().min(0).max(10_000),
      minimumScoreBps: z.number().int().min(0).max(10_000),
      verifierVersion: z.string().min(1).max(100),
      reportHash: hashSchema,
      reportRoot: hashSchema,
      storageRef: z.string().startsWith('0g://'),
      storageTransactionHash: hashSchema.nullable(),
      storageTransactionSequence: z.number().int().nonnegative(),
      completedAt: z.iso.datetime({ offset: true }),
    }).strict(),
    outcome: z.object({
      registry: addressSchema,
      transactionHash: hashSchema,
      blockNumber: unsignedIntegerSchema,
    }).strict(),
    settlement: z.object({
      kind: z.enum(['PAYMENT', 'REFUND']),
      amountBaseUnits: unsignedIntegerSchema,
      token: z.literal('native'),
      escrowContract: addressSchema,
      transactionHash: hashSchema,
      blockNumber: unsignedIntegerSchema,
      finalizedAt: z.iso.datetime({ offset: true }),
    }).strict(),
    reputation: z.object({
      registry: addressSchema,
      identityRegistry: addressSchema,
      agentTokenId: unsignedIntegerSchema,
      clientAddress: addressSchema,
      value: z.string().regex(/^-?\d+$/),
      valueDecimals: z.number().int().min(0).max(18),
      tag1: z.string().min(1).max(100),
      tag2: z.string().min(1).max(100),
      feedbackUri: z.string().min(1),
      feedbackHash: hashSchema,
      transactionHash: hashSchema,
      blockNumber: unsignedIntegerSchema,
      feedbackIndex: unsignedIntegerSchema,
    }).strict(),
    finalizedAt: z.iso.datetime({ offset: true }),
    issuedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type PortableReceipt = z.infer<typeof portableReceiptSchema>;
export type ReceiptOperationStatus = 'CREATED' | 'STORING' | 'CONFIRMED';

export type ReceiptSource = {
  job: Job;
  submission: Submission;
  verification: Omit<VerificationRecord, 'checks'>;
  settlementOperation: SettlementOperation;
  finalization: FinalizationRecord;
  reputation: ReputationEvent;
};

export type ReceiptOperation = {
  id: string;
  receiptId: string;
  jobId: string;
  status: ReceiptOperationStatus;
  canonicalPayload: string | null;
  receiptHash: `0x${string}`;
  storageRootHash: `0x${string}` | null;
  storageTransactionHash: `0x${string}` | null;
  storageTransactionSequence: number | null;
  sizeBytes: number;
  idempotencyScope: string;
  idempotencyKey: string;
  requestHash: `0x${string}`;
  createdAt: string;
  updatedAt: string;
};

export type ReceiptRecord = {
  id: string;
  jobId: string;
  version: '1';
  receiptHash: `0x${string}`;
  receipt: PortableReceipt;
  canonicalPayload: string;
  storageRootHash: `0x${string}`;
  storageTransactionHash: `0x${string}` | null;
  storageTransactionSequence: number;
  sizeBytes: number;
  publishedAt: string;
};

export type ReceiptPersistenceResult = {
  operation: ReceiptOperation;
  receipt: ReceiptRecord | null;
  replayed: boolean;
};

export interface ReceiptRepository {
  findSource(jobId: string): Promise<ReceiptSource | null>;
  findByIdempotency(scope: string, key: string): Promise<ReceiptPersistenceResult | null>;
  beginReceipt(input: {
    operation: ReceiptOperation;
    idempotency: IdempotencyClaim;
  }): Promise<ReceiptPersistenceResult>;
  markStoring(operationId: string, updatedAt: string): Promise<ReceiptOperation>;
  confirmReceipt(input: {
    operationId: string;
    receipt: PortableReceipt;
    storage: EvidenceStorageResult;
    publishedAt: string;
  }): Promise<ReceiptPersistenceResult>;
  findById(receiptId: string): Promise<ReceiptRecord | null>;
  findByJob(jobId: string): Promise<ReceiptRecord | null>;
}

export class ReceiptService {
  readonly #repository: ReceiptRepository;
  readonly #storage: EvidenceStorage;
  readonly #maxPayloadBytes: number;
  readonly #executor: ExclusiveExecutor;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(dependencies: {
    repository: ReceiptRepository;
    storage: EvidenceStorage;
    maxPayloadBytes: number;
    executor?: ExclusiveExecutor;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    if (!Number.isSafeInteger(dependencies.maxPayloadBytes) || dependencies.maxPayloadBytes <= 0) {
      throw new TypeError('Receipt payload limit must be a positive integer.');
    }
    this.#repository = dependencies.repository;
    this.#storage = dependencies.storage;
    this.#maxPayloadBytes = dependencies.maxPayloadBytes;
    this.#executor = dependencies.executor ?? new InMemoryExclusiveExecutor();
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  public async publishJob(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<ReceiptPersistenceResult> {
    publishReceiptInputSchema.parse(rawInput);
    return this.#executor.runExclusive(async () => {
      const idempotencyScope = `jobs:receipt:${context.actor.id}:${jobId}`;
      const existing = await this.#repository.findByIdempotency(
        idempotencyScope,
        context.idempotencyKey,
      );
      if (existing?.operation.status === 'CONFIRMED') {
        if (existing.receipt === null) throw new ReceiptIntegrityFailedError();
        this.#assertRecord(existing.receipt);
        return { ...existing, replayed: true };
      }

      let persisted = existing;
      if (persisted === null) {
        const source = await this.#repository.findSource(jobId);
        if (source === null) throw new JobNotReceiptableError();
        this.#assertSource(source);
        const now = this.#clock();
        const receipt = this.#buildReceipt(this.#idGenerator(), source, now.toISOString());
        const canonicalPayload = canonicalJson(receipt as JsonValue);
        const payloadBytes = new TextEncoder().encode(canonicalPayload);
        if (payloadBytes.byteLength > this.#maxPayloadBytes) throw new ReceiptTooLargeError();
        const requestHash = sha256Commitment({ jobId, version: '1' });
        persisted = await this.#repository.beginReceipt({
          operation: {
            id: this.#idGenerator(),
            receiptId: receipt.receiptId,
            jobId,
            status: 'CREATED',
            canonicalPayload,
            receiptHash: sha256Bytes(payloadBytes),
            storageRootHash: null,
            storageTransactionHash: null,
            storageTransactionSequence: null,
            sizeBytes: payloadBytes.byteLength,
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
      }
      if (persisted.operation.status === 'CONFIRMED') {
        if (persisted.receipt === null) throw new ReceiptIntegrityFailedError();
        this.#assertRecord(persisted.receipt);
        return persisted;
      }

      try {
        if (persisted.operation.status === 'CREATED') {
          persisted = {
            ...persisted,
            operation: await this.#repository.markStoring(
              persisted.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        const canonicalPayload = persisted.operation.canonicalPayload;
        if (canonicalPayload === null) throw new ReceiptIntegrityFailedError();
        const payloadBytes = new TextEncoder().encode(canonicalPayload);
        if (
          payloadBytes.byteLength !== persisted.operation.sizeBytes
          || sha256Bytes(payloadBytes).toLowerCase()
            !== persisted.operation.receiptHash.toLowerCase()
        ) throw new ReceiptIntegrityFailedError();
        let rawReceipt: unknown;
        try {
          rawReceipt = JSON.parse(canonicalPayload);
        } catch {
          throw new ReceiptIntegrityFailedError();
        }
        const parsed = portableReceiptSchema.safeParse(rawReceipt);
        if (
          !parsed.success
          || parsed.data.receiptId !== persisted.operation.receiptId
          || parsed.data.jobId !== jobId
        ) throw new ReceiptIntegrityFailedError();
        const storage = await this.#storage.uploadVerified(payloadBytes);
        if (storage.sizeBytes !== payloadBytes.byteLength) throw new StorageOperationFailedError();
        const confirmed = await this.#repository.confirmReceipt({
          operationId: persisted.operation.id,
          receipt: parsed.data,
          storage,
          publishedAt: this.#clock().toISOString(),
        });
        if (confirmed.receipt === null) throw new ReceiptIntegrityFailedError();
        this.#assertRecord(confirmed.receipt);
        return confirmed;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new StorageOperationFailedError();
      }
    });
  }

  public async getReceipt(receiptId: string): Promise<ReceiptRecord> {
    const receipt = await this.#repository.findById(receiptId);
    if (receipt === null) throw new ReceiptNotFoundError(receiptId);
    this.#assertRecord(receipt);
    return receipt;
  }

  public async getReceiptForJob(jobId: string): Promise<ReceiptRecord> {
    const receipt = await this.#repository.findByJob(jobId);
    if (receipt === null) throw new ReceiptNotFoundError(jobId);
    this.#assertRecord(receipt);
    return receipt;
  }

  #assertRecord(record: ReceiptRecord): void {
    const payloadBytes = new TextEncoder().encode(record.canonicalPayload);
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.canonicalPayload);
    } catch {
      throw new ReceiptIntegrityFailedError();
    }
    const payloadReceipt = portableReceiptSchema.safeParse(parsed);
    if (
      !payloadReceipt.success
      || record.id !== record.receipt.receiptId
      || record.jobId !== record.receipt.jobId
      || record.version !== record.receipt.version
      || payloadReceipt.data.receiptId !== record.id
      || payloadReceipt.data.jobId !== record.jobId
      || canonicalJson(record.receipt as JsonValue) !== record.canonicalPayload
      || payloadBytes.byteLength !== record.sizeBytes
      || sha256Bytes(payloadBytes).toLowerCase() !== record.receiptHash.toLowerCase()
    ) throw new ReceiptIntegrityFailedError();
  }

  #assertSource(source: ReceiptSource): void {
    const expectedOutcome = source.job.state === 'PAID'
      ? 'PASS'
      : source.job.state === 'REFUNDED'
        ? 'FAIL'
        : null;
    if (
      expectedOutcome === null
      || source.job.providerAgentId === null
      || source.submission.jobId !== source.job.id
      || source.submission.providerAgentId !== source.job.providerAgentId
      || source.verification.jobId !== source.job.id
      || source.verification.submissionId !== source.submission.id
      || source.verification.outcome !== expectedOutcome
      || source.settlementOperation.status !== 'CONFIRMED'
      || source.settlementOperation.jobId !== source.job.id
      || source.settlementOperation.submissionId !== source.submission.id
      || source.settlementOperation.verificationRunId !== source.verification.runId
      || source.settlementOperation.outcome !== expectedOutcome
      || source.settlementOperation.agreementHash.toLowerCase()
        !== source.job.agreementHash.toLowerCase()
      || source.settlementOperation.submissionHash.toLowerCase()
        !== source.submission.submissionHash.toLowerCase()
      || source.settlementOperation.verificationReportHash.toLowerCase()
        !== source.verification.reportHash.toLowerCase()
      || source.settlementOperation.outcomeContractAddress === null
      || source.settlementOperation.outcomeTransactionHash === null
      || source.settlementOperation.outcomeBlockNumber === null
      || source.settlementOperation.escrowContractAddress === null
      || source.settlementOperation.escrowTransactionHash === null
      || source.settlementOperation.escrowBlockNumber === null
      || source.finalization.jobId !== source.job.id
      || source.finalization.kind !== (expectedOutcome === 'PASS' ? 'PAYMENT' : 'REFUND')
      || source.finalization.outcomeTransactionHash.toLowerCase()
        !== source.settlementOperation.outcomeTransactionHash.toLowerCase()
      || source.finalization.escrowTransactionHash.toLowerCase()
        !== source.settlementOperation.escrowTransactionHash.toLowerCase()
      || source.reputation.jobId !== source.job.id
      || source.reputation.providerAgentId !== source.job.providerAgentId
      || source.reputation.value !== (expectedOutcome === 'PASS' ? '100' : '0')
      || source.reputation.valueDecimals !== 0
      || source.reputation.feedbackUri !== `0g://${source.verification.reportStorageRootHash}`
    ) throw new JobNotReceiptableError();
  }

  #buildReceipt(receiptId: string, source: ReceiptSource, issuedAt: string): PortableReceipt {
    const settlementOperation = source.settlementOperation;
    if (
      source.job.providerAgentId === null
      || settlementOperation.outcomeContractAddress === null
      || settlementOperation.outcomeTransactionHash === null
      || settlementOperation.outcomeBlockNumber === null
      || settlementOperation.escrowContractAddress === null
      || settlementOperation.escrowTransactionHash === null
      || settlementOperation.escrowBlockNumber === null
    ) throw new JobNotReceiptableError();
    return portableReceiptSchema.parse({
      version: '1',
      receiptId,
      jobId: source.job.id,
      agreementHash: source.job.agreementHash,
      buyerAgent: source.job.agreement.buyerAgentId,
      providerAgent: source.job.providerAgentId,
      submission: {
        id: source.submission.id,
        hash: source.submission.submissionHash,
        storageRef: `0g://${source.submission.storageRootHash}`,
        storageTransactionHash: source.submission.storageTransactionHash,
        storageTransactionSequence: source.submission.storageTransactionSequence,
        sizeBytes: source.submission.sizeBytes,
        submittedAt: source.submission.submittedAt,
      },
      verification: {
        runId: source.verification.runId,
        outcome: source.verification.outcome,
        scoreBps: source.verification.scoreBps,
        minimumScoreBps: source.verification.minimumScoreBps,
        verifierVersion: source.verification.verifierVersion,
        reportHash: source.verification.reportHash,
        reportRoot: source.verification.reportStorageRootHash,
        storageRef: `0g://${source.verification.reportStorageRootHash}`,
        storageTransactionHash: source.verification.reportStorageTransactionHash,
        storageTransactionSequence: source.verification.reportStorageTransactionSequence,
        completedAt: source.verification.completedAt,
      },
      outcome: {
        registry: settlementOperation.outcomeContractAddress,
        transactionHash: settlementOperation.outcomeTransactionHash,
        blockNumber: settlementOperation.outcomeBlockNumber,
      },
      settlement: {
        kind: source.finalization.kind,
        amountBaseUnits: source.finalization.amountBaseUnits,
        token: source.job.agreement.budget.token,
        escrowContract: settlementOperation.escrowContractAddress,
        transactionHash: settlementOperation.escrowTransactionHash,
        blockNumber: settlementOperation.escrowBlockNumber,
        finalizedAt: source.finalization.finalizedAt,
      },
      reputation: {
        registry: source.reputation.registryAddress,
        identityRegistry: source.reputation.identityRegistryAddress,
        agentTokenId: source.reputation.agentTokenId,
        clientAddress: source.reputation.clientAddress,
        value: source.reputation.value,
        valueDecimals: source.reputation.valueDecimals,
        tag1: source.reputation.tag1,
        tag2: source.reputation.tag2,
        feedbackUri: source.reputation.feedbackUri,
        feedbackHash: source.reputation.feedbackHash,
        transactionHash: source.reputation.transactionHash,
        blockNumber: source.reputation.blockNumber,
        feedbackIndex: source.reputation.feedbackIndex,
      },
      finalizedAt: source.finalization.finalizedAt,
      issuedAt,
    });
  }
}
