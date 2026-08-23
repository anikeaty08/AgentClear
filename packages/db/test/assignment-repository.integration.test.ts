import { randomUUID } from 'node:crypto';

import {
  AssignmentService,
  ChainOperationFailedError,
  ChainSignerBusyError,
  FundingService,
  JobService,
  type AssignmentGateway,
  type EscrowGateway,
  type PreparedFundingTransaction,
} from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresAssignmentRepository } from '../src/assignment-repository.js';
import { createDatabaseClient } from '../src/client.js';
import { PostgresEscrowRepository } from '../src/escrow-repository.js';
import { PostgresJobRepository } from '../src/job-repository.js';

const databaseUrl = process.env['DATABASE_URL'];
const hex = (character: string, bytes: number) =>
  `0x${character.repeat(bytes * 2)}` as `0x${string}`;

class IntegrationChainGateway implements EscrowGateway, AssignmentGateway {
  public readonly chainId = 31_337;
  public readonly contractAddress = hex('1', 20);
  public readonly signerAddress = hex('2', 20);
  public assignmentPrepareCalls = 0;
  public failNextAssignmentBroadcast = false;

  public async prepareFundJob(): Promise<PreparedFundingTransaction> {
    return this.prepared('3', '4', '5');
  }

  public async broadcastPreparedFunding(): Promise<`0x${string}`> {
    return hex('4', 32);
  }

  public async confirmFundJob() {
    return {
      transactionHash: hex('4', 32),
      blockNumber: '42',
      contractAddress: this.contractAddress,
      escrow: {
        jobKey: hex('3', 32),
        buyer: this.signerAddress,
        provider: null,
        amountBaseUnits: '2000000000000000000',
        deadline: '2030-08-23T16:00:00.000Z',
        state: 1,
        agreementHash: hex('a', 32),
      },
    };
  }

  public async prepareAssignProvider(): Promise<PreparedFundingTransaction> {
    this.assignmentPrepareCalls += 1;
    return this.prepared('3', '6', '7');
  }

  public async broadcastPreparedTransaction(): Promise<`0x${string}`> {
    if (this.failNextAssignmentBroadcast) {
      this.failNextAssignmentBroadcast = false;
      throw new Error('Temporary RPC outage');
    }
    return hex('6', 32);
  }

  public async confirmAssignProvider(
    _jobId: string,
    providerAddress: `0x${string}`,
  ) {
    return {
      transactionHash: hex('6', 32),
      blockNumber: '43',
      contractAddress: this.contractAddress,
      escrow: { provider: providerAddress },
    };
  }

  private prepared(
    jobKeyCharacter: string,
    hashCharacter: string,
    serializedCharacter: string,
  ): PreparedFundingTransaction {
    return {
      jobKey: hex(jobKeyCharacter, 32),
      transactionHash: hex(hashCharacter, 32),
      serializedTransaction: hex(serializedCharacter, 100),
      contractAddress: this.contractAddress,
      signerAddress: this.signerAddress,
    };
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresAssignmentRepository', () => {
  const client = createDatabaseClient(databaseUrl!);
  const jobRepository = new PostgresJobRepository(client.db);
  const escrowRepository = new PostgresEscrowRepository(client.db);
  const assignmentRepository = new PostgresAssignmentRepository(client.db);
  const fixedClock = () => new Date('2026-08-23T00:00:00.000Z');

  beforeEach(async () => {
    await client.db.execute(
      sql`truncate table verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
    );
  });

  afterAll(async () => {
    await client.close();
  });

  async function createQuotedJob() {
    const jobService = new JobService({ repository: jobRepository, clock: fixedClock });
    const created = await jobService.createJob(
      {
        buyerAgentId: 'erc8004:16602:123',
        title: 'Implement transaction sorter',
        description: 'Implement the requested TypeScript function.',
        budget: { token: 'native', maxAmount: '2.00' },
        deadline: '2030-08-23T16:00:00.000Z',
        deliverable: { type: 'code', format: 'git_patch' },
        verification: {
          mode: 'ai',
          minimumScore: 1,
          requirements: ['All supplied tests pass'],
        },
        refundPolicy: { onExpiry: true, onFinalFailure: true },
      },
      { actor: { type: 'operator', id: 'operator_it' }, idempotencyKey: randomUUID() },
    );
    return jobService.quoteJob(created.job.id, {
      actor: { type: 'operator', id: 'operator_it' },
      idempotencyKey: randomUUID(),
    });
  }

  async function createFundedJob(gateway: IntegrationChainGateway) {
    const quoted = await createQuotedJob();
    return new FundingService({
      jobRepository,
      escrowRepository,
      gateway,
      maxPerJobBaseUnits: '5000000000000000000',
      clock: fixedClock,
    }).fundJob(quoted.job.id, {}, {
      actor: { type: 'operator', id: 'operator_it' },
      idempotencyKey: randomUUID(),
    });
  }

  it('resumes one signed assignment and atomically records OPEN then ASSIGNED', async () => {
    const gateway = new IntegrationChainGateway();
    const funded = await createFundedJob(gateway);
    gateway.failNextAssignmentBroadcast = true;
    const service = new AssignmentService({
      jobRepository,
      assignmentRepository,
      gateway,
      clock: fixedClock,
    });
    const context = {
      actor: { type: 'operator' as const, id: 'operator_it' },
      idempotencyKey: randomUUID(),
    };
    const input = {
      providerAgentId: 'erc8004:16602:456',
      providerAddress: hex('8', 20),
    };

    await expect(service.assignProvider(funded.job.id, input, context)).rejects.toBeInstanceOf(
      ChainOperationFailedError,
    );
    const prepared = await client.db.execute<{ status: string; serialized: string | null }>(
      sql`select status, serialized_transaction as serialized from job_assignment_operations where job_id = ${funded.job.id}`,
    );
    expect(prepared.rows[0]).toMatchObject({ status: 'PREPARED', serialized: expect.any(String) });

    const blockedJob = await createQuotedJob();
    await expect(
      new FundingService({
        jobRepository,
        escrowRepository,
        gateway,
        maxPerJobBaseUnits: '5000000000000000000',
        clock: fixedClock,
      }).fundJob(blockedJob.job.id, {}, {
        actor: { type: 'operator', id: 'operator_it' },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ChainSignerBusyError);

    const assigned = await service.assignProvider(funded.job.id, input, context);
    const replayed = await service.assignProvider(funded.job.id, input, context);

    expect(assigned.job).toMatchObject({
      state: 'ASSIGNED',
      providerAgentId: input.providerAgentId,
    });
    expect(assigned.operation.serializedTransaction).toBeNull();
    expect(replayed.replayed).toBe(true);
    expect(gateway.assignmentPrepareCalls).toBe(1);

    const counts = await client.db.execute<{
      events: string;
      assignments: string;
      providerAddress: string;
    }>(sql`
      select
        (select count(*)::text from job_state_events where job_id = ${funded.job.id}) as events,
        (select count(*)::text from job_assignments where job_id = ${funded.job.id}) as assignments,
        (select provider_address from escrows where job_id = ${funded.job.id}) as "providerAddress"
    `);
    expect(counts.rows[0]).toEqual({
      events: '5',
      assignments: '1',
      providerAddress: input.providerAddress,
    });
  });
});
