import { describe, expect, it } from 'vitest';

import {
  ChainOperationFailedError,
  FundingService,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  SpendingApprovalRequiredError,
  SpendingAuthorizationConflictError,
  SpendingPolicyExceededError,
  SpendingPolicyNotConfiguredError,
  type BeginFundingInput,
  type BeginFundingResult,
  type ConfirmFundingPersistenceInput,
  type CreateJobPersistenceResult,
  type EscrowGateway,
  type EscrowRepository,
  type FundingOperation,
  type FundingAuthorizationDecision,
  type Job,
  type JobRepository,
  type PreparedFundingTransaction,
  type SpendingAuthorizer,
  type TransitionJobPersistenceResult,
} from '../src/index.js';

const hex = (character: string, bytes: number) =>
  `0x${character.repeat(bytes * 2)}` as `0x${string}`;

const quotedJob: Job = {
  id: '0198d462-75c0-7000-8000-000000000001',
  agreement: {
    jobId: '0198d462-75c0-7000-8000-000000000001',
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
  },
  providerAgentId: null,
  agreementHash: hex('a', 32),
  budgetAmountBaseUnits: '2000000000000000000',
  minimumScoreBps: 9000,
  state: 'QUOTED',
  version: 2,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:01.000Z',
};

class FundingJobRepository implements JobRepository {
  public constructor(private job: Job) {}

  public async findById(jobId: string): Promise<Job | null> {
    return jobId === this.job.id ? this.job : null;
  }

  public async create(): Promise<CreateJobPersistenceResult> {
    throw new Error('Not used by FundingService tests.');
  }

  public async transition(): Promise<TransitionJobPersistenceResult> {
    throw new Error('Not used by FundingService tests.');
  }

  public async ping(): Promise<void> {}
}

class MemoryEscrowRepository implements EscrowRepository {
  readonly #operations = new Map<string, FundingOperation>();
  readonly #claims = new Map<string, { requestHash: string; operationId: string }>();

  public constructor(private readonly job: Job) {}

