import { randomUUID } from 'node:crypto';

import {
  createDatabaseClient,
  PostgresJobRepository,
  PostgresSubmissionRepository,
  PostgresVerificationRepository,
} from '@agentclear/db';
import { JobService, SubmissionQueryService, VerificationQueryService } from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { BootstrapApiKeyAuthenticator } from '../src/auth.js';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined)('AgentClear API with PostgreSQL', () => {
  const database = createDatabaseClient(databaseUrl!);
  const repository = new PostgresJobRepository(database.db);
  const apiKey = 'integration-api-key-with-at-least-32-chars';
  const submissionRepository = new PostgresSubmissionRepository(database.db);
  const verificationRepository = new PostgresVerificationRepository(database.db);
  const appPromise = buildApp({
    jobRepository: repository,
    jobService: new JobService({ repository }),
    submissionQueryService: new SubmissionQueryService(repository, submissionRepository),
    verificationQueryService: new VerificationQueryService(repository, verificationRepository),
    authenticator: new BootstrapApiKeyAuthenticator(apiKey, 'integration-pepper-with-at-least-32-chars', 'operator_it'),
  });

  beforeEach(async () => {
    await database.db.execute(
      sql`truncate table reputation_events, reputation_operations, settlements, refunds, settlement_operations, verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
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
      },
      refundPolicy: { onExpiry: true, onFinalFailure: true },
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
});
