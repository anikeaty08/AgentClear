import { randomUUID } from 'node:crypto';

import {
  createDatabaseClient,
  PostgresApiKeyRepository,
  PostgresJobRepository,
  PostgresSubmissionRepository,
  PostgresSpendingPolicyRepository,
  PostgresVerificationRepository,
} from '@agentclear/db';
import {
  ApiKeyService,
  JobService,
  SubmissionQueryService,
  SpendingPolicyService,
  VerificationQueryService,
} from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  BootstrapApiKeyAuthenticator,
  CompositeAuthenticator,
  DurableApiKeyAuthenticator,
} from '../src/auth.js';

const databaseUrl = process.env['DATABASE_URL'];
const payload = {
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
    rubric: {
      criteria: [
        { id: 'correctness', description: 'The deliverable is correct.', weightBps: 10_000 },
      ],
    },
  },
  refundPolicy: { onExpiry: true, onFinalFailure: true },
};

describe.skipIf(databaseUrl === undefined)('AgentClear API with PostgreSQL', () => {
  const database = createDatabaseClient(databaseUrl!);
  const repository = new PostgresJobRepository(database.db);
  const keyRepository = new PostgresApiKeyRepository(database.db);
  const spendingPolicyRepository = new PostgresSpendingPolicyRepository(database.db);
  const spendingPolicyService = new SpendingPolicyService({
    repository: spendingPolicyRepository,
    clock: () => new Date('2026-08-24T12:00:00.000Z'),
  });
  const keyService = new ApiKeyService({
    repository: keyRepository,
    pepper: 'integration-pepper-with-at-least-32-chars',
  });
  const apiKey = 'integration-api-key-with-at-least-32-chars';
  const submissionRepository = new PostgresSubmissionRepository(database.db);
  const verificationRepository = new PostgresVerificationRepository(database.db);
  const appPromise = buildApp({
    apiKeyService: keyService,
    spendingPolicyService,
    jobRepository: repository,
    jobService: new JobService({ repository, listRepository: repository }),
    submissionQueryService: new SubmissionQueryService(repository, submissionRepository),
    verificationQueryService: new VerificationQueryService(repository, verificationRepository),
    authenticator: new CompositeAuthenticator([
      new BootstrapApiKeyAuthenticator(
        apiKey,
        'integration-pepper-with-at-least-32-chars',
        'operator_it',
      ),
      new DurableApiKeyAuthenticator(keyService),
    ]),
  });

  beforeEach(async () => {
    await database.db.execute(
      sql`truncate table funding_authorizations, spending_policies, api_keys, receipts, receipt_operations, reputation_events, reputation_operations, settlements, refunds, settlement_operations, verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_closure_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
    );
  });

  afterAll(async () => {
    const app = await appPromise;
    await app.close();
    await database.close();
  });

  it('persists an authenticated create request and serves the same job on read and replay', async () => {
    const app = await appPromise;
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'idempotency-key': randomUUID(),
    };
    const created = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });
    const replayed = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });
    const jobId = created.json().data.job.id as string;
    const loaded = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}`,
      headers: { authorization: headers.authorization },
    });

    expect(created.statusCode).toBe(201);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.json().data.job.id).toBe(jobId);
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().data.job).toMatchObject({ id: jobId, state: 'DRAFT' });
  });

  it('issues, authenticates, audits, and revokes a durable key through REST and PostgreSQL', async () => {
    const app = await appPromise;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        label: 'Buyer runtime',
        principalId: 'erc8004:16602:123',
        principalKind: 'agent',
        scopes: ['jobs:read', 'jobs:write'],
      },
    });
    const secret = issued.json().data.secret as string;
    const keyId = issued.json().data.apiKey.id as string;
    expect(issued.statusCode).toBe(201);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {
        authorization: `Bearer ${secret}`,
        'idempotency-key': randomUUID(),
      },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect((await keyRepository.findById(keyId))?.lastUsedAt).not.toBeNull();

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(revoked.statusCode).toBe(200);

    const rejected = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${created.json().data.job.id as string}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it('manages a policy and approves a reserved funding request through REST', async () => {
    const app = await appPromise;
    const authorization = { authorization: `Bearer ${apiKey}` };
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/spending-policies/operator_it',
      headers: authorization,
      payload: {
        principalKind: 'operator',
        maxPerJobBaseUnits: '1000',
        maxPerDayBaseUnits: '2000',
        maxPerMonthBaseUnits: '10000',
        allowedCapabilities: ['code'],
        requireHumanApprovalAboveBaseUnits: '100',
      },
    });
    expect(put.statusCode).toBe(200);

    const createdJob = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization, 'idempotency-key': randomUUID() },
      payload,
    });
    const jobId = createdJob.json().data.job.id as string;
    const pending = await spendingPolicyRepository.authorizeFunding({
      jobId,
      principalId: 'operator_it',
      amountBaseUnits: '200',
      capability: 'code',
      requestedAt: '2026-08-24T12:00:00.000Z',
      approvalExpiresAt: '2026-08-25T12:00:00.000Z',
    });
    expect(pending.outcome).toBe('APPROVAL_REQUIRED');

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/funding-approval`,
      headers: authorization,
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.authorization).toMatchObject({
      jobId,
      status: 'AUTHORIZED',
      approvedBy: 'operator_it',
    });

    const loaded = await app.inject({
      method: 'GET',
      url: '/v1/spending-policies/operator_it',
      headers: authorization,
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().data.policy.maxPerDayBaseUnits).toBe('2000');
  });
});
