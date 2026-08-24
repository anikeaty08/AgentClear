import { randomUUID } from 'node:crypto';

import {
  ChainOperationFailedError,
  FundingService,
  JobClosureService,
  JobService,
  type EscrowGateway,
  type JobClosureCommand,
  type JobClosureGateway,
  type PreparedFundingTransaction,
} from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../src/client.js';
import { PostgresJobClosureRepository } from '../src/closure-repository.js';
import { PostgresEscrowRepository } from '../src/escrow-repository.js';
import { PostgresJobRepository } from '../src/job-repository.js';

const databaseUrl = process.env['DATABASE_URL'];
const hex = (character: string, bytes: number) =>
  `0x${character.repeat(bytes * 2)}` as `0x${string}`;

class IntegrationClosureGateway implements EscrowGateway, JobClosureGateway {
  public readonly chainId = 31_337;
  public readonly contractAddress = hex('1', 20);
  public readonly signerAddress = hex('2', 20);
  public closurePrepareCalls = 0;
  public failNextClosureBroadcast = false;
  private closureCommand: JobClosureCommand | null = null;

  public async prepareFundJob(): Promise<PreparedFundingTransaction> {
    return {
      jobKey: hex('3', 32),
      transactionHash: hex('4', 32),
      serializedTransaction: hex('5', 100),
      contractAddress: this.contractAddress,
      signerAddress: this.signerAddress,
    };
  }

  public async broadcastPreparedFunding(): Promise<`0x${string}`> {
    return hex('4', 32);
  }

  public async confirmFundJob(command: JobClosureCommand) {
    return {
      transactionHash: hex('4', 32),
      blockNumber: '42',
      contractAddress: this.contractAddress,
      escrow: {
        jobKey: hex('3', 32),
        buyer: this.signerAddress,
        provider: null,
        amountBaseUnits: command.amountBaseUnits,
        deadline: '2030-08-23T16:00:00.000Z',
        state: 1,
        agreementHash: command.agreementHash,
      },
    };
  }

  public async prepareCancelUnassigned(
    command: JobClosureCommand,
  ): Promise<PreparedFundingTransaction> {
    this.closurePrepareCalls += 1;
    this.closureCommand = command;
    return {
      jobKey: hex('3', 32),
      transactionHash: hex('6', 32),
      serializedTransaction: hex('7', 100),
      contractAddress: this.contractAddress,
      signerAddress: this.signerAddress,
    };
  }

  public async prepareExpiredRefund(
    command: JobClosureCommand,
  ): Promise<PreparedFundingTransaction> {
    return this.prepareCancelUnassigned(command);
  }

  public async broadcastPreparedTransaction(): Promise<`0x${string}`> {
    if (this.failNextClosureBroadcast) {
      this.failNextClosureBroadcast = false;
      throw new Error('Temporary RPC outage');
    }
    return hex('6', 32);
  }

  public async confirmCancelUnassigned() {
    return this.confirmClosure(null);
  }

  public async confirmExpiredRefund() {
    return this.confirmClosure(hex('8', 20));
  }

