import { describe, expect, it } from 'vitest';

import {
  ChainOperationFailedError,
  ChainUnavailableError,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobCancellationForbiddenError,
  JobClosureService,
  JobNotExpiredError,
  type BeginJobClosureInput,
  type ConfirmJobClosureInput,
  type CreateJobPersistenceResult,
  type Job,
  type JobClosureGateway,
  type JobClosureOperation,
  type JobClosureRepository,
  type JobClosureResult,
  type JobRepository,
  type PreparedFundingTransaction,
  type TransitionJobPersistenceResult,
} from '../src/index.js';

const hex = (character: string, bytes: number) =>
  `0x${character.repeat(bytes * 2)}` as `0x${string}`;

const fundedJob: Job = {
  id: '0198d462-75c0-7000-8000-000000000051',
  agreement: {
    jobId: '0198d462-75c0-7000-8000-000000000051',
    buyerAgentId: 'erc8004:16602:123',
    title: 'Generate a verified artifact',
    description: 'Return the requested structured result.',
    budget: { token: 'native', maxAmount: '1.00' },
    deadline: '2026-08-24T01:00:00.000Z',
    deliverable: { type: 'data', format: 'json' },
    verification: {
      mode: 'ai',
      minimumScore: 1,
      requirements: ['Return valid JSON'],
    },
    refundPolicy: { onExpiry: true, onFinalFailure: true },
  },
  providerAgentId: null,
  agreementHash: hex('a', 32),
  budgetAmountBaseUnits: '1000000000000000000',
  minimumScoreBps: 10_000,
  state: 'FUNDED',
  version: 3,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:01.000Z',
};

class ClosureJobRepository implements JobRepository {
  public constructor(private readonly job: Job) {}

  public async findById(jobId: string): Promise<Job | null> {
    return jobId === this.job.id ? this.job : null;
  }

  public async create(): Promise<CreateJobPersistenceResult> {
    throw new Error('Not used by closure tests.');
  }

  public async transition(): Promise<TransitionJobPersistenceResult> {
    throw new Error('Not used by closure tests.');
  }

  public async ping(): Promise<void> {}
}

class MemoryClosureRepository implements JobClosureRepository {
  readonly #claims = new Map<string, { requestHash: string; operationId: string | null }>();
  readonly #operations = new Map<string, JobClosureOperation>();
  private currentJob: Job;

  public constructor(job: Job) {
    this.currentJob = job;
  }

