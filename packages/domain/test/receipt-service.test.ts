import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  JobNotReceiptableError,
  ReceiptIntegrityFailedError,
  ReceiptService,
  sha256Bytes,
  type EvidenceStorage,
  type ReceiptOperation,
  type ReceiptRecord,
  type ReceiptRepository,
  type ReceiptSource,
} from '../src/index.js';

const jobId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b80';
const submissionId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b81';
const runId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b82';
const receiptId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b83';
const operationId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b84';
const agreementHash = `0x${'1'.repeat(64)}` as const;
const submissionHash = `0x${'2'.repeat(64)}` as const;
const reportHash = `0x${'3'.repeat(64)}` as const;
const reportRoot = `0x${'4'.repeat(64)}` as const;
const outcomeTransactionHash = `0x${'5'.repeat(64)}` as const;
const escrowTransactionHash = `0x${'6'.repeat(64)}` as const;

function source(state: 'PAID' | 'REFUNDED' = 'PAID'): ReceiptSource {
  const outcome = state === 'PAID' ? 'PASS' : 'FAIL';
  return {
    job: {
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
      agreementHash,
      budgetAmountBaseUnits: '1000000000000000000',
      minimumScoreBps: 10_000,
      state,
      version: 11,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T01:00:00.000Z',
    },
    submission: {
      id: submissionId,
      jobId,
      providerAgentId: 'erc8004:31337:456',
      submissionHash,
      contentType: 'application/json',
      storageRootHash: `0x${'7'.repeat(64)}`,
      storageTransactionHash: `0x${'8'.repeat(64)}`,
      storageTransactionSequence: 1,
      sizeBytes: 64,
      submittedAt: '2026-08-23T00:15:00.000Z',
    },
    verification: {
      runId,
      jobId,
      submissionId,
      mode: 'deterministic',
      outcome,
      scoreBps: outcome === 'PASS' ? 10_000 : 0,
      minimumScoreBps: 10_000,
      verifierVersion: 'agentclear-deterministic-v1',
      reportHash,
      reportStorageRootHash: reportRoot,
      reportStorageTransactionHash: `0x${'9'.repeat(64)}`,
      reportStorageTransactionSequence: 2,
      reportSizeBytes: 128,
      startedAt: '2026-08-23T00:30:00.000Z',
      completedAt: '2026-08-23T00:31:00.000Z',
    },
    settlementOperation: {
      id: '018f7f67-8d48-7c9f-8c5e-57a6a1f53b85',
      jobId,
      submissionId,
      verificationRunId: runId,
      outcome,
      status: 'CONFIRMED',
      agreementHash,
      submissionHash,
      verificationReportHash: reportHash,
      buyerAgentId: 'erc8004:31337:123',
      providerAgentId: 'erc8004:31337:456',
      jobKey: `0x${'a'.repeat(64)}`,
      outcomeContractAddress: `0x${'b'.repeat(40)}`,
      outcomeSerializedTransaction: null,
      outcomeTransactionHash,
      outcomeBlockNumber: '41',
      escrowContractAddress: `0x${'c'.repeat(40)}`,
      escrowSerializedTransaction: null,
      escrowTransactionHash,
      escrowBlockNumber: '42',
      signerAddress: `0x${'d'.repeat(40)}`,
      idempotencyScope: 'jobs:settle:operator_test',
      idempotencyKey: 'settlement-001',
      requestHash: `0x${'e'.repeat(64)}`,
      createdAt: '2026-08-23T00:45:00.000Z',
      updatedAt: '2026-08-23T01:00:00.000Z',
    },
    finalization: {
      jobId,
      kind: outcome === 'PASS' ? 'PAYMENT' : 'REFUND',
      amountBaseUnits: '1000000000000000000',
      outcomeTransactionHash,
      outcomeBlockNumber: '41',
      escrowTransactionHash,
      escrowBlockNumber: '42',
      finalizedAt: '2026-08-23T01:00:00.000Z',
    },
    reputation: {
      jobId,
      providerAgentId: 'erc8004:31337:456',
      registryAddress: `0x${'e'.repeat(40)}`,
      identityRegistryAddress: `0x${'f'.repeat(40)}`,
      agentTokenId: '456',
      clientAddress: `0x${'d'.repeat(40)}`,
      value: outcome === 'PASS' ? '100' : '0',
      valueDecimals: 0,
      tag1: 'agentclear.outcome',
      tag2: 'code',
      feedbackUri: `0g://${reportRoot}`,
      feedbackHash: `0x${'0'.repeat(64)}`,
      transactionHash: `0x${'a'.repeat(64)}`,
      blockNumber: '43',
      feedbackIndex: '1',
      createdAt: '2026-08-23T01:01:00.000Z',
    },
  };
}

