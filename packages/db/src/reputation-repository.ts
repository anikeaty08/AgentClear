import {
  ChainSignerBusyError,
  IdempotencyKeyReusedError,
  JobNotFoundError,
  JobNotReputableError,
  ReputationInProgressError,
  type PreparedReputationTransaction,
  type ReputationEvent,
  type ReputationOperation,
  type ReputationPersistenceResult,
  type ReputationRepository,
} from '@agentclear/domain';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import {
  escrowFundingOperations,
  idempotencyRecords,
  jobAssignmentOperations,
  jobClosureOperations,
  jobs,
  reputationEvents,
  reputationOperations,
  receiptOperations,
  settlementOperations,
  submissionOperations,
  verificationOperations,
} from './schema.js';

function rowToOperation(row: typeof reputationOperations.$inferSelect): ReputationOperation {
  return {
    id: row.id,
    jobId: row.jobId,
    verificationRunId: row.verificationRunId,
    providerAgentId: row.providerAgentId,
    outcome: row.outcome as ReputationOperation['outcome'],
    value: row.value,
    valueDecimals: row.valueDecimals,
    tag1: row.tag1,
    tag2: row.tag2,
    feedbackUri: row.feedbackUri,
    feedbackHash: row.feedbackHash as `0x${string}`,
    status: row.status,
    agentTokenId: row.agentTokenId,
    contractAddress: row.contractAddress as `0x${string}` | null,
    identityRegistryAddress: row.identityRegistryAddress as `0x${string}` | null,
    signerAddress: row.signerAddress as `0x${string}` | null,
    serializedTransaction: row.serializedTransaction as `0x${string}` | null,
    transactionHash: row.transactionHash as `0x${string}` | null,
    blockNumber: row.blockNumber,
    feedbackIndex: row.feedbackIndex,
    idempotencyScope: row.idempotencyScope,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash as `0x${string}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToEvent(row: typeof reputationEvents.$inferSelect): ReputationEvent {
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

export class PostgresReputationRepository implements ReputationRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async findByIdempotency(
    scope: string,
    key: string,
  ): Promise<ReputationPersistenceResult | null> {
    const [row] = await this.database.select().from(reputationOperations).where(and(
      eq(reputationOperations.idempotencyScope, scope),
      eq(reputationOperations.idempotencyKey, key),
    )).limit(1);
    if (row === undefined) return null;
    const operation = rowToOperation(row);
    return {
      operation,
      reputation: operation.status === 'CONFIRMED' ? await this.#loadEvent(operation.jobId) : null,
      replayed: true,
    };
  }

  public async beginReputation(input: {
    operation: ReputationOperation;
    idempotency: {
      scope: string;
      key: string;
      requestHash: `0x${string}`;
      resourceId: string;
      expiresAt: string;
    };
  }): Promise<ReputationPersistenceResult> {
    const operation = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentclear:chain-signer-state'))`,
      );
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
        const [existing] = await transaction.select().from(reputationOperations).where(and(
          eq(reputationOperations.idempotencyScope, input.idempotency.scope),
          eq(reputationOperations.idempotencyKey, input.idempotency.key),
        )).limit(1);
        if (existing === undefined) {
          throw new Error('Reputation idempotency record references missing state.');
        }
        return { operation: rowToOperation(existing), replayed: true };
      }
      const [job] = await transaction.select().from(jobs)
        .where(eq(jobs.id, input.operation.jobId)).for('update').limit(1);
      if (job === undefined) throw new JobNotFoundError(input.operation.jobId);
      if (job.state !== 'PAID' && job.state !== 'REFUNDED') throw new JobNotReputableError();
      const [existingForJob] = await transaction.select({ status: reputationOperations.status })
        .from(reputationOperations).where(eq(reputationOperations.jobId, job.id)).limit(1);
      if (existingForJob !== undefined) {
        if (existingForJob.status === 'CONFIRMED') throw new JobNotReputableError();
        throw new ReputationInProgressError(job.id);
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
      const [inserted] = await transaction.insert(reputationOperations).values({
        id: input.operation.id,
        jobId: input.operation.jobId,
        verificationRunId: input.operation.verificationRunId,
        providerAgentId: input.operation.providerAgentId,
        outcome: input.operation.outcome,
        value: input.operation.value,
        valueDecimals: input.operation.valueDecimals,
        tag1: input.operation.tag1,
        tag2: input.operation.tag2,
        feedbackUri: input.operation.feedbackUri,
        feedbackHash: input.operation.feedbackHash,
        status: 'CREATED',
        idempotencyScope: input.operation.idempotencyScope,
        idempotencyKey: input.operation.idempotencyKey,
        requestHash: input.operation.requestHash,
        createdAt,
        updatedAt: createdAt,
      }).returning();
      if (inserted === undefined) throw new Error('Reputation operation insert returned no row.');
      return { operation: rowToOperation(inserted), replayed: false };
    });
    return { ...operation, reputation: null };
  }

  public async savePrepared(
    operationId: string,
    prepared: PreparedReputationTransaction,
    updatedAt: string,
  ): Promise<ReputationOperation> {
    const [row] = await this.database.update(reputationOperations).set({
      status: 'PREPARED',
      agentTokenId: prepared.agentTokenId,
      contractAddress: prepared.contractAddress,
      identityRegistryAddress: prepared.identityRegistryAddress,
      signerAddress: prepared.signerAddress,
      serializedTransaction: prepared.serializedTransaction,
      transactionHash: prepared.transactionHash,
      updatedAt: new Date(updatedAt),
    }).where(and(
      eq(reputationOperations.id, operationId),
      eq(reputationOperations.status, 'CREATED'),
    )).returning();
    if (row === undefined) throw new Error('Reputation transaction could not be persisted.');
    return rowToOperation(row);
  }

  public async markBroadcast(operationId: string, updatedAt: string): Promise<ReputationOperation> {
    const [row] = await this.database.update(reputationOperations).set({
      status: 'BROADCAST',
      updatedAt: new Date(updatedAt),
    }).where(and(
      eq(reputationOperations.id, operationId),
      eq(reputationOperations.status, 'PREPARED'),
    )).returning();
    if (row === undefined) throw new Error('Reputation operation was not prepared.');
    return rowToOperation(row);
  }

  public async confirmReputation(input: {
    operationId: string;
    transactionHash: `0x${string}`;
    blockNumber: string;
    feedbackIndex: string;
    clientAddress: `0x${string}`;
    createdAt: string;
  }): Promise<ReputationPersistenceResult> {
    const result = await this.database.transaction(async (transaction) => {
      const [row] = await transaction.select().from(reputationOperations)
        .where(eq(reputationOperations.id, input.operationId)).for('update').limit(1);
      if (row === undefined) throw new Error('Reputation operation was not found.');
      if (row.status === 'CONFIRMED') {
        const [event] = await transaction.select().from(reputationEvents)
          .where(eq(reputationEvents.jobId, row.jobId)).limit(1);
        if (event === undefined) throw new Error('Confirmed reputation event was not found.');
        return { operation: rowToOperation(row), reputation: rowToEvent(event), replayed: true };
      }
      if (
        row.status !== 'BROADCAST'
        || row.transactionHash !== input.transactionHash
        || row.contractAddress === null
        || row.identityRegistryAddress === null
        || row.agentTokenId === null
      ) throw new Error('Reputation confirmation does not match the active operation.');
      const createdAt = new Date(input.createdAt);
      const [event] = await transaction.insert(reputationEvents).values({
        jobId: row.jobId,
        providerAgentId: row.providerAgentId,
        registryAddress: row.contractAddress,
        identityRegistryAddress: row.identityRegistryAddress,
        agentTokenId: row.agentTokenId,
        clientAddress: input.clientAddress,
        value: row.value,
        valueDecimals: row.valueDecimals,
        tag1: row.tag1,
        tag2: row.tag2,
        feedbackUri: row.feedbackUri,
        feedbackHash: row.feedbackHash,
        transactionHash: input.transactionHash,
        blockNumber: input.blockNumber,
        feedbackIndex: input.feedbackIndex,
        createdAt,
      }).returning();
      const [confirmed] = await transaction.update(reputationOperations).set({
        status: 'CONFIRMED',
        serializedTransaction: null,
        blockNumber: input.blockNumber,
        feedbackIndex: input.feedbackIndex,
        updatedAt: createdAt,
      }).where(eq(reputationOperations.id, row.id)).returning();
      if (event === undefined || confirmed === undefined) {
        throw new Error('Reputation confirmation returned incomplete state.');
      }
      return { operation: rowToOperation(confirmed), reputation: rowToEvent(event), replayed: false };
    });
    return result;
  }

  async #loadEvent(jobId: string): Promise<ReputationEvent | null> {
    const [row] = await this.database.select().from(reputationEvents)
      .where(eq(reputationEvents.jobId, jobId)).limit(1);
    return row === undefined ? null : rowToEvent(row);
  }
}
