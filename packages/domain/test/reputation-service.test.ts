import { describe, expect, it, vi } from 'vitest';

import {
  JobNotReputableError,
  ReputationService,
  type Job,
  type JobRepository,
  type ReputationEvent,
  type ReputationGateway,
  type ReputationOperation,
  type ReputationRepository,
  type VerificationRecord,
  type VerificationRepository,
} from '../src/index.js';

const jobId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b80';
const verificationRunId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b81';
const reportRoot = `0x${'a'.repeat(64)}` as const;

function finalizedJob(state: 'PAID' | 'REFUNDED' | 'PASSED' = 'PAID'): Job {
  return {
    id: jobId,
    agreement: {
      jobId,
      buyerAgentId: 'erc8004:31337:123',
      providerAgentId: 'erc8004:31337:456',
      title: 'Verify an outcome',
      description: 'Return a deterministic result.',
      budget: { token: 'native', maxAmount: '1' },
      deadline: '2030-01-01T00:00:00.000Z',
      deliverable: { type: 'code', format: 'git_patch' },
      verification: {
        mode: 'deterministic',
        minimumScore: 1,
        requirements: ['The result must pass.'],
        deterministicChecks: [{
          id: 'passed',
          kind: 'json_path_equals',
          description: 'The result passed.',
          path: ['passed'],
          expected: true,
          weightBps: 10_000,
          hardFailure: true,
        }],
      },
      refundPolicy: { onExpiry: true, onFinalFailure: true },
    },
    providerAgentId: 'erc8004:31337:456',
    agreementHash: `0x${'1'.repeat(64)}`,
    budgetAmountBaseUnits: '1000000000000000000',
    minimumScoreBps: 10_000,
    state,
    version: 11,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T01:00:00.000Z',
  };
}

function verification(outcome: 'PASS' | 'FAIL'): VerificationRecord {
  return {
    runId: verificationRunId,
    jobId,
    submissionId: '018f7f67-8d48-7c9f-8c5e-57a6a1f53b82',
    mode: 'deterministic',
    outcome,
    scoreBps: outcome === 'PASS' ? 10_000 : 0,
    minimumScoreBps: 10_000,
    verifierVersion: 'agentclear-deterministic-v1',
    ai: null,
    reportHash: `0x${'2'.repeat(64)}`,
    reportStorageRootHash: reportRoot,
    reportStorageTransactionHash: `0x${'3'.repeat(64)}`,
    reportStorageTransactionSequence: 1,
    reportSizeBytes: 100,
    checks: [],
    startedAt: '2026-08-23T00:30:00.000Z',
    completedAt: '2026-08-23T00:31:00.000Z',
  };
}

