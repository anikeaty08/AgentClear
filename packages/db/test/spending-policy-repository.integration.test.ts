import { randomUUID } from 'node:crypto';

import {
  JobService,
  SpendingPolicyService,
  type AuthPrincipal,
} from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../src/client.js';
import { PostgresJobRepository } from '../src/job-repository.js';
import { PostgresSpendingPolicyRepository } from '../src/spending-policy-repository.js';

const databaseUrl = process.env['DATABASE_URL'];
const operator: AuthPrincipal = {
  id: 'operator_policy_test',
  kind: 'operator',
  scopes: new Set(['spending-policies:manage']),
};

describe.skipIf(databaseUrl === undefined)('PostgresSpendingPolicyRepository', () => {
  const client = createDatabaseClient(databaseUrl!);
  const repository = new PostgresSpendingPolicyRepository(client.db);
  const policyService = new SpendingPolicyService({
    repository,
    clock: () => new Date('2026-08-24T12:00:00.000Z'),
  });
  const jobRepository = new PostgresJobRepository(client.db);
  const jobService = new JobService({
    repository: jobRepository,
    clock: () => new Date('2026-08-24T10:00:00.000Z'),
  });

  beforeEach(async () => {
    await client.db.execute(
      sql`truncate table funding_authorizations, spending_policies, api_keys, receipts, receipt_operations, reputation_events, reputation_operations, settlements, refunds, settlement_operations, verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it('atomically reserves day/month capacity and gates high-value funding on approval', async () => {
    await policyService.putPolicy(
      operator.id,
      {
        principalKind: 'operator',
        maxPerJobBaseUnits: '100',
        maxPerDayBaseUnits: '150',
        maxPerMonthBaseUnits: '200',
        allowedCapabilities: ['code'],
        requireHumanApprovalAboveBaseUnits: '60',
      },
      operator,
    );
    const [firstJob, secondJob, thirdJob] = await Promise.all([
      createJob(jobService, 'First policy job'),
      createJob(jobService, 'Second policy job'),
      createJob(jobService, 'Third policy job'),
    ]);

    const first = await repository.authorizeFunding({
      jobId: firstJob,
      principalId: operator.id,
      amountBaseUnits: '50',
      capability: 'code',
      requestedAt: '2026-08-24T12:00:00.000Z',
      approvalExpiresAt: '2026-08-25T12:00:00.000Z',
    });
    expect(first.outcome).toBe('AUTHORIZED');

    const pending = await repository.authorizeFunding({
      jobId: secondJob,
      principalId: operator.id,
      amountBaseUnits: '70',
      capability: 'code',
      requestedAt: '2026-08-24T12:01:00.000Z',
      approvalExpiresAt: '2026-08-25T12:01:00.000Z',
    });
    expect(pending.outcome).toBe('APPROVAL_REQUIRED');
    const approved = await policyService.approveFunding(secondJob, operator);
    expect(approved).toMatchObject({
      jobId: secondJob,
      status: 'AUTHORIZED',
      approvedBy: operator.id,
    });

    const overDaily = await repository.authorizeFunding({
      jobId: thirdJob,
      principalId: operator.id,
      amountBaseUnits: '40',
      capability: 'code',
      requestedAt: '2026-08-24T12:02:00.000Z',
      approvalExpiresAt: '2026-08-25T12:02:00.000Z',
    });
    expect(overDaily).toEqual({ outcome: 'LIMIT_EXCEEDED' });
  });
});

async function createJob(service: JobService, title: string): Promise<string> {
  const result = await service.createJob(
    {
      buyerAgentId: 'erc8004:16602:123',
      title,
      description: 'Exercise an atomic spending authorization.',
      budget: { token: 'native', maxAmount: '0.000000000000000100' },
      deadline: '2030-08-23T16:00:00.000Z',
      deliverable: { type: 'code', format: 'json' },
      verification: {
        mode: 'deterministic',
        minimumScore: 1,
        requirements: ['Return a valid result.'],
        deterministicChecks: [
          {
            id: 'result',
            kind: 'json_path_exists',
            description: 'Result exists.',
            path: ['result'],
            weightBps: 10_000,
            hardFailure: true,
          },
        ],
      },
      refundPolicy: { onExpiry: true, onFinalFailure: true },
    },
    {
      actor: { type: 'operator', id: operator.id },
      idempotencyKey: randomUUID(),
    },
  );
  return result.job.id;
}
