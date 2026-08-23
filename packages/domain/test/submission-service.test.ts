import { describe, expect, it } from 'vitest';

import {
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  ProviderNotAuthorizedError,
  StorageOperationFailedError,
  SubmissionService,
  type BeginSubmissionInput,
  type ConfirmSubmissionPersistenceInput,
  type CreateJobPersistenceResult,
  type EvidenceStorage,
  type Job,
  type JobRepository,
  type Submission,
  type SubmissionOperation,
  type SubmissionRepository,
  type SubmissionResult,
  type TransitionJobPersistenceResult,
} from '../src/index.js';

const hex = (character: string, bytes: number) =>
  `0x${character.repeat(bytes * 2)}` as `0x${string}`;

const assignedJob: Job = {
  id: '0198d462-75c0-7000-8000-000000000001',
  agreement: {
    jobId: '0198d462-75c0-7000-8000-000000000001',
    buyerAgentId: 'erc8004:16602:123',
    title: 'Implement transaction sorter',
    description: 'Implement the requested TypeScript function.',
    budget: { token: 'native', maxAmount: '2.00' },
    deadline: '2030-08-23T16:00:00.000Z',
    deliverable: { type: 'code', format: 'git_patch' },
    verification: {
      mode: 'deterministic',
      minimumScore: 1,
      requirements: ['All hidden tests must pass'],
    },
    refundPolicy: { onExpiry: true, onFinalFailure: true },
  },
  providerAgentId: 'erc8004:16602:456',
  agreementHash: hex('a', 32),
  budgetAmountBaseUnits: '2000000000000000000',
  minimumScoreBps: 10_000,
  state: 'ASSIGNED',
  version: 5,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:01.000Z',
};

class SubmissionJobRepository implements JobRepository {
  public constructor(public job: Job) {}

  public async findById(jobId: string): Promise<Job | null> {
    return jobId === this.job.id ? this.job : null;
  }

  public async create(): Promise<CreateJobPersistenceResult> {
    throw new Error('Not used by SubmissionService tests.');
  }

  public async transition(): Promise<TransitionJobPersistenceResult> {
    throw new Error('Not used by SubmissionService tests.');
  }

  public async ping(): Promise<void> {}
}

class MemorySubmissionRepository implements SubmissionRepository {
  readonly #operations = new Map<string, SubmissionOperation>();
  readonly #claims = new Map<string, { requestHash: string; operationId: string }>();
  #submission: Submission | null = null;

  public constructor(private readonly jobRepository: SubmissionJobRepository) {}

  public async beginSubmission(input: BeginSubmissionInput): Promise<SubmissionResult> {
    const key = `${input.idempotency.scope}:${input.idempotency.key}`;
    const claim = this.#claims.get(key);
    if (claim !== undefined) {
      if (claim.requestHash !== input.idempotency.requestHash) throw new IdempotencyKeyReusedError();
      return {
        job: this.jobRepository.job,
        operation: this.#operations.get(claim.operationId)!,
        submission: this.#submission,
        replayed: true,
      };
    }
    if (!['ASSIGNED', 'RETRY'].includes(this.jobRepository.job.state)) {
      throw new InvalidJobTransitionError(this.jobRepository.job.state, 'IN_PROGRESS');
    }
    this.jobRepository.job = {
      ...this.jobRepository.job,
      state: 'IN_PROGRESS',
      version: this.jobRepository.job.version + 1,
      updatedAt: input.startEvent.occurredAt,
    };
    this.#claims.set(key, {
      requestHash: input.idempotency.requestHash,
      operationId: input.operation.id,
    });
    this.#operations.set(input.operation.id, input.operation);
    return {
      job: this.jobRepository.job,
      operation: input.operation,
      submission: null,
      replayed: false,
    };
  }

  public async markStoring(
    operationId: string,
    updatedAt: string,
  ): Promise<SubmissionOperation> {
    return this.update(operationId, { status: 'STORING', updatedAt });
  }

  public async confirmSubmission(
    input: ConfirmSubmissionPersistenceInput,
  ): Promise<SubmissionResult> {
    const operation = this.update(input.operationId, {
      status: 'CONFIRMED',
      canonicalPayload: null,
      storageRootHash: input.storage.rootHash,
      storageTransactionHash: input.storage.transactionHash,
      storageTransactionSequence: input.storage.transactionSequence,
      updatedAt: input.event.occurredAt,
    });
    this.#submission = {
      id: operation.submissionId,
      jobId: operation.jobId,
      providerAgentId: operation.providerAgentId,
      submissionHash: operation.submissionHash,
      contentType: 'application/json',
      storageRootHash: input.storage.rootHash,
      storageTransactionHash: input.storage.transactionHash,
      storageTransactionSequence: input.storage.transactionSequence,
      sizeBytes: operation.sizeBytes,
      submittedAt: input.event.occurredAt,
    };
    this.jobRepository.job = {
      ...this.jobRepository.job,
      state: 'SUBMITTED',
      version: this.jobRepository.job.version + 1,
      updatedAt: input.event.occurredAt,
    };
    return {
      job: this.jobRepository.job,
      operation,
      submission: this.#submission,
      replayed: false,
    };
  }

  public async listByJob(jobId: string): Promise<Submission[]> {
    return this.#submission?.jobId === jobId ? [this.#submission] : [];
  }

  private update(
    operationId: string,
    patch: Partial<SubmissionOperation>,
  ): SubmissionOperation {
    const operation = { ...this.#operations.get(operationId)!, ...patch };
    this.#operations.set(operationId, operation);
    return operation;
  }
}

