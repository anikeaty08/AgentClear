import { describe, expect, it } from 'vitest';

import {
  AssignmentService,
  ChainOperationFailedError,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  ProviderMismatchError,
  type AssignmentGateway,
  type AssignmentOperation,
  type AssignmentRepository,
  type AssignmentResult,
  type BeginAssignmentInput,
  type ConfirmAssignmentPersistenceInput,
  type CreateJobPersistenceResult,
  type Job,
  type JobRepository,
  type PreparedFundingTransaction,
  type TransitionJobPersistenceResult,
} from '../src/index.js';

const hex = (character: string, bytes: number) =>
  `0x${character.repeat(bytes * 2)}` as `0x${string}`;

const fundedJob: Job = {
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
  state: 'FUNDED',
  version: 3,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:01.000Z',
};

class AssignmentJobRepository implements JobRepository {
  public constructor(public job: Job) {}

  public async findById(jobId: string): Promise<Job | null> {
    return jobId === this.job.id ? this.job : null;
  }

  public async create(): Promise<CreateJobPersistenceResult> {
    throw new Error('Not used by AssignmentService tests.');
  }

  public async transition(): Promise<TransitionJobPersistenceResult> {
    throw new Error('Not used by AssignmentService tests.');
  }

  public async ping(): Promise<void> {}
}

class MemoryAssignmentRepository implements AssignmentRepository {
  readonly #operations = new Map<string, AssignmentOperation>();
  readonly #claims = new Map<string, { requestHash: string; operationId: string }>();

  public constructor(private readonly jobRepository: AssignmentJobRepository) {}

