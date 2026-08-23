import { describe, expect, it } from 'vitest';

import {
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobDeadlineNotFutureError,
  JobService,
  type CreateJobPersistenceInput,
  type CreateJobPersistenceResult,
  type Job,
  type JobRepository,
  type TransitionJobPersistenceInput,
  type TransitionJobPersistenceResult,
} from '../src/index.js';

class MemoryJobRepository implements JobRepository {
  readonly #jobs = new Map<string, Job>();
  readonly #claims = new Map<string, { requestHash: string; resourceId: string }>();

  public async create(input: CreateJobPersistenceInput): Promise<CreateJobPersistenceResult> {
    const claimKey = `${input.idempotency.scope}:${input.idempotency.key}`;
    const existingClaim = this.#claims.get(claimKey);
    if (existingClaim !== undefined) {
      if (existingClaim.requestHash !== input.idempotency.requestHash) {
        throw new IdempotencyKeyReusedError();
      }
      return { job: this.#jobs.get(existingClaim.resourceId)!, replayed: true };
    }

    this.#claims.set(claimKey, {
      requestHash: input.idempotency.requestHash,
      resourceId: input.job.id,
    });
    this.#jobs.set(input.job.id, input.job);
    return { job: input.job, replayed: false };
  }

  public async findById(jobId: string): Promise<Job | null> {
    return this.#jobs.get(jobId) ?? null;
  }

  public async transition(
    input: TransitionJobPersistenceInput,
  ): Promise<TransitionJobPersistenceResult> {
    const claimKey = `${input.idempotency.scope}:${input.idempotency.key}`;
    const existingClaim = this.#claims.get(claimKey);
    if (existingClaim !== undefined) {
      if (existingClaim.requestHash !== input.idempotency.requestHash) {
        throw new IdempotencyKeyReusedError();
      }
      return { job: this.#jobs.get(existingClaim.resourceId)!, replayed: true };
    }
    const job = this.#jobs.get(input.jobId)!;
    if (job.state !== input.expectedState) {
      throw new InvalidJobTransitionError(job.state, input.nextState);
    }
    const updated = {
      ...job,
      state: input.nextState,
      version: job.version + 1,
      updatedAt: input.event.occurredAt,
    };
    this.#claims.set(claimKey, {
      requestHash: input.idempotency.requestHash,
      resourceId: input.jobId,
    });
    this.#jobs.set(input.jobId, updated);
    return { job: updated, replayed: false };
  }

  public async ping(): Promise<void> {}
}

const validInput = {
  buyerAgentId: 'erc8004:16602:123',
  title: 'Implement transaction sorter',
  description: 'Implement the requested TypeScript function.',
  budget: { token: 'native', maxAmount: '2.00' },
  deadline: '2030-08-23T16:00:00.000Z',
  deliverable: { type: 'code', format: 'git_patch' },
  verification: {
    mode: 'deterministic_plus_ai',
    minimumScore: 0.9,
    requirements: ['All hidden tests must pass'],
  },
  refundPolicy: { onExpiry: true, onFinalFailure: true },
} as const;

describe('JobService', () => {
  it('creates a canonical agreement with a lossless base-unit budget', async () => {
    const repository = new MemoryJobRepository();
    const service = new JobService({
      repository,
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
      idGenerator: (() => {
        const ids = [
          '0198d462-75c0-7000-8000-000000000001',
          '0198d462-75c0-7000-8000-000000000002',
        ];
        return () => ids.shift()!;
      })(),
    });

    const result = await service.createJob(validInput, {
      actor: { type: 'agent', id: validInput.buyerAgentId },
      idempotencyKey: 'idem-create-001',
    });

    expect(result.replayed).toBe(false);
    expect(result.job.state).toBe('DRAFT');
    expect(result.job.budgetAmountBaseUnits).toBe('2000000000000000000');
    expect(result.job.minimumScoreBps).toBe(9000);
    expect(result.job.agreementHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('returns the original job when the same idempotent request is replayed', async () => {
    const service = new JobService({
      repository: new MemoryJobRepository(),
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    const context = {
      actor: { type: 'agent' as const, id: validInput.buyerAgentId },
      idempotencyKey: 'idem-create-002',
    };

    const first = await service.createJob(validInput, context);
    const second = await service.createJob(validInput, context);

    expect(second.replayed).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const service = new JobService({
      repository: new MemoryJobRepository(),
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    const context = {
      actor: { type: 'agent' as const, id: validInput.buyerAgentId },
      idempotencyKey: 'idem-create-003',
    };

    await service.createJob(validInput, context);
    await expect(service.createJob({ ...validInput, title: 'Different task' }, context)).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
  });

  it('rejects a deadline that is not in the future', async () => {
    const service = new JobService({
      repository: new MemoryJobRepository(),
      clock: () => new Date('2031-01-01T00:00:00.000Z'),
    });

    await expect(
      service.createJob(validInput, {
        actor: { type: 'agent', id: validInput.buyerAgentId },
        idempotencyKey: 'idem-create-004',
      }),
    ).rejects.toBeInstanceOf(JobDeadlineNotFutureError);
  });

  it('quotes a draft exactly once and records an idempotent transition', async () => {
    const repository = new MemoryJobRepository();
    const service = new JobService({
      repository,
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    const created = await service.createJob(validInput, {
      actor: { type: 'agent', id: validInput.buyerAgentId },
      idempotencyKey: 'idem-create-quote-001',
    });
    const context = {
      actor: { type: 'operator' as const, id: 'operator_test' },
      idempotencyKey: 'idem-quote-001',
    };

    const quoted = await service.quoteJob(created.job.id, context);
    const replayed = await service.quoteJob(created.job.id, context);

    expect(quoted.job.state).toBe('QUOTED');
    expect(quoted.job.version).toBe(2);
    expect(quoted.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(replayed.job.id).toBe(created.job.id);
  });
});
