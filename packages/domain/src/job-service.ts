import { randomUUID } from 'node:crypto';

import { JobDeadlineNotFutureError, JobNotFoundError } from './errors.js';
import { sha256Commitment } from './canonical.js';
import { createJobInputSchema, type CreateJobInput, type Job, type JobActor } from './job.js';
import type {
  CreateJobPersistenceResult,
  JobRepository,
  TransitionJobPersistenceResult,
} from './job-repository.js';
import { decimalToBaseUnits } from './money.js';

export type JobServiceDependencies = {
  repository: JobRepository;
  clock?: () => Date;
  idGenerator?: () => string;
};

export class JobService {
  readonly #repository: JobRepository;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(dependencies: JobServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  public async createJob(
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<CreateJobPersistenceResult> {
    const input = createJobInputSchema.parse(rawInput);
    const now = this.#clock();
    const deadline = new Date(input.deadline);
    if (deadline.getTime() <= now.getTime()) {
      throw new JobDeadlineNotFutureError();
    }

    const normalizedInput: CreateJobInput = {
      ...input,
      deadline: deadline.toISOString(),
    };
    const jobId = this.#idGenerator();
    const eventId = this.#idGenerator();
    const timestamp = now.toISOString();
    const agreement = { jobId, ...normalizedInput };
    const minimumScoreBps = Math.round(normalizedInput.verification.minimumScore * 10_000);

    const job: Job = {
      id: jobId,
      agreement,
      agreementHash: sha256Commitment(agreement),
      budgetAmountBaseUnits: decimalToBaseUnits(normalizedInput.budget.maxAmount, 18),
      minimumScoreBps,
      state: 'DRAFT',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return this.#repository.create({
      job,
      initialEvent: {
        id: eventId,
        jobId,
        fromState: null,
        toState: 'DRAFT',
        actorType: context.actor.type,
        actorId: context.actor.id,
        reason: 'Structured job agreement created.',
        occurredAt: timestamp,
      },
      idempotency: {
        scope: `jobs:create:${context.actor.id}`,
        key: context.idempotencyKey,
        requestHash: sha256Commitment(normalizedInput),
        resourceId: jobId,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      },
    });
  }

  public async getJob(jobId: string): Promise<Job> {
    const job = await this.#repository.findById(jobId);
    if (job === null) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  public async quoteJob(
    jobId: string,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<TransitionJobPersistenceResult> {
    await this.getJob(jobId);
    const now = this.#clock();
    return this.#repository.transition({
      jobId,
      expectedState: 'DRAFT',
      nextState: 'QUOTED',
      event: {
        id: this.#idGenerator(),
        jobId,
        fromState: 'DRAFT',
        toState: 'QUOTED',
        actorType: context.actor.type,
        actorId: context.actor.id,
        reason: 'Agreement accepted for its maximum native-asset budget.',
        occurredAt: now.toISOString(),
      },
      idempotency: {
        scope: `jobs:quote:${context.actor.id}:${jobId}`,
        key: context.idempotencyKey,
        requestHash: sha256Commitment({ jobId }),
        resourceId: jobId,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      },
    });
  }
}