  private async confirmClosure(provider: `0x${string}` | null) {
    if (this.closureCommand === null) throw new Error('Closure was not prepared.');
    return {
      transactionHash: hex('6', 32),
      blockNumber: '43',
      contractAddress: this.contractAddress,
      escrow: {
        jobKey: hex('3', 32),
        buyer: this.signerAddress,
        provider,
        amountBaseUnits: this.closureCommand.amountBaseUnits,
        deadline: '2030-08-23T16:00:00.000Z',
        state: 4,
        agreementHash: this.closureCommand.agreementHash,
      },
    };
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresJobClosureRepository', () => {
  const client = createDatabaseClient(databaseUrl!);
  const jobRepository = new PostgresJobRepository(client.db);
  const closureRepository = new PostgresJobClosureRepository(client.db);
  const fixedClock = () => new Date('2026-08-24T00:00:00.000Z');

  beforeEach(async () => {
    await client.db.execute(
      sql`truncate table funding_authorizations, spending_policies, receipts, receipt_operations, reputation_events, reputation_operations, settlements, refunds, settlement_operations, verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_closure_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
    );
  });

  afterAll(async () => {
    await client.close();
  });

  async function createJob() {
    const service = new JobService({ repository: jobRepository, clock: fixedClock });
    return service.createJob(
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
        actor: { type: 'operator', id: 'operator_closure_it' },
        idempotencyKey: randomUUID(),
      },
    );
  }

  it('cancels an unfunded draft atomically without a chain operation', async () => {
    const created = await createJob();
    const service = new JobClosureService({ jobRepository, closureRepository, clock: fixedClock });
    const context = {
      actor: { type: 'operator' as const, id: 'operator_closure_it' },
      idempotencyKey: randomUUID(),
    };

    const cancelled = await service.cancelJob(created.job.id, {}, context);
    const replayed = await service.cancelJob(created.job.id, {}, context);

    expect(cancelled.job.state).toBe('CANCELLED');
    expect(cancelled.operation).toBeNull();
    expect(replayed.replayed).toBe(true);
    const counts = await client.db.execute<{ operations: string; events: string }>(sql`
      select
        (select count(*)::text from job_closure_operations) as operations,
        (select count(*)::text from job_state_events where job_id = ${created.job.id}) as events
    `);
    expect(counts.rows[0]).toEqual({ operations: '0', events: '2' });
  });

  it('recovers one signed funded cancellation and records the refund exactly once', async () => {
    const created = await createJob();
    const jobService = new JobService({ repository: jobRepository, clock: fixedClock });
    const quoted = await jobService.quoteJob(created.job.id, {
      actor: { type: 'operator', id: 'operator_closure_it' },
      idempotencyKey: randomUUID(),
    });
    const gateway = new IntegrationClosureGateway();
    const funding = new FundingService({
      jobRepository,
      escrowRepository: new PostgresEscrowRepository(client.db),
      gateway,
      maxPerJobBaseUnits: '5000000000000000000',
      clock: fixedClock,
    });
    await funding.fundJob(quoted.job.id, {}, {
      actor: { type: 'operator', id: 'operator_closure_it' },
      idempotencyKey: randomUUID(),
    });
    gateway.failNextClosureBroadcast = true;
    const closure = new JobClosureService({
      jobRepository,
      closureRepository,
      gateway,
      clock: () => new Date('2026-08-24T00:00:02.000Z'),
    });
    const context = {
      actor: { type: 'operator' as const, id: 'operator_closure_it' },
      idempotencyKey: randomUUID(),
    };

    await expect(closure.cancelJob(quoted.job.id, {}, context)).rejects.toBeInstanceOf(
      ChainOperationFailedError,
    );
    const cancelled = await closure.cancelJob(quoted.job.id, {}, context);
    const replayed = await closure.cancelJob(quoted.job.id, {}, context);

    expect(cancelled.job.state).toBe('CANCELLED');
    expect(cancelled.operation).toMatchObject({ kind: 'CANCEL', status: 'CONFIRMED' });
    expect(replayed.replayed).toBe(true);
    expect(gateway.closurePrepareCalls).toBe(1);
    const state = await client.db.execute<{ operations: string; escrows: string; events: string }>(sql`
      select
        (select count(*)::text from job_closure_operations where job_id = ${quoted.job.id} and status = 'CONFIRMED') as operations,
        (select count(*)::text from escrows where job_id = ${quoted.job.id} and status = 'REFUNDED') as escrows,
        (select count(*)::text from job_state_events where job_id = ${quoted.job.id} and to_state = 'CANCELLED') as events
    `);
    expect(state.rows[0]).toEqual({ operations: '1', escrows: '1', events: '1' });
  });
});