  public async beginClosure(input: BeginJobClosureInput): Promise<JobClosureResult> {
    const key = `${input.idempotency.scope}:${input.idempotency.key}`;
    const claim = this.#claims.get(key);
    if (claim !== undefined) {
      if (claim.requestHash !== input.idempotency.requestHash) throw new IdempotencyKeyReusedError();
      return {
        job: this.currentJob,
        operation: claim.operationId === null ? null : this.#operations.get(claim.operationId)!,
        replayed: true,
      };
    }
    const kind = input.operation?.kind ?? (input.startEvent.toState === 'CANCELLED' ? 'CANCEL' : 'EXPIRE');
    if (this.currentJob.state === 'DRAFT' || this.currentJob.state === 'QUOTED') {
      this.currentJob = {
        ...this.currentJob,
        state: kind === 'CANCEL' ? 'CANCELLED' : 'EXPIRED',
        version: this.currentJob.version + 1,
        updatedAt: input.requestedAt,
      };
      this.#claims.set(key, { requestHash: input.idempotency.requestHash, operationId: null });
      return { job: this.currentJob, operation: null, replayed: false };
    }
    if (input.operation === null) throw new ChainUnavailableError();
    if (kind === 'CANCEL' && this.currentJob.state !== 'FUNDED') {
      throw new InvalidJobTransitionError(this.currentJob.state, 'CANCELLED');
    }
    this.#claims.set(key, {
      requestHash: input.idempotency.requestHash,
      operationId: input.operation.id,
    });
    this.#operations.set(input.operation.id, input.operation);
    if (kind === 'EXPIRE') {
      this.currentJob = {
        ...this.currentJob,
        state: 'EXPIRED',
        version: this.currentJob.version + 1,
        updatedAt: input.requestedAt,
      };
    }
    return { job: this.currentJob, operation: input.operation, replayed: false };
  }

  public async savePrepared(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<JobClosureOperation> {
    return this.update(operationId, {
      status: 'PREPARED',
      jobKey: prepared.jobKey,
      serializedTransaction: prepared.serializedTransaction,
      transactionHash: prepared.transactionHash,
      updatedAt,
    });
  }

  public async markBroadcast(operationId: string, updatedAt: string): Promise<JobClosureOperation> {
    return this.update(operationId, { status: 'BROADCAST', updatedAt });
  }

  public async confirmClosure(input: ConfirmJobClosureInput): Promise<JobClosureResult> {
    const operation = this.update(input.operationId, {
      status: 'CONFIRMED',
      serializedTransaction: null,
      blockNumber: input.confirmation.blockNumber,
      updatedAt: input.finalEvent.occurredAt,
    });
    this.currentJob = {
      ...this.currentJob,
      state: operation.kind === 'CANCEL' ? 'CANCELLED' : 'REFUNDED',
      version: this.currentJob.version + 1,
      updatedAt: input.finalEvent.occurredAt,
    };
    return { job: this.currentJob, operation, replayed: false };
  }

  private update(
    operationId: string,
    patch: Partial<JobClosureOperation>,
  ): JobClosureOperation {
    const operation = { ...this.#operations.get(operationId)!, ...patch };
    this.#operations.set(operationId, operation);
    return operation;
  }
}

class MemoryClosureGateway implements JobClosureGateway {
  public readonly chainId = 31_337;
  public readonly contractAddress = hex('1', 20);
  public readonly signerAddress = hex('2', 20);
  public prepareCalls = 0;
  public broadcastCalls = 0;
  public confirmCalls = 0;
  public failNextBroadcast = false;

  public async prepareCancelUnassigned(): Promise<PreparedFundingTransaction> {
    return this.prepare();
  }

  public async prepareExpiredRefund(): Promise<PreparedFundingTransaction> {
    return this.prepare();
  }

  public async broadcastPreparedTransaction(): Promise<`0x${string}`> {
    this.broadcastCalls += 1;
    if (this.failNextBroadcast) {
      this.failNextBroadcast = false;
      throw new Error('RPC unavailable');
    }
    return hex('4', 32);
  }

  public async confirmCancelUnassigned() {
    return this.confirm(null);
  }

  public async confirmExpiredRefund() {
    return this.confirm(hex('9', 20));
  }

  private async prepare(): Promise<PreparedFundingTransaction> {
    this.prepareCalls += 1;
    return {
      jobKey: hex('3', 32),
      transactionHash: hex('4', 32),
      serializedTransaction: hex('5', 100),
      contractAddress: this.contractAddress,
      signerAddress: this.signerAddress,
    };
  }

  private async confirm(provider: `0x${string}` | null) {
    this.confirmCalls += 1;
    return {
      transactionHash: hex('4', 32),
      blockNumber: '51',
      contractAddress: this.contractAddress,
      escrow: {
        jobKey: hex('3', 32),
        buyer: this.signerAddress,
        provider,
        amountBaseUnits: fundedJob.budgetAmountBaseUnits,
        deadline: fundedJob.agreement.deadline,
        state: 4,
        agreementHash: fundedJob.agreementHash,
      },
    };
  }
}

function createService(job: Job, withGateway = true) {
  const gateway = new MemoryClosureGateway();
  const closureRepository = new MemoryClosureRepository(job);
  let id = 100;
  const service = new JobClosureService({
    jobRepository: new ClosureJobRepository(job),
    closureRepository,
    ...(withGateway ? { gateway } : {}),
    clock: () => new Date('2026-08-24T02:00:00.000Z'),
    idGenerator: () => `0198d462-75c0-7000-8000-${String(++id).padStart(12, '0')}`,
  });
  return { service, gateway };
}

const operatorContext = {
  actor: { type: 'operator' as const, id: 'operator_closure_test' },
  idempotencyKey: 'cancel-job-idempotency-001',
};

describe('JobClosureService', () => {
  it('cancels an unfunded job without requiring chain configuration', async () => {
    const draftJob = { ...fundedJob, state: 'DRAFT' as const, version: 1 };
    const { service, gateway } = createService(draftJob, false);

    const cancelled = await service.cancelJob(draftJob.id, {}, operatorContext);
    const replayed = await service.cancelJob(draftJob.id, {}, operatorContext);

    expect(cancelled.job.state).toBe('CANCELLED');
    expect(cancelled.operation).toBeNull();
    expect(replayed.replayed).toBe(true);
    expect(gateway.prepareCalls).toBe(0);
  });

  it('rejects cancellation by an unrelated agent identity', async () => {
    const { service, gateway } = createService(fundedJob);

    await expect(service.cancelJob(fundedJob.id, {}, {
      actor: { type: 'agent', id: 'erc8004:16602:999' },
      idempotencyKey: 'cancel-job-idempotency-002',
    })).rejects.toBeInstanceOf(JobCancellationForbiddenError);
    expect(gateway.prepareCalls).toBe(0);
  });

  it('rejects expiry processing before the frozen deadline', async () => {
    const futureJob = {
      ...fundedJob,
      agreement: { ...fundedJob.agreement, deadline: '2026-08-25T00:00:00.000Z' },
    };
    const { service, gateway } = createService(futureJob);

    await expect(service.expireJob(futureJob.id, {}, {
      ...operatorContext,
      idempotencyKey: 'expire-job-idempotency-001',
    })).rejects.toBeInstanceOf(JobNotExpiredError);
    expect(gateway.prepareCalls).toBe(0);
  });

  it('refunds a funded unassigned job and replays the confirmed closure', async () => {
    const { service, gateway } = createService(fundedJob);

    const cancelled = await service.cancelJob(fundedJob.id, {}, operatorContext);
    const replayed = await service.cancelJob(fundedJob.id, {}, operatorContext);

    expect(cancelled.job.state).toBe('CANCELLED');
    expect(cancelled.operation).toMatchObject({ kind: 'CANCEL', status: 'CONFIRMED' });
    expect(replayed.replayed).toBe(true);
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.broadcastCalls).toBe(1);
    expect(gateway.confirmCalls).toBe(1);
  });

  it('resumes the same signed refund after a broadcast failure', async () => {
    const { service, gateway } = createService(fundedJob);
    gateway.failNextBroadcast = true;

    await expect(service.cancelJob(fundedJob.id, {}, operatorContext)).rejects.toBeInstanceOf(
      ChainOperationFailedError,
    );
    const cancelled = await service.cancelJob(fundedJob.id, {}, operatorContext);

    expect(cancelled.job.state).toBe('CANCELLED');
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.broadcastCalls).toBe(2);
    expect(gateway.confirmCalls).toBe(1);
  });
});