  public async beginAssignment(input: BeginAssignmentInput): Promise<AssignmentResult> {
    const key = `${input.idempotency.scope}:${input.idempotency.key}`;
    const claim = this.#claims.get(key);
    if (claim !== undefined) {
      if (claim.requestHash !== input.idempotency.requestHash) throw new IdempotencyKeyReusedError();
      return {
        job: this.jobRepository.job,
        operation: this.#operations.get(claim.operationId)!,
        replayed: true,
      };
    }
    if (this.jobRepository.job.state !== 'FUNDED') {
      throw new InvalidJobTransitionError(this.jobRepository.job.state, 'ASSIGNED');
    }
    this.jobRepository.job = {
      ...this.jobRepository.job,
      state: 'OPEN',
      version: this.jobRepository.job.version + 1,
      updatedAt: input.openEvent.occurredAt,
    };
    this.#claims.set(key, {
      requestHash: input.idempotency.requestHash,
      operationId: input.operation.id,
    });
    this.#operations.set(input.operation.id, input.operation);
    return { job: this.jobRepository.job, operation: input.operation, replayed: false };
  }

  public async savePreparedAssignment(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<AssignmentOperation> {
    return this.update(operationId, {
      status: 'PREPARED',
      jobKey: prepared.jobKey,
      serializedTransaction: prepared.serializedTransaction,
      transactionHash: prepared.transactionHash,
      updatedAt,
    });
  }

  public async markAssignmentBroadcast(
    operationId: string,
    updatedAt: string,
  ): Promise<AssignmentOperation> {
    return this.update(operationId, { status: 'BROADCAST', updatedAt });
  }

  public async confirmAssignment(
    input: ConfirmAssignmentPersistenceInput,
  ): Promise<AssignmentResult> {
    const operation = this.update(input.operationId, {
      status: 'CONFIRMED',
      serializedTransaction: null,
      blockNumber: input.confirmation.blockNumber,
      updatedAt: input.event.occurredAt,
    });
    this.jobRepository.job = {
      ...this.jobRepository.job,
      providerAgentId: operation.providerAgentId,
      state: 'ASSIGNED',
      version: this.jobRepository.job.version + 1,
      updatedAt: input.event.occurredAt,
    };
    return { job: this.jobRepository.job, operation, replayed: false };
  }

  private update(
    operationId: string,
    patch: Partial<AssignmentOperation>,
  ): AssignmentOperation {
    const operation = { ...this.#operations.get(operationId)!, ...patch };
    this.#operations.set(operationId, operation);
    return operation;
  }
}

class MemoryAssignmentGateway implements AssignmentGateway {
  public readonly chainId = 31_337;
  public readonly contractAddress = hex('1', 20);
  public readonly signerAddress = hex('2', 20);
  public prepareCalls = 0;
  public broadcastCalls = 0;
  public confirmCalls = 0;
  public failNextBroadcast = false;

  public async prepareAssignProvider(): Promise<PreparedFundingTransaction> {
    this.prepareCalls += 1;
    return {
      jobKey: hex('3', 32),
      transactionHash: hex('4', 32),
      serializedTransaction: hex('5', 100),
      contractAddress: this.contractAddress,
      signerAddress: this.signerAddress,
    };
  }

  public async broadcastPreparedTransaction(): Promise<`0x${string}`> {
    this.broadcastCalls += 1;
    if (this.failNextBroadcast) {
      this.failNextBroadcast = false;
      throw new Error('RPC unavailable');
    }
    return hex('4', 32);
  }

  public async confirmAssignProvider(
    _jobId: string,
    providerAddress: `0x${string}`,
  ) {
    this.confirmCalls += 1;
    return {
      transactionHash: hex('4', 32),
      blockNumber: '43',
      contractAddress: this.contractAddress,
      escrow: { provider: providerAddress },
    };
  }
}

function createService(job: Job = fundedJob) {
  const jobRepository = new AssignmentJobRepository(job);
  const repository = new MemoryAssignmentRepository(jobRepository);
  const gateway = new MemoryAssignmentGateway();
  let id = 0;
  const service = new AssignmentService({
    jobRepository,
    assignmentRepository: repository,
    gateway,
    clock: () => new Date('2026-08-23T00:00:02.000Z'),
    idGenerator: () => `0198d462-75c0-7000-8000-${String(++id).padStart(12, '0')}`,
  });
  return { service, gateway };
}

const input = {
  providerAgentId: 'erc8004:16602:456',
  providerAddress: hex('6', 20),
};
const context = {
  actor: { type: 'operator' as const, id: 'operator_test' },
  idempotencyKey: 'assign-job-idempotency-001',
};

describe('AssignmentService', () => {
  it('opens, persists, broadcasts, confirms, and replays one provider assignment', async () => {
    const { service, gateway } = createService();

    const assigned = await service.assignProvider(fundedJob.id, input, context);
    const replayed = await service.assignProvider(fundedJob.id, input, context);

    expect(assigned.job.state).toBe('ASSIGNED');
    expect(assigned.operation.status).toBe('CONFIRMED');
    expect(assigned.operation.serializedTransaction).toBeNull();
    expect(replayed.replayed).toBe(true);
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.broadcastCalls).toBe(1);
    expect(gateway.confirmCalls).toBe(1);
  });

  it('resumes the persisted signed transaction after a broadcast failure', async () => {
    const { service, gateway } = createService();
    gateway.failNextBroadcast = true;

    await expect(service.assignProvider(fundedJob.id, input, context)).rejects.toBeInstanceOf(
      ChainOperationFailedError,
    );
    const assigned = await service.assignProvider(fundedJob.id, input, context);

    expect(assigned.job.state).toBe('ASSIGNED');
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.broadcastCalls).toBe(2);
    expect(gateway.confirmCalls).toBe(1);
  });

  it('rejects the buyer identity or a provider outside a preselected agreement', async () => {
    const { service, gateway } = createService({
      ...fundedJob,
      agreement: { ...fundedJob.agreement, providerAgentId: 'erc8004:16602:999' },
    });

    await expect(
      service.assignProvider(fundedJob.id, input, context),
    ).rejects.toBeInstanceOf(ProviderMismatchError);
    expect(gateway.prepareCalls).toBe(0);
  });
});
