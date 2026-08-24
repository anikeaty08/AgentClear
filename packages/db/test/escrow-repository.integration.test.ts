import { randomUUID } from 'node:crypto';

import {
  ChainOperationFailedError,
  FundingService,
  JobService,
  type EscrowGateway,
  type PreparedFundingTransaction,
} from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../src/client.js';
import { PostgresEscrowRepository } from '../src/escrow-repository.js';
import { PostgresJobRepository } from '../src/job-repository.js';

const databaseUrl = process.env['DATABASE_URL'];
const hex = (character: string, bytes: number) =>
  `0x${character.repeat(bytes * 2)}` as `0x${string}`;

class IntegrationEscrowGateway implements EscrowGateway {
  public readonly chainId = 31_337;
  public readonly contractAddress = hex('1', 20);
  public readonly signerAddress = hex('2', 20);
  public prepareCalls = 0;
  public failNextBroadcast = false;

  public async prepareFundJob(): Promise<PreparedFundingTransaction> {
    this.prepareCalls += 1;
    return {
      jobKey: hex('3', 32),
      transactionHash: hex('4', 32),
      serializedTransaction: hex('5', 100),
      contractAddress: this.contractAddress,
      signerAddress: this.signerAddress,
    };
  }

  public async broadcastPreparedFunding(): Promise<`0x${string}`> {
    if (this.failNextBroadcast) {
      this.failNextBroadcast = false;
      throw new Error('Temporary RPC outage');
    }
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
}

describe.skipIf(databaseUrl === undefined)('PostgresEscrowRepository', () => {
  const client = createDatabaseClient(databaseUrl!);
  const jobRepository = new PostgresJobRepository(client.db);
  const escrowRepository = new PostgresEscrowRepository(client.db);
  const fixedClock = () => new Date('2026-08-23T00:00:00.000Z');

  beforeEach(async () => {
    await client.db.execute(
      sql`truncate table funding_authorizations, spending_policies, receipts, receipt_operations, reputation_events, reputation_operations, settlements, refunds, settlement_operations, verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
    );
  });

  afterAll(async () => {
    await client.close();
  });

  async function createQuotedJob() {
    const service = new JobService({ repository: jobRepository, clock: fixedClock });
    const created = await service.createJob(
      {
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
      },
      {
        actor: { type: 'operator', id: 'operator_it' },
        idempotencyKey: randomUUID(),
      },
    );
    return service.quoteJob(created.job.id, {
      actor: { type: 'operator', id: 'operator_it' },
      idempotencyKey: randomUUID(),
    });
  }

  it('resumes one persisted signed transaction and atomically confirms the job', async () => {
    const quoted = await createQuotedJob();
    const gateway = new IntegrationEscrowGateway();
    gateway.failNextBroadcast = true;
    const service = new FundingService({
      jobRepository,
      escrowRepository,
      gateway,
      maxPerJobBaseUnits: '5000000000000000000',
      clock: fixedClock,
    });
    const context = {
      actor: { type: 'operator' as const, id: 'operator_it' },
      idempotencyKey: randomUUID(),
    };

    await expect(service.fundJob(quoted.job.id, {}, context)).rejects.toBeInstanceOf(
      ChainOperationFailedError,
    );
    const prepared = await client.db.execute<{ status: string; serialized: string | null }>(
      sql`select status, serialized_transaction as serialized from escrow_funding_operations where job_id = ${quoted.job.id}`,
    );
    expect(prepared.rows[0]).toMatchObject({ status: 'PREPARED', serialized: expect.any(String) });

    const funded = await service.fundJob(quoted.job.id, {}, context);
    const replayed = await service.fundJob(quoted.job.id, {}, context);
    expect(funded.job.state).toBe('FUNDED');
    expect(funded.operation.status).toBe('CONFIRMED');
    expect(funded.operation.serializedTransaction).toBeNull();
    expect(replayed.replayed).toBe(true);
    expect(gateway.prepareCalls).toBe(1);

    const counts = await client.db.execute<{ events: string; escrows: string }>(sql`
      select
        (select count(*)::text from job_state_events where job_id = ${quoted.job.id}) as events,
        (select count(*)::text from escrows where job_id = ${quoted.job.id} and status = 'FUNDED') as escrows
    `);
    expect(counts.rows[0]).toEqual({ events: '3', escrows: '1' });
  });
});
