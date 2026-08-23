import { randomUUID } from 'node:crypto';

import { IdempotencyKeyReusedError, JobService } from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../src/client.js';
import { PostgresJobRepository } from '../src/job-repository.js';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined)('PostgresJobRepository', () => {
  const client = createDatabaseClient(databaseUrl!);
  const repository = new PostgresJobRepository(client.db);
  const service = new JobService({
    repository,
    clock: () => new Date('2026-08-23T00:00:00.000Z'),
    idGenerator: randomUUID,
  });

  beforeEach(async () => {
    await client.db.execute(
      sql`truncate table settlements, refunds, settlement_operations, verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
    );
  });

  afterAll(async () => {
    await client.close();
  });

  const input = {
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
  } as const;

  it('atomically persists the job, agreement requirements, initial event, and idempotency claim', async () => {
    const context = {
      actor: { type: 'agent' as const, id: input.buyerAgentId },
      idempotencyKey: randomUUID(),
    };

    const first = await service.createJob(input, context);
    const replay = await service.createJob(input, context);
    const loaded = await service.getJob(first.job.id);

    expect(replay.replayed).toBe(true);
    expect(replay.job.id).toBe(first.job.id);
    expect(loaded).toEqual(first.job);

    const requirementCount = await client.db.execute<{ count: string }>(
      sql`select count(*)::text as count from job_requirements where job_id = ${first.job.id}`,
    );
    const eventCount = await client.db.execute<{ count: string }>(
      sql`select count(*)::text as count from job_state_events where job_id = ${first.job.id}`,
    );
    expect(requirementCount.rows[0]?.count).toBe('1');
    expect(eventCount.rows[0]?.count).toBe('1');
  });

  it('rejects an idempotency key reused with another agreement', async () => {
    const context = {
      actor: { type: 'agent' as const, id: input.buyerAgentId },
      idempotencyKey: randomUUID(),
    };

    await service.createJob(input, context);
    await expect(service.createJob({ ...input, title: 'A different task' }, context)).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
  });
});
