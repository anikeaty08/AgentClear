import {
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobService,
  SubmissionQueryService,
  VerificationQueryService,
  type SubmissionRepository,
  type VerificationRepository,
  type CreateJobPersistenceInput,
  type CreateJobPersistenceResult,
  type Job,
  type JobRepository,
  type TransitionJobPersistenceInput,
  type TransitionJobPersistenceResult,
} from '@agentclear/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { Authenticator } from '../src/auth.js';

class MemoryJobRepository implements JobRepository {
  readonly #jobs = new Map<string, Job>();
  readonly #claims = new Map<string, { requestHash: string; resourceId: string }>();

  public async create(input: CreateJobPersistenceInput): Promise<CreateJobPersistenceResult> {
    const key = `${input.idempotency.scope}:${input.idempotency.key}`;
    const claim = this.#claims.get(key);
    if (claim !== undefined) {
      if (claim.requestHash !== input.idempotency.requestHash) {
        throw new IdempotencyKeyReusedError();
      }
      return { job: this.#jobs.get(claim.resourceId)!, replayed: true };
    }
    this.#claims.set(key, { requestHash: input.idempotency.requestHash, resourceId: input.job.id });
    this.#jobs.set(input.job.id, input.job);
    return { job: input.job, replayed: false };
  }

  public async findById(jobId: string): Promise<Job | null> {
    return this.#jobs.get(jobId) ?? null;
  }

  public async transition(
    input: TransitionJobPersistenceInput,
  ): Promise<TransitionJobPersistenceResult> {
    const key = `${input.idempotency.scope}:${input.idempotency.key}`;
    const claim = this.#claims.get(key);
    if (claim !== undefined) {
      if (claim.requestHash !== input.idempotency.requestHash) {
        throw new IdempotencyKeyReusedError();
      }
      return { job: this.#jobs.get(claim.resourceId)!, replayed: true };
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
    this.#claims.set(key, { requestHash: input.idempotency.requestHash, resourceId: input.jobId });
    this.#jobs.set(input.jobId, updated);
    return { job: updated, replayed: false };
  }

  public async ping(): Promise<void> {}
}

const authenticator: Authenticator = {
  async authenticate(apiKey) {
    return apiKey === 'valid-test-api-key'
      ? {
          id: 'operator_test',
          kind: 'operator',
          scopes: new Set([
            'jobs:read',
            'jobs:write',
            'jobs:fund',
            'jobs:assign',
            'jobs:submit',
            'jobs:verify',
            'jobs:settle',
            'jobs:reputation',
            'jobs:receipt',
          ]),
        }
      : null;
  },
};

const validJob = {
  buyerAgentId: 'erc8004:16602:123',
  title: 'Implement transaction sorter',
  description: 'Implement the requested TypeScript function.',
  budget: { token: 'native', maxAmount: '2.00' },
  deadline: '2030-08-23T16:00:00.000Z',
  deliverable: { type: 'code', format: 'git_patch' },
  verification: {
    mode: 'ai',
    minimumScore: 0.9,
    requirements: ['All hidden tests must pass'],
  },
  refundPolicy: { onExpiry: true, onFinalFailure: true },
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function createTestApp() {
  const repository = new MemoryJobRepository();
  const submissionRepository = {
    async listByJob() {
      return [];
    },
  } as unknown as SubmissionRepository;
  const verificationRepository = {
    async listByJob() {
      return [];
    },
  } as unknown as VerificationRepository;
  const app = await buildApp({
    jobRepository: repository,
    jobService: new JobService({
      repository,
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
    }),
    submissionQueryService: new SubmissionQueryService(repository, submissionRepository),
    verificationQueryService: new VerificationQueryService(repository, verificationRepository),
    authenticator,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('AgentClear API', () => {
  it('reports liveness without exposing dependency details', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('requires authentication for versioned API routes', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/v1/jobs/0198d462-75c0-7000-8000-000000000001' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('creates and reads a structured job through the shared service', async () => {
    const app = await createTestApp();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'create-job-test-001',
      },
      payload: validJob,
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.headers['idempotency-replayed']).toBe('false');
    const createdJob = createResponse.json().data.job as Job;

    const getResponse = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${createdJob.id}`,
      headers: { authorization: 'Bearer valid-test-api-key' },
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().data.job.agreementHash).toBe(createdJob.agreementHash);
  });

  it('returns the original job for an exact idempotent replay', async () => {
    const app = await createTestApp();
    const request = {
      method: 'POST' as const,
      url: '/v1/jobs',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'create-job-test-002',
      },
      payload: validJob,
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().data.job.id).toBe(first.json().data.job.id);
  });

  it('quotes a draft through the versioned API', async () => {
    const app = await createTestApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'create-job-for-quote-001',
      },
      payload: validJob,
    });
    const jobId = created.json().data.job.id as string;

    const quoted = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/quote`,
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'quote-job-test-001',
      },
    });

    expect(quoted.statusCode).toBe(200);
    expect(quoted.json().data.job).toMatchObject({ id: jobId, state: 'QUOTED', version: 2 });
  });

  it('reports an explicit degraded state when chain funding is not configured', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/fund',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'fund-job-disabled-001',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('CHAIN_UNAVAILABLE');
  });

  it('reports an explicit degraded state when chain assignment is not configured', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/assign',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'assign-job-disabled-001',
      },
      payload: {
        providerAgentId: 'erc8004:16602:456',
        providerAddress: '0x1111111111111111111111111111111111111111',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('CHAIN_UNAVAILABLE');
  });

  it('rejects provider submission before mutation when 0G Storage is not configured', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/submissions',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'submit-job-disabled-001',
      },
      payload: { result: { answer: 42 } },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('rejects verification before mutation when the evidence store is not configured', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/verify',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'verify-job-disabled-001',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('rejects settlement before mutation when outcome chain configuration is absent', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/settle',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'settle-job-disabled-001',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('CHAIN_UNAVAILABLE');
  });

  it('reports an explicit degraded state when ERC-8004 reputation is not configured', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/reputation',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'reputation-job-disabled-001',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('CHAIN_UNAVAILABLE');
  });

  it('reports an explicit degraded state when receipt Storage is not configured', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/receipt',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'receipt-job-disabled-001',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('returns a stable validation error without a stack trace', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {
        authorization: 'Bearer valid-test-api-key',
        'idempotency-key': 'create-job-test-003',
      },
      payload: { ...validJob, budget: { token: 'native', maxAmount: 2 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', message: expect.any(String), requestId: expect.any(String) },
    });
    expect(response.body).not.toContain('stack');
  });
});
