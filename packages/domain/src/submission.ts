import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, sha256Bytes, sha256Commitment, type JsonValue } from './canonical.js';
import {
  DomainError,
  JobNotFoundError,
  ProviderNotAuthorizedError,
  StorageOperationFailedError,
  SubmissionTooLargeError,
} from './errors.js';
import { InMemoryExclusiveExecutor, type ExclusiveExecutor } from './exclusive-executor.js';
import type { Job, JobActor, JobStateEvent } from './job.js';
import type { IdempotencyClaim, JobRepository } from './job-repository.js';

export const submitResultInputSchema = z
  .object({
    result: z.json(),
  })
  .strict();

export type SubmitResultInput = z.infer<typeof submitResultInputSchema>;
export const submissionManifestSchema = z
  .object({
    version: z.literal('1'),
    submissionId: z.uuid(),
    jobId: z.uuid(),
    agreementHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    providerAgentId: z.string().regex(/^erc8004:\d+:\d+$/),
    deliverable: z
      .object({
        type: z.enum(['code', 'data', 'research', 'content', 'other']),
        format: z.string().min(1).max(100),
        contentType: z.literal('application/json'),
        result: z.json(),
      })
      .strict(),
    submittedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type SubmissionManifest = z.infer<typeof submissionManifestSchema>;
export type SubmissionOperationStatus = 'CREATED' | 'STORING' | 'CONFIRMED';

export type EvidenceStorageResult = {
  rootHash: `0x${string}`;
  transactionHash: `0x${string}` | null;
  transactionSequence: number;
  sizeBytes: number;
  verified: true;
};

export interface EvidenceStorage {
  uploadVerified(data: Uint8Array): Promise<EvidenceStorageResult>;
}

export interface EvidenceReader {
  downloadVerified(rootHash: string): Promise<Uint8Array>;
}

export interface EvidenceStore extends EvidenceStorage, EvidenceReader {}

export type SubmissionOperation = {
  id: string;
  submissionId: string;
  jobId: string;
  status: SubmissionOperationStatus;
  providerAgentId: string;
  canonicalPayload: string | null;
  submissionHash: `0x${string}`;
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

export type Submission = {
  id: string;
  jobId: string;
  providerAgentId: string;
  submissionHash: `0x${string}`;
  contentType: 'application/json';
  storageRootHash: `0x${string}`;
  storageTransactionHash: `0x${string}` | null;
  storageTransactionSequence: number;
  sizeBytes: number;
  submittedAt: string;
};

export type BeginSubmissionInput = {
  operation: SubmissionOperation;
  idempotency: IdempotencyClaim;
  startEvent: JobStateEvent;
};

export type SubmissionResult = {
  job: Job;
  operation: SubmissionOperation;
  submission: Submission | null;
  replayed: boolean;
};

export type ConfirmSubmissionPersistenceInput = {
  operationId: string;
  storage: EvidenceStorageResult;
  event: JobStateEvent;
};

export interface SubmissionRepository {
  beginSubmission(input: BeginSubmissionInput): Promise<SubmissionResult>;
  markStoring(operationId: string, updatedAt: string): Promise<SubmissionOperation>;
  confirmSubmission(input: ConfirmSubmissionPersistenceInput): Promise<SubmissionResult>;
  listByJob(jobId: string): Promise<Submission[]>;
}

export type SubmissionServiceDependencies = {
  jobRepository: JobRepository;
  submissionRepository: SubmissionRepository;
  storage: EvidenceStorage;
  maxPayloadBytes: number;
  executor?: ExclusiveExecutor;
  clock?: () => Date;
  idGenerator?: () => string;
};

export class SubmissionQueryService {
  public constructor(
    private readonly jobRepository: JobRepository,
    private readonly submissionRepository: SubmissionRepository,
  ) {}

  public async listSubmissions(jobId: string): Promise<Submission[]> {
    const job = await this.jobRepository.findById(jobId);
    if (job === null) throw new JobNotFoundError(jobId);
    return this.submissionRepository.listByJob(jobId);
  }
}

export class SubmissionService {
  readonly #jobRepository: JobRepository;
  readonly #repository: SubmissionRepository;
  readonly #storage: EvidenceStorage;
  readonly #maxPayloadBytes: number;
  readonly #executor: ExclusiveExecutor;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(dependencies: SubmissionServiceDependencies) {
    if (!Number.isSafeInteger(dependencies.maxPayloadBytes) || dependencies.maxPayloadBytes <= 0) {
      throw new TypeError('Submission payload limit must be a positive integer.');
    }
    this.#jobRepository = dependencies.jobRepository;
    this.#repository = dependencies.submissionRepository;
    this.#storage = dependencies.storage;
    this.#maxPayloadBytes = dependencies.maxPayloadBytes;
    this.#executor = dependencies.executor ?? new InMemoryExclusiveExecutor();
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  public async submitResult(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<SubmissionResult> {
    const input = submitResultInputSchema.parse(rawInput);
    return this.#executor.runExclusive(async () => {
      const job = await this.#jobRepository.findById(jobId);
      if (job === null) throw new JobNotFoundError(jobId);
      if (
        context.actor.type !== 'agent'
        || job.providerAgentId === null
        || context.actor.id !== job.providerAgentId
      ) {
        throw new ProviderNotAuthorizedError();
      }

      const now = this.#clock();
      const submissionId = this.#idGenerator();
      const manifest = {
        version: '1',
        submissionId,
        jobId,
        agreementHash: job.agreementHash,
        providerAgentId: context.actor.id,
        deliverable: {
          type: job.agreement.deliverable.type,
          format: job.agreement.deliverable.format,
          contentType: 'application/json',
          result: input.result as JsonValue,
        },
        submittedAt: now.toISOString(),
      } as const;
      const canonicalPayload = canonicalJson(manifest);
      const payloadBytes = new TextEncoder().encode(canonicalPayload);
      if (payloadBytes.byteLength > this.#maxPayloadBytes) {
        throw new SubmissionTooLargeError();
      }

      const idempotencyScope = `jobs:submit:${context.actor.id}:${jobId}`;
      const requestHash = sha256Commitment({ jobId, input: input as JsonValue });
      let result = await this.#repository.beginSubmission({
        operation: {
          id: this.#idGenerator(),
          submissionId,
          jobId,
          status: 'CREATED',
          providerAgentId: context.actor.id,
          canonicalPayload,
          submissionHash: sha256Bytes(payloadBytes),
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
        startEvent: {
          id: this.#idGenerator(),
          jobId,
          fromState: job.state,
          toState: 'IN_PROGRESS',
          actorType: context.actor.type,
          actorId: context.actor.id,
          reason: 'Assigned provider began delivering the agreed result.',
          occurredAt: now.toISOString(),
        },
      });
      if (result.operation.status === 'CONFIRMED') return result;

      try {
        if (result.operation.status === 'CREATED') {
          result = {
            ...result,
            operation: await this.#repository.markStoring(
              result.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        const persistedPayload = result.operation.canonicalPayload;
        if (persistedPayload === null) throw new StorageOperationFailedError();
        const storage = await this.#storage.uploadVerified(
          new TextEncoder().encode(persistedPayload),
        );
        if (storage.sizeBytes !== result.operation.sizeBytes) {
          throw new StorageOperationFailedError();
        }
        return this.#repository.confirmSubmission({
          operationId: result.operation.id,
          storage,
          event: {
            id: this.#idGenerator(),
            jobId,
            fromState: 'IN_PROGRESS',
            toState: 'SUBMITTED',
            actorType: context.actor.type,
            actorId: context.actor.id,
            reason: 'Provider result stored and proof-retrieved from 0G Storage.',
            ...(storage.transactionHash === null
              ? {}
              : { transactionHash: storage.transactionHash }),
            evidenceReference: `0g://${storage.rootHash}`,
            occurredAt: this.#clock().toISOString(),
          },
        });
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new StorageOperationFailedError();
      }
    });
  }

}
