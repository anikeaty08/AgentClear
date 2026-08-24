import {
  ChainSignerBusyError,
  IdempotencyKeyReusedError,
  JobNotFoundError,
  JobNotReceiptableError,
  ReceiptInProgressError,
  portableReceiptSchema,
  type FinalizationRecord,
  type Job,
  type ReceiptOperation,
  type ReceiptPersistenceResult,
  type ReceiptRecord,
  type ReceiptRepository,
  type ReceiptSource,
  type ReputationEvent,
  type SettlementOperation,
  type Submission,
} from '@agentclear/domain';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import {
  escrowFundingOperations,
  idempotencyRecords,
  jobAssignmentOperations,
  jobClosureOperations,
  jobs,
  receiptOperations,
  receipts,
  refunds,
  reputationEvents,
  reputationOperations,
  settlementOperations,
  settlements,
  submissionOperations,
  submissions,
  verificationOperations,
  verificationReports,
  verificationRuns,
} from './schema.js';

function rowToJob(row: typeof jobs.$inferSelect): Job {
  return {
    id: row.id,
    agreement: row.agreementSnapshot,
    providerAgentId: row.providerAgentId,
    agreementHash: row.agreementHash as `0x${string}`,
    budgetAmountBaseUnits: row.budgetAmountBaseUnits,
    minimumScoreBps: row.minimumScoreBps,
    state: row.state,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToSubmission(row: typeof submissions.$inferSelect): Submission {
  return {
    id: row.id,
    jobId: row.jobId,
    providerAgentId: row.providerAgentId,
    submissionHash: row.submissionHash as `0x${string}`,
    contentType: 'application/json',
    storageRootHash: row.storageRootHash as `0x${string}`,
    storageTransactionHash: row.storageTransactionHash as `0x${string}` | null,
    storageTransactionSequence: row.storageTransactionSequence,
    sizeBytes: row.sizeBytes,
    submittedAt: row.submittedAt.toISOString(),
  };
}

function rowToSettlementOperation(
  row: typeof settlementOperations.$inferSelect,
): SettlementOperation {
  return {
    id: row.id,
    jobId: row.jobId,
    submissionId: row.submissionId,
    verificationRunId: row.verificationRunId,
    outcome: row.outcome as SettlementOperation['outcome'],
    status: row.status,
    agreementHash: row.agreementHash as `0x${string}`,
    submissionHash: row.submissionHash as `0x${string}`,
    verificationReportHash: row.verificationReportHash as `0x${string}`,
    buyerAgentId: row.buyerAgentId,
    providerAgentId: row.providerAgentId,
    jobKey: row.jobKey as `0x${string}` | null,
    outcomeContractAddress: row.outcomeContractAddress as `0x${string}` | null,
    outcomeSerializedTransaction: row.outcomeSerializedTransaction as `0x${string}` | null,
    outcomeTransactionHash: row.outcomeTransactionHash as `0x${string}` | null,
    outcomeBlockNumber: row.outcomeBlockNumber,
    escrowContractAddress: row.escrowContractAddress as `0x${string}` | null,
    escrowSerializedTransaction: row.escrowSerializedTransaction as `0x${string}` | null,
    escrowTransactionHash: row.escrowTransactionHash as `0x${string}` | null,
    escrowBlockNumber: row.escrowBlockNumber,
    signerAddress: row.signerAddress as `0x${string}` | null,
    idempotencyScope: row.idempotencyScope,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash as `0x${string}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToReputation(row: typeof reputationEvents.$inferSelect): ReputationEvent {
  return {
    jobId: row.jobId,
    providerAgentId: row.providerAgentId,
    registryAddress: row.registryAddress as `0x${string}`,
    identityRegistryAddress: row.identityRegistryAddress as `0x${string}`,
    agentTokenId: row.agentTokenId,
    clientAddress: row.clientAddress as `0x${string}`,
    value: row.value,
    valueDecimals: row.valueDecimals,
    tag1: row.tag1,
    tag2: row.tag2,
    feedbackUri: row.feedbackUri,
    feedbackHash: row.feedbackHash as `0x${string}`,
    transactionHash: row.transactionHash as `0x${string}`,
    blockNumber: row.blockNumber,
    feedbackIndex: row.feedbackIndex,
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToOperation(row: typeof receiptOperations.$inferSelect): ReceiptOperation {
  return {
    id: row.id,
    receiptId: row.receiptId,
    jobId: row.jobId,
    status: row.status,
    canonicalPayload: row.canonicalPayload,
    receiptHash: row.receiptHash as `0x${string}`,
    storageRootHash: row.storageRootHash as `0x${string}` | null,
    storageTransactionHash: row.storageTransactionHash as `0x${string}` | null,
    storageTransactionSequence: row.storageTransactionSequence,
    sizeBytes: row.sizeBytes,
    idempotencyScope: row.idempotencyScope,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash as `0x${string}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToReceipt(row: typeof receipts.$inferSelect): ReceiptRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    version: '1',
    receiptHash: row.receiptHash as `0x${string}`,
    receipt: portableReceiptSchema.parse(row.receipt),
    canonicalPayload: row.canonicalPayload,
    storageRootHash: row.storageRootHash as `0x${string}`,
    storageTransactionHash: row.storageTransactionHash as `0x${string}` | null,
    storageTransactionSequence: row.storageTransactionSequence,
    sizeBytes: row.sizeBytes,
    publishedAt: row.publishedAt.toISOString(),
  };
}

export class PostgresReceiptRepository implements ReceiptRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async findSource(jobId: string): Promise<ReceiptSource | null> {
    const [row] = await this.database.select({
      job: jobs,
      submission: submissions,
      verification: verificationRuns,
      report: verificationReports,
      settlementOperation: settlementOperations,
      settlement: settlements,
      refund: refunds,
      reputation: reputationEvents,
    }).from(settlementOperations)
      .innerJoin(jobs, eq(jobs.id, settlementOperations.jobId))
      .innerJoin(submissions, eq(submissions.id, settlementOperations.submissionId))
      .innerJoin(
        verificationRuns,
        eq(verificationRuns.id, settlementOperations.verificationRunId),
      )
      .innerJoin(verificationReports, eq(verificationReports.runId, verificationRuns.id))
      .innerJoin(reputationEvents, eq(reputationEvents.jobId, jobs.id))
      .leftJoin(settlements, eq(settlements.jobId, jobs.id))
      .leftJoin(refunds, eq(refunds.jobId, jobs.id))
      .where(and(
        eq(jobs.id, jobId),
        eq(settlementOperations.status, 'CONFIRMED'),
      ))
      .limit(1);
    if (row === undefined) return null;
    if ((row.settlement === null) === (row.refund === null)) return null;
    const finalizationRow = row.settlement ?? row.refund;
    if (finalizationRow === null) return null;
    const finalization: FinalizationRecord = {
      jobId,
      kind: row.settlement === null ? 'REFUND' : 'PAYMENT',
      amountBaseUnits: finalizationRow.amountBaseUnits,
      outcomeTransactionHash: finalizationRow.outcomeTransactionHash as `0x${string}`,
      outcomeBlockNumber: finalizationRow.outcomeBlockNumber,
      escrowTransactionHash: finalizationRow.escrowTransactionHash as `0x${string}`,
      escrowBlockNumber: finalizationRow.escrowBlockNumber,
      finalizedAt: finalizationRow.finalizedAt.toISOString(),
    };
    return {
      job: rowToJob(row.job),
      submission: rowToSubmission(row.submission),
      verification: {
        runId: row.verification.id,
        jobId: row.verification.jobId,
        submissionId: row.verification.submissionId,
        mode: row.verification.mode as ReceiptSource['verification']['mode'],
        outcome: row.verification.outcome,
        scoreBps: row.verification.scoreBps,
        minimumScoreBps: row.verification.minimumScoreBps,
        verifierVersion: row.verification.verifierVersion,
        ai: row.verification.aiResult,
        reportHash: row.report.reportHash as `0x${string}`,
        reportStorageRootHash: row.report.storageRootHash as `0x${string}`,
        reportStorageTransactionHash: row.report.storageTransactionHash as `0x${string}` | null,
        reportStorageTransactionSequence: row.report.storageTransactionSequence,
        reportSizeBytes: row.report.sizeBytes,
        startedAt: row.verification.startedAt.toISOString(),
        completedAt: row.verification.completedAt.toISOString(),
      },
      settlementOperation: rowToSettlementOperation(row.settlementOperation),
      finalization,
      reputation: rowToReputation(row.reputation),
    };
  }

  public async findByIdempotency(
    scope: string,
    key: string,
  ): Promise<ReceiptPersistenceResult | null> {
    const [row] = await this.database.select().from(receiptOperations).where(and(
      eq(receiptOperations.idempotencyScope, scope),
      eq(receiptOperations.idempotencyKey, key),
    )).limit(1);
    if (row === undefined) return null;
    const operation = rowToOperation(row);
    return {
      operation,
      receipt: operation.status === 'CONFIRMED' ? await this.findById(operation.receiptId) : null,
      replayed: true,
    };
  }

  public async beginReceipt(input: {
    operation: ReceiptOperation;
    idempotency: {
      scope: string;
      key: string;
      requestHash: `0x${string}`;
      resourceId: string;
      expiresAt: string;
    };
  }): Promise<ReceiptPersistenceResult> {
    const base = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentclear:chain-signer-state'))`,
      );
      const [job] = await transaction.select().from(jobs)
        .where(eq(jobs.id, input.operation.jobId)).for('update').limit(1);
      if (job === undefined) throw new JobNotFoundError(input.operation.jobId);
      if (job.state !== 'PAID' && job.state !== 'REFUNDED') throw new JobNotReceiptableError();
      const [existingForJob] = await transaction.select().from(receiptOperations)
        .where(eq(receiptOperations.jobId, job.id)).limit(1);
      if (existingForJob !== undefined) {
        if (
          existingForJob.idempotencyScope === input.idempotency.scope
          && existingForJob.idempotencyKey === input.idempotency.key
          && existingForJob.requestHash === input.idempotency.requestHash
        ) return { operation: rowToOperation(existingForJob), replayed: true };
        if (existingForJob.status !== 'CONFIRMED') throw new ReceiptInProgressError(job.id);
        return { operation: rowToOperation(existingForJob), replayed: true };
      }
      const createdAt = new Date(input.operation.createdAt);
      const [claim] = await transaction.insert(idempotencyRecords).values({
        scope: input.idempotency.scope,
        key: input.idempotency.key,
        requestHash: input.idempotency.requestHash,
        resourceId: input.idempotency.resourceId,
        createdAt,
        expiresAt: new Date(input.idempotency.expiresAt),
      }).onConflictDoNothing().returning({ resourceId: idempotencyRecords.resourceId });
      if (claim === undefined) {
        const [existingClaim] = await transaction.select().from(idempotencyRecords).where(and(
          eq(idempotencyRecords.scope, input.idempotency.scope),
          eq(idempotencyRecords.key, input.idempotency.key),
        )).limit(1);
        if (
          existingClaim === undefined
          || existingClaim.requestHash !== input.idempotency.requestHash
        ) throw new IdempotencyKeyReusedError();
        throw new Error('Receipt idempotency record references missing state.');
      }
      const [confirmedSettlement] = await transaction.select({ id: settlementOperations.id })
        .from(settlementOperations).where(and(
          eq(settlementOperations.jobId, job.id),
          eq(settlementOperations.status, 'CONFIRMED'),
        )).limit(1);
      const [confirmedReputation] = await transaction.select({ jobId: reputationEvents.jobId })
        .from(reputationEvents).where(eq(reputationEvents.jobId, job.id)).limit(1);
      if (confirmedSettlement === undefined || confirmedReputation === undefined) {
        throw new JobNotReceiptableError();
      }
      const [activeFunding] = await transaction.select({ id: escrowFundingOperations.id })
        .from(escrowFundingOperations)
        .where(inArray(escrowFundingOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']))
        .limit(1);
      const [activeAssignment] = await transaction.select({ id: jobAssignmentOperations.id })
        .from(jobAssignmentOperations)
        .where(inArray(jobAssignmentOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']))
        .limit(1);
      const [activeSubmission] = await transaction.select({ id: submissionOperations.id })
        .from(submissionOperations)
        .where(inArray(submissionOperations.status, ['CREATED', 'STORING']))
        .limit(1);
      const [activeVerification] = await transaction.select({ id: verificationOperations.id })
        .from(verificationOperations)
        .where(inArray(verificationOperations.status, ['CREATED', 'EVALUATED', 'STORING']))
        .limit(1);
      const [activeSettlement] = await transaction.select({ id: settlementOperations.id })
        .from(settlementOperations)
        .where(ne(settlementOperations.status, 'CONFIRMED'))
        .limit(1);
      const [activeReputation] = await transaction.select({ id: reputationOperations.id })
        .from(reputationOperations)
        .where(ne(reputationOperations.status, 'CONFIRMED'))
        .limit(1);
      const [activeReceipt] = await transaction.select({ id: receiptOperations.id })
        .from(receiptOperations)
        .where(ne(receiptOperations.status, 'CONFIRMED'))
        .limit(1);
      const [activeClosure] = await transaction.select({ id: jobClosureOperations.id })
        .from(jobClosureOperations)
        .where(inArray(jobClosureOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']))
        .limit(1);
      if (
        activeFunding !== undefined
        || activeAssignment !== undefined
        || activeSubmission !== undefined
        || activeVerification !== undefined
        || activeSettlement !== undefined
        || activeReputation !== undefined
        || activeReceipt !== undefined
        || activeClosure !== undefined
      ) throw new ChainSignerBusyError();
      const [inserted] = await transaction.insert(receiptOperations).values({
        id: input.operation.id,
        receiptId: input.operation.receiptId,
        jobId: input.operation.jobId,
        status: 'CREATED',
        canonicalPayload: input.operation.canonicalPayload,
        receiptHash: input.operation.receiptHash,
        sizeBytes: input.operation.sizeBytes,
        idempotencyScope: input.operation.idempotencyScope,
        idempotencyKey: input.operation.idempotencyKey,
        requestHash: input.operation.requestHash,
        createdAt,
        updatedAt: createdAt,
      }).returning();
      if (inserted === undefined) throw new Error('Receipt operation insert returned no row.');
      return { operation: rowToOperation(inserted), replayed: false };
    });
    return {
      ...base,
      receipt: base.operation.status === 'CONFIRMED'
        ? await this.findById(base.operation.receiptId)
        : null,
    };
  }

  public async markStoring(operationId: string, updatedAt: string): Promise<ReceiptOperation> {
    const [row] = await this.database.update(receiptOperations).set({
      status: 'STORING',
      updatedAt: new Date(updatedAt),
    }).where(and(
      eq(receiptOperations.id, operationId),
      eq(receiptOperations.status, 'CREATED'),
    )).returning();
    if (row === undefined) throw new Error('Receipt operation was not ready for Storage.');
    return rowToOperation(row);
  }

  public async confirmReceipt(input: {
    operationId: string;
    receipt: ReceiptRecord['receipt'];
    storage: {
      rootHash: `0x${string}`;
      transactionHash: `0x${string}` | null;
      transactionSequence: number;
      sizeBytes: number;
      verified: true;
    };
    publishedAt: string;
  }): Promise<ReceiptPersistenceResult> {
    return this.database.transaction(async (transaction) => {
      const [operation] = await transaction.select().from(receiptOperations)
        .where(eq(receiptOperations.id, input.operationId)).for('update').limit(1);
      if (operation === undefined) throw new Error('Receipt operation was not found.');
      if (operation.status === 'CONFIRMED') {
        const [receipt] = await transaction.select().from(receipts)
          .where(eq(receipts.id, operation.receiptId)).limit(1);
        if (receipt === undefined) throw new Error('Confirmed receipt was not found.');
        return {
          operation: rowToOperation(operation),
          receipt: rowToReceipt(receipt),
          replayed: true,
        };
      }
      if (
        operation.status !== 'STORING'
        || operation.canonicalPayload === null
        || operation.receiptId !== input.receipt.receiptId
        || operation.jobId !== input.receipt.jobId
        || operation.sizeBytes !== input.storage.sizeBytes
      ) throw new Error('Receipt confirmation does not match the active operation.');
      const publishedAt = new Date(input.publishedAt);
      const [receipt] = await transaction.insert(receipts).values({
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
        publishedAt,
      }).returning();
      const [confirmed] = await transaction.update(receiptOperations).set({
        status: 'CONFIRMED',
        canonicalPayload: null,
        storageRootHash: input.storage.rootHash,
        storageTransactionHash: input.storage.transactionHash,
        storageTransactionSequence: input.storage.transactionSequence,
        updatedAt: publishedAt,
      }).where(eq(receiptOperations.id, operation.id)).returning();
      if (receipt === undefined || confirmed === undefined) {
        throw new Error('Receipt confirmation returned incomplete state.');
      }
      return {
        operation: rowToOperation(confirmed),
        receipt: rowToReceipt(receipt),
        replayed: false,
      };
    });
  }

  public async findById(receiptId: string): Promise<ReceiptRecord | null> {
    const [row] = await this.database.select().from(receipts)
      .where(eq(receipts.id, receiptId)).limit(1);
    return row === undefined ? null : rowToReceipt(row);
  }

  public async findByJob(jobId: string): Promise<ReceiptRecord | null> {
    const [row] = await this.database.select().from(receipts)
      .where(eq(receipts.jobId, jobId)).limit(1);
    return row === undefined ? null : rowToReceipt(row);
  }
}