class MemoryEvidenceStorage implements EvidenceStorage {
  public calls = 0;
  public failNext = false;
  public readonly payloads: string[] = [];

  public async uploadVerified(data: Uint8Array) {
    this.calls += 1;
    this.payloads.push(new TextDecoder().decode(data));
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Indexer unavailable');
    }
    return {
      rootHash: hex('b', 32),
      transactionHash: hex('c', 32),
      transactionSequence: 9,
      sizeBytes: data.byteLength,
      verified: true as const,
    };
  }
}

function createService() {
  const jobRepository = new SubmissionJobRepository(assignedJob);
  const storage = new MemoryEvidenceStorage();
  let id = 0;
  const service = new SubmissionService({
    jobRepository,
    submissionRepository: new MemorySubmissionRepository(jobRepository),
    storage,
    maxPayloadBytes: 4_096,
    clock: () => new Date('2026-08-23T00:00:02.000Z'),
    idGenerator: () => `0198d462-75c0-7000-8000-${String(++id).padStart(12, '0')}`,
  });
  return { service, storage };
}

const context = {
  actor: { type: 'agent' as const, id: 'erc8004:16602:456' },
  idempotencyKey: 'submit-result-idempotency-001',
};

describe('SubmissionService', () => {
  it('stores a canonical manifest, confirms SUBMITTED, and replays without another upload', async () => {
    const { service, storage } = createService();
    const input = { result: { patch: 'diff --git a/file.ts b/file.ts', tests: ['pass'] } };

    const submitted = await service.submitResult(assignedJob.id, input, context);
    const replayed = await service.submitResult(assignedJob.id, input, context);

    expect(submitted.job.state).toBe('SUBMITTED');
    expect(submitted.submission).toMatchObject({
      providerAgentId: context.actor.id,
      storageRootHash: hex('b', 32),
    });
    expect(submitted.operation.canonicalPayload).toBeNull();
    expect(replayed.replayed).toBe(true);
    expect(storage.calls).toBe(1);
    expect(storage.payloads[0]).toContain('"contentType":"application/json"');
  });

  it('resumes the identical persisted manifest after a storage interruption', async () => {
    const { service, storage } = createService();
    storage.failNext = true;
    const input = { result: { answer: 42 } };

    await expect(service.submitResult(assignedJob.id, input, context)).rejects.toBeInstanceOf(
      StorageOperationFailedError,
    );
    const submitted = await service.submitResult(assignedJob.id, input, context);

    expect(submitted.job.state).toBe('SUBMITTED');
    expect(storage.payloads).toHaveLength(2);
    expect(storage.payloads[0]).toBe(storage.payloads[1]);
  });

  it('rejects an operator or a different agent before evidence storage', async () => {
    const { service, storage } = createService();

    await expect(
      service.submitResult(
        assignedJob.id,
        { result: { answer: 42 } },
        {
          actor: { type: 'operator', id: 'operator_test' },
          idempotencyKey: context.idempotencyKey,
        },
      ),
    ).rejects.toBeInstanceOf(ProviderNotAuthorizedError);
    expect(storage.calls).toBe(0);
  });
});