  public async beginFunding(input: BeginFundingInput): Promise<BeginFundingResult> {
    const key = `${input.idempotency.scope}:${input.idempotency.key}`;
    const claim = this.#claims.get(key);
    if (claim !== undefined) {
      if (claim.requestHash !== input.idempotency.requestHash) throw new IdempotencyKeyReusedError();
      return { job: this.currentJob(claim.operationId), operation: this.#operations.get(claim.operationId)!, replayed: true };
    }
    if (this.job.state !== 'QUOTED') throw new InvalidJobTransitionError(this.job.state, 'FUNDED');
    this.#claims.set(key, { requestHash: input.idempotency.requestHash, operationId: input.operation.id });
    this.#operations.set(input.operation.id, input.operation);
    return { job: this.job, operation: input.operation, replayed: false };
  }

  public async savePrepared(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<FundingOperation> {
    return this.update(operationId, {
      status: 'PREPARED',
      jobKey: prepared.jobKey,
      serializedTransaction: prepared.serializedTransaction,
      transactionHash: prepared.transactionHash,
      updatedAt,
    });
  }

  public async markBroadcast(operationId: string, updatedAt: string): Promise<FundingOperation> {
    return this.update(operationId, { status: 'BROADCAST', updatedAt });
  }

  public async confirmFunding(input: ConfirmFundingPersistenceInput): Promise<BeginFundingResult> {
    const operation = this.update(input.operationId, {
      status: 'CONFIRMED',
      serializedTransaction: null,
      blockNumber: input.confirmation.blockNumber,
      updatedAt: input.event.occurredAt,
    });
    return { job: this.currentJob(input.operationId), operation, replayed: false };
  }

  public operation(operationId: string): FundingOperation | undefined {
    return this.#operations.get(operationId);
  }

  private currentJob(operationId: string): Job {
    const operation = this.#operations.get(operationId);
    return operation?.status === 'CONFIRMED'
      ? { ...this.job, state: 'FUNDED', version: 3, updatedAt: operation.updatedAt }
      : this.job;
  }

  private update(
    operationId: string,
    patch: Partial<FundingOperation>,
  ): FundingOperation {
    const operation = { ...this.#operations.get(operationId)!, ...patch };
    this.#operations.set(operationId, operation);
    return operation;
  }
}

class MemoryEscrowGateway implements EscrowGateway {
  public readonly chainId = 31_337;
  public readonly contractAddress = hex('1', 20);
  public readonly signerAddress = hex('2', 20);
  public prepareCalls = 0;
  public broadcastCalls = 0;
  public confirmCalls = 0;
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
    this.broadcastCalls += 1;
    if (this.failNextBroadcast) {
      this.failNextBroadcast = false;
      throw new Error('RPC unavailable');
    }
    return hex('4', 32);
  }

  public async confirmFundJob() {
    this.confirmCalls += 1;
    return {
      transactionHash: hex('4', 32),
      blockNumber: '42',
      contractAddress: this.contractAddress,
      escrow: {
        jobKey: hex('3', 32),
        buyer: this.signerAddress,
        provider: null,
        amountBaseUnits: quotedJob.budgetAmountBaseUnits,
        deadline: quotedJob.agreement.deadline,
        state: 1,
        agreementHash: quotedJob.agreementHash,
      },
    };
  }
}

function createService(
  maxPerJobBaseUnits = '5000000000000000000',
  spendingAuthorizer?: SpendingAuthorizer,
  job: Job = quotedJob,
) {
  const gateway = new MemoryEscrowGateway();
  const escrowRepository = new MemoryEscrowRepository(job);
  let id = 0;
  const service = new FundingService({
    jobRepository: new FundingJobRepository(job),
    escrowRepository,
    gateway,
    maxPerJobBaseUnits,
    ...(spendingAuthorizer === undefined ? {} : { spendingAuthorizer }),
    clock: () => new Date('2026-08-23T00:00:02.000Z'),
    idGenerator: () => `0198d462-75c0-7000-8000-${String(++id).padStart(12, '0')}`,
  });
  return { service, gateway, escrowRepository };
}

const context = {
  actor: { type: 'operator' as const, id: 'operator_test' },
  idempotencyKey: 'fund-job-idempotency-001',
};

describe('FundingService', () => {
  it('persists, broadcasts, confirms, and replays a single funding operation', async () => {
    const { service, gateway } = createService();

    const funded = await service.fundJob(quotedJob.id, {}, context);
    const replayed = await service.fundJob(quotedJob.id, {}, context);

    expect(funded.job.state).toBe('FUNDED');
    expect(funded.operation.status).toBe('CONFIRMED');
    expect(funded.operation.serializedTransaction).toBeNull();
    expect(replayed.replayed).toBe(true);
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.broadcastCalls).toBe(1);
    expect(gateway.confirmCalls).toBe(1);
  });

  it('resumes the persisted signed transaction after a broadcast failure', async () => {
    const { service, gateway } = createService();
    gateway.failNextBroadcast = true;

    await expect(service.fundJob(quotedJob.id, {}, context)).rejects.toBeInstanceOf(
      ChainOperationFailedError,
    );
    const funded = await service.fundJob(quotedJob.id, {}, context);

    expect(funded.job.state).toBe('FUNDED');
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.broadcastCalls).toBe(2);
    expect(gateway.confirmCalls).toBe(1);
  });

  it('enforces the server-side per-job spending limit before signing', async () => {
    const { service, gateway } = createService('1000000000000000000');

    await expect(service.fundJob(quotedJob.id, {}, context)).rejects.toBeInstanceOf(
      SpendingPolicyExceededError,
    );
    expect(gateway.prepareCalls).toBe(0);
  });

  it('rejects provider assignment fields at the funding boundary', async () => {
    const { service, gateway } = createService();

    await expect(
      service.fundJob(
        quotedJob.id,
        { providerAddress: hex('6', 20) },
        context,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(gateway.prepareCalls).toBe(0);
  });

  it.each([
    ['POLICY_NOT_FOUND', SpendingPolicyNotConfiguredError],
    ['APPROVAL_REQUIRED', SpendingApprovalRequiredError],
    ['LIMIT_EXCEEDED', SpendingPolicyExceededError],
    ['CONFLICT', SpendingAuthorizationConflictError],
  ] as const)('blocks signing when spending authorization returns %s', async (outcome, ErrorType) => {
    const spendingAuthorizer: SpendingAuthorizer = {
      async authorizeFunding(input) {
        const decision: FundingAuthorizationDecision = outcome === 'APPROVAL_REQUIRED'
          ? {
              outcome,
              authorization: {
                jobId: input.jobId,
                principalId: input.principalId,
                amountBaseUnits: input.amountBaseUnits,
                capability: input.capability,
                status: 'PENDING_APPROVAL',
                reservedAt: input.requestedAt,
                approvalExpiresAt: input.approvalExpiresAt,
                approvedBy: null,
                approvedAt: null,
              },
            }
          : { outcome };
        return decision;
      },
    };
    const { service, gateway } = createService('5000000000000000000', spendingAuthorizer);

    await expect(service.fundJob(quotedJob.id, {}, context)).rejects.toBeInstanceOf(ErrorType);
    expect(gateway.prepareCalls).toBe(0);
  });

  it('passes the frozen job amount and capability to the spending authorizer', async () => {
    const calls: unknown[] = [];
    const spendingAuthorizer: SpendingAuthorizer = {
      async authorizeFunding(input) {
        calls.push(input);
        return {
          outcome: 'AUTHORIZED',
          authorization: {
            jobId: input.jobId,
            principalId: input.principalId,
            amountBaseUnits: input.amountBaseUnits,
            capability: input.capability,
            status: 'AUTHORIZED',
            reservedAt: input.requestedAt,
            approvalExpiresAt: null,
            approvedBy: null,
            approvedAt: null,
          },
        };
      },
    };
    const { service, gateway } = createService('5000000000000000000', spendingAuthorizer);

    await service.fundJob(quotedJob.id, {}, context);
    expect(calls).toEqual([
      {
        jobId: quotedJob.id,
        principalId: context.actor.id,
        amountBaseUnits: quotedJob.budgetAmountBaseUnits,
        capability: 'code',
        requestedAt: '2026-08-23T00:00:02.000Z',
        approvalExpiresAt: '2026-08-24T00:00:02.000Z',
      },
    ]);
    expect(gateway.prepareCalls).toBe(1);
  });

  it('does not reserve spending capacity for a job that is not fundable', async () => {
    let authorizationCalls = 0;
    const spendingAuthorizer: SpendingAuthorizer = {
      async authorizeFunding() {
        authorizationCalls += 1;
        return { outcome: 'POLICY_NOT_FOUND' };
      },
    };
    const draftJob: Job = { ...quotedJob, state: 'DRAFT' };
    const { service, gateway } = createService(
      '5000000000000000000',
      spendingAuthorizer,
      draftJob,
    );

    await expect(service.fundJob(draftJob.id, {}, context)).rejects.toBeInstanceOf(
      InvalidJobTransitionError,
    );
    expect(authorizationCalls).toBe(0);
    expect(gateway.prepareCalls).toBe(0);
  });
});