function createHarness(job: Job, record: VerificationRecord) {
  let operation: ReputationOperation | null = null;
  let event: ReputationEvent | null = null;
  const repository: ReputationRepository = {
    async findByIdempotency(scope, key) {
      return operation?.idempotencyScope === scope && operation.idempotencyKey === key
        ? { operation, reputation: event, replayed: true }
        : null;
    },
    async beginReputation(input) {
      operation = input.operation;
      return { operation, reputation: null, replayed: false };
    },
    async savePrepared(_operationId, prepared, updatedAt) {
      if (operation === null) throw new Error('Missing operation.');
      operation = { ...operation, ...prepared, status: 'PREPARED', updatedAt };
      return operation;
    },
    async markBroadcast(_operationId, updatedAt) {
      if (operation === null) throw new Error('Missing operation.');
      operation = { ...operation, status: 'BROADCAST', updatedAt };
      return operation;
    },
    async confirmReputation(input) {
      if (
        operation === null
        || operation.contractAddress === null
        || operation.identityRegistryAddress === null
        || operation.agentTokenId === null
      ) throw new Error('Missing prepared operation.');
      const registryAddress = operation.contractAddress;
      const identityRegistryAddress = operation.identityRegistryAddress;
      const agentTokenId = operation.agentTokenId;
      operation = {
        ...operation,
        status: 'CONFIRMED',
        serializedTransaction: null,
        blockNumber: input.blockNumber,
        feedbackIndex: input.feedbackIndex,
        updatedAt: input.createdAt,
      };
      event = {
        jobId,
        providerAgentId: operation.providerAgentId,
        registryAddress,
        identityRegistryAddress,
        agentTokenId,
        clientAddress: input.clientAddress,
        value: operation.value,
        valueDecimals: operation.valueDecimals,
        tag1: operation.tag1,
        tag2: operation.tag2,
        feedbackUri: operation.feedbackUri,
        feedbackHash: operation.feedbackHash,
        transactionHash: input.transactionHash,
        blockNumber: input.blockNumber,
        feedbackIndex: input.feedbackIndex,
        createdAt: input.createdAt,
      };
      return { operation, reputation: event, replayed: false };
    },
  };
  const gateway: ReputationGateway = {
    prepareFeedback: vi.fn(async () => ({
      agentTokenId: '456',
      transactionHash: `0x${'4'.repeat(64)}` as const,
      serializedTransaction: `0x${'5'.repeat(128)}` as const,
      contractAddress: `0x${'6'.repeat(40)}` as const,
      identityRegistryAddress: `0x${'7'.repeat(40)}` as const,
      signerAddress: `0x${'8'.repeat(40)}` as const,
    })),
    broadcastPreparedFeedback: vi.fn(async (prepared) => prepared.transactionHash),
    confirmFeedback: vi.fn(async (_command, prepared) => ({
      transactionHash: prepared.transactionHash,
      blockNumber: '42',
      feedbackIndex: '1',
      clientAddress: `0x${'8'.repeat(40)}` as const,
    })),
  };
  const service = new ReputationService({
    jobRepository: {
      findById: vi.fn(async () => job),
    } as unknown as JobRepository,
    verificationRepository: {
      listByJob: vi.fn(async () => [record]),
    } as unknown as VerificationRepository,
    reputationRepository: repository,
    gateway,
    clock: () => new Date('2026-08-23T02:00:00.000Z'),
    idGenerator: () => '018f7f67-8d48-7c9f-8c5e-57a6a1f53b83',
  });
  return { gateway, repository, service };
}

describe('ReputationService', () => {
  it('writes PASS feedback from a finalized paid outcome and replays it exactly', async () => {
    const { gateway, service } = createHarness(finalizedJob('PAID'), verification('PASS'));
    const context = {
      actor: { type: 'operator' as const, id: 'operator_test' },
      idempotencyKey: 'reputation-001',
    };

    const first = await service.recordOutcome(jobId, {}, context);
    const replay = await service.recordOutcome(jobId, {}, context);

    expect(first.reputation).toMatchObject({
      providerAgentId: 'erc8004:31337:456',
      value: '100',
      valueDecimals: 0,
      tag1: 'agentclear.outcome',
      tag2: 'code',
      feedbackUri: `0g://${reportRoot}`,
      feedbackHash: `0x${'0'.repeat(64)}`,
      feedbackIndex: '1',
    });
    expect(replay.replayed).toBe(true);
    expect(gateway.prepareFeedback).toHaveBeenCalledOnce();
    expect(gateway.broadcastPreparedFeedback).toHaveBeenCalledOnce();
    expect(gateway.confirmFeedback).toHaveBeenCalledOnce();
  });

  it('refuses feedback before the job has reached a settlement terminal state', async () => {
    const { gateway, service } = createHarness(finalizedJob('PASSED'), verification('PASS'));

    await expect(service.recordOutcome(jobId, {}, {
      actor: { type: 'operator', id: 'operator_test' },
      idempotencyKey: 'reputation-002',
    })).rejects.toBeInstanceOf(JobNotReputableError);
    expect(gateway.prepareFeedback).not.toHaveBeenCalled();
  });

  it('refuses outcome feedback that does not match payment versus refund state', async () => {
    const { gateway, service } = createHarness(finalizedJob('REFUNDED'), verification('PASS'));

    await expect(service.recordOutcome(jobId, {}, {
      actor: { type: 'operator', id: 'operator_test' },
      idempotencyKey: 'reputation-003',
    })).rejects.toBeInstanceOf(JobNotReputableError);
    expect(gateway.prepareFeedback).not.toHaveBeenCalled();
  });
});