function createHarness(receiptSource: ReceiptSource) {
  let operation: ReceiptOperation | null = null;
  let receipt: ReceiptRecord | null = null;
  const repository: ReceiptRepository = {
    async findSource(id) {
      return id === jobId ? receiptSource : null;
    },
    async findByIdempotency(scope, key) {
      return operation?.idempotencyScope === scope && operation.idempotencyKey === key
        ? { operation, receipt, replayed: true }
        : null;
    },
    async beginReceipt(input) {
      operation = input.operation;
      return { operation, receipt: null, replayed: false };
    },
    async markStoring(_id, updatedAt) {
      if (operation === null) throw new Error('Missing operation.');
      operation = { ...operation, status: 'STORING', updatedAt };
      return operation;
    },
    async confirmReceipt(input) {
      if (operation === null || operation.canonicalPayload === null) {
        throw new Error('Missing operation.');
      }
      receipt = {
        id: operation.receiptId,
        jobId: operation.jobId,
        version: '1',
        receiptHash: operation.receiptHash,
        receipt: input.receipt,
        canonicalPayload: operation.canonicalPayload,
        storageRootHash: input.storage.rootHash,
        storageTransactionHash: input.storage.transactionHash,
        storageTransactionSequence: input.storage.transactionSequence,
        sizeBytes: input.storage.sizeBytes,
        publishedAt: input.publishedAt,
      };
      operation = {
        ...operation,
        status: 'CONFIRMED',
        canonicalPayload: null,
        storageRootHash: input.storage.rootHash,
        storageTransactionHash: input.storage.transactionHash,
        storageTransactionSequence: input.storage.transactionSequence,
        updatedAt: input.publishedAt,
      };
      return { operation, receipt, replayed: false };
    },
    async findById(id) {
      return receipt?.id === id ? receipt : null;
    },
    async findByJob(id) {
      return receipt?.jobId === id ? receipt : null;
    },
  };
  const storage: EvidenceStorage = {
    uploadVerified: vi.fn(async (data) => ({
      rootHash: sha256Bytes(data),
      transactionHash: `0x${'b'.repeat(64)}` as const,
      transactionSequence: 3,
      sizeBytes: data.byteLength,
      verified: true as const,
    })),
  };
  const ids = [receiptId, operationId];
  const service = new ReceiptService({
    repository,
    storage,
    maxPayloadBytes: 16_384,
    clock: () => new Date('2026-08-23T02:00:00.000Z'),
    idGenerator: () => ids.shift() ?? operationId,
  });
  return { service, storage };
}

describe('ReceiptService', () => {
  it('publishes a canonical receipt and replays without uploading twice', async () => {
    const { service, storage } = createHarness(source());
    const context = {
      actor: { type: 'operator' as const, id: 'operator_test' },
      idempotencyKey: 'receipt-001',
    };

    const first = await service.publishJob(jobId, {}, context);
    const replay = await service.publishJob(jobId, {}, context);

    expect(first.receipt?.receipt).toMatchObject({
      receiptId,
      jobId,
      agreementHash,
      verification: { outcome: 'PASS', reportHash },
      settlement: { kind: 'PAYMENT', amountBaseUnits: '1000000000000000000' },
      reputation: { value: '100', feedbackUri: `0g://${reportRoot}` },
    });
    expect(first.receipt?.receiptHash).toBe(
      `0x${createHash('sha256').update(first.receipt!.canonicalPayload).digest('hex')}`,
    );
    expect(first.receipt?.storageRootHash).toBe(first.receipt?.receiptHash);
    expect(replay.replayed).toBe(true);
    expect(storage.uploadVerified).toHaveBeenCalledOnce();
  });

  it('refuses inconsistent final outcome evidence before Storage publication', async () => {
    const invalid = source('REFUNDED');
    invalid.reputation.value = '100';
    const { service, storage } = createHarness(invalid);

    await expect(service.publishJob(jobId, {}, {
      actor: { type: 'operator', id: 'operator_test' },
      idempotencyKey: 'receipt-002',
    })).rejects.toBeInstanceOf(JobNotReceiptableError);
    expect(storage.uploadVerified).not.toHaveBeenCalled();
  });

  it('refuses to serve durable bytes that no longer match their commitment', async () => {
    const { service } = createHarness(source());
    const published = await service.publishJob(jobId, {}, {
      actor: { type: 'operator', id: 'operator_test' },
      idempotencyKey: 'receipt-003',
    });
    published.receipt!.canonicalPayload = '{}';

    await expect(service.getReceipt(published.receipt!.id)).rejects.toBeInstanceOf(
      ReceiptIntegrityFailedError,
    );
  });
});
