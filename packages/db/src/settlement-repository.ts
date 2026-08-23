import {
  ChainSignerBusyError,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobNotFoundError,
  JobNotSettleableError,
  SettlementInProgressError,
  type BeginSettlementInput,
  type FinalizationRecord,
  type Job,
  type PreparedSettlementTransaction,
  type SettlementOperation,
  type SettlementPersistenceResult,
  type SettlementRepository,
} from '@agentclear/domain';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import {
  escrowFundingOperations,
  escrows,
  idempotencyRecords,
  jobAssignmentOperations,
  jobs,
  jobStateEvents,
  refunds,
  reputationOperations,
  settlementOperations,
  settlements,
  submissionOperations,
  verificationOperations,
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

function rowToOperation(row: typeof settlementOperations.$inferSelect): SettlementOperation {
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

type PersistenceBase = Omit<SettlementPersistenceResult, 'finalization'>;

export class PostgresSettlementRepository implements SettlementRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async findByIdempotency(
    scope: string,
    key: string,
  ): Promise<SettlementPersistenceResult | null> {
    const [operation] = await this.database.select().from(settlementOperations)
      .where(and(
        eq(settlementOperations.idempotencyScope, scope),
        eq(settlementOperations.idempotencyKey, key),
      ))
      .limit(1);
    if (operation === undefined) return null;
    const [job] = await this.database.select().from(jobs)
      .where(eq(jobs.id, operation.jobId))
      .limit(1);
    if (job === undefined) throw new Error('Settlement operation references a missing job.');
    const mapped = rowToOperation(operation);
    return {
      job: rowToJob(job),
      operation: mapped,
      finalization: mapped.status === 'CONFIRMED' ? await this.#loadFinalization(mapped) : null,
      replayed: true,
    };
  }

  public async beginSettlement(input: BeginSettlementInput): Promise<SettlementPersistenceResult> {
    const base = await this.database.transaction(async (transaction): Promise<PersistenceBase> => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentclear:chain-signer-state'))`,
      );
      const createdAt = new Date(input.operation.createdAt);
      const [claim] = await transaction
        .insert(idempotencyRecords)
        .values({
          scope: input.idempotency.scope,
          key: input.idempotency.key,
          requestHash: input.idempotency.requestHash,
          resourceId: input.idempotency.resourceId,
          createdAt,
          expiresAt: new Date(input.idempotency.expiresAt),
        })
        .onConflictDoNothing()
        .returning({ resourceId: idempotencyRecords.resourceId });
      if (claim === undefined) {
        const [existingClaim] = await transaction
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.scope, input.idempotency.scope),
              eq(idempotencyRecords.key, input.idempotency.key),
            ),
          )
          .limit(1);
        if (
          existingClaim === undefined
          || existingClaim.requestHash !== input.idempotency.requestHash
        ) throw new IdempotencyKeyReusedError();
        const [operation] = await transaction
          .select()
          .from(settlementOperations)
          .where(
            and(
              eq(settlementOperations.idempotencyScope, input.idempotency.scope),
              eq(settlementOperations.idempotencyKey, input.idempotency.key),
            ),
          )
          .limit(1);
        const [job] = await transaction
          .select()
          .from(jobs)
          .where(eq(jobs.id, existingClaim.resourceId))
          .limit(1);
        if (operation === undefined || job === undefined) {
          throw new Error('Settlement idempotency record references missing state.');
        }
        return { job: rowToJob(job), operation: rowToOperation(operation), replayed: true };
      }

      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, input.operation.jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(input.operation.jobId);
      const expectedState = input.operation.outcome === 'PASS' ? 'PASSED' : 'FAILED';
      const targetState = input.operation.outcome === 'PASS' ? 'SETTLING' : 'FAILED_FINAL';
      if (job.state !== expectedState) {
        if (job.state === targetState) throw new SettlementInProgressError(job.id);
        if (job.state === 'PAID' || job.state === 'REFUNDED') throw new JobNotSettleableError();
        throw new InvalidJobTransitionError(job.state, targetState);
      }
      if (
        input.startEvent.jobId !== job.id
        || input.startEvent.fromState !== expectedState
        || input.startEvent.toState !== targetState
      ) throw new Error('Settlement start event does not match the locked job state.');

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
      const [activeSettlement] = await transaction.select({ jobId: settlementOperations.jobId })
        .from(settlementOperations)
        .where(ne(settlementOperations.status, 'CONFIRMED'))
        .limit(1);
      const [activeReputation] = await transaction.select({ id: reputationOperations.id })
        .from(reputationOperations)
        .where(ne(reputationOperations.status, 'CONFIRMED'))
        .limit(1);
      if (
        activeFunding !== undefined
        || activeAssignment !== undefined
        || activeSubmission !== undefined
        || activeVerification !== undefined
        || activeReputation !== undefined
      ) throw new ChainSignerBusyError();
      if (activeSettlement !== undefined) {
        if (activeSettlement.jobId === job.id) throw new SettlementInProgressError(job.id);
        throw new ChainSignerBusyError();
      }

      const [operation] = await transaction.insert(settlementOperations).values({
        id: input.operation.id,
        jobId: input.operation.jobId,
        submissionId: input.operation.submissionId,
        verificationRunId: input.operation.verificationRunId,
        outcome: input.operation.outcome,
        status: 'CREATED',
        agreementHash: input.operation.agreementHash,
        submissionHash: input.operation.submissionHash,
        verificationReportHash: input.operation.verificationReportHash,
        buyerAgentId: input.operation.buyerAgentId,
        providerAgentId: input.operation.providerAgentId,
        idempotencyScope: input.operation.idempotencyScope,
        idempotencyKey: input.operation.idempotencyKey,
        requestHash: input.operation.requestHash,
        createdAt,
        updatedAt: createdAt,
      }).returning();
      if (operation === undefined) throw new Error('Settlement operation insert returned no row.');
      const [updatedJob] = await transaction.update(jobs).set({
        state: targetState,
        version: sql`${jobs.version} + 1`,
        updatedAt: createdAt,
      }).where(eq(jobs.id, job.id)).returning();
      if (updatedJob === undefined) throw new Error('Settlement start returned no job.');
      await transaction.insert(jobStateEvents).values({
        id: input.startEvent.id,
        jobId: input.startEvent.jobId,
        fromState: input.startEvent.fromState,
        toState: input.startEvent.toState,
        actorType: input.startEvent.actorType,
        actorId: input.startEvent.actorId,
        reason: input.startEvent.reason,
        evidenceReference: input.startEvent.evidenceReference,
        occurredAt: createdAt,
      });
      return { job: rowToJob(updatedJob), operation: rowToOperation(operation), replayed: false };
    });
    return {
      ...base,
      finalization: base.operation.status === 'CONFIRMED'
        ? await this.#loadFinalization(base.operation)
        : null,
    };
  }

  public async saveOutcomePrepared(
    operationId: string,
    prepared: PreparedSettlementTransaction,
    updatedAt: string,
  ): Promise<SettlementOperation> {
    const [operation] = await this.database.update(settlementOperations).set({
      status: 'OUTCOME_PREPARED',
      jobKey: prepared.jobKey,
      outcomeContractAddress: prepared.contractAddress,
      outcomeSerializedTransaction: prepared.serializedTransaction,
      outcomeTransactionHash: prepared.transactionHash,
      signerAddress: prepared.signerAddress,
      updatedAt: new Date(updatedAt),
    }).where(and(
      eq(settlementOperations.id, operationId),
      eq(settlementOperations.status, 'CREATED'),
    )).returning();
    if (operation === undefined) throw new Error('Outcome transaction could not be persisted.');
    return rowToOperation(operation);
  }

  public async markOutcomeBroadcast(operationId: string, updatedAt: string): Promise<SettlementOperation> {
    return this.#advance(operationId, 'OUTCOME_PREPARED', 'OUTCOME_BROADCAST', updatedAt);
  }

  public async confirmOutcome(
    operationId: string,
    transactionHash: `0x${string}`,
    blockNumber: string,
    updatedAt: string,
  ): Promise<SettlementOperation> {
    const [operation] = await this.database.update(settlementOperations).set({
      status: 'OUTCOME_CONFIRMED',
      outcomeSerializedTransaction: null,
      outcomeBlockNumber: blockNumber,
      updatedAt: new Date(updatedAt),
    }).where(and(
      eq(settlementOperations.id, operationId),
      eq(settlementOperations.status, 'OUTCOME_BROADCAST'),
      eq(settlementOperations.outcomeTransactionHash, transactionHash),
    )).returning();
    if (operation === undefined) throw new Error('Outcome confirmation did not match its operation.');
    return rowToOperation(operation);
  }

  public async saveEscrowPrepared(
    operationId: string,
    prepared: PreparedSettlementTransaction,
    updatedAt: string,
  ): Promise<SettlementOperation> {
    const [existing] = await this.database.select().from(settlementOperations)
      .where(eq(settlementOperations.id, operationId)).limit(1);
    if (
      existing === undefined
      || existing.status !== 'OUTCOME_CONFIRMED'
      || existing.jobKey !== prepared.jobKey
      || existing.signerAddress !== prepared.signerAddress
    ) throw new Error('Escrow transaction does not match its confirmed outcome.');
    const [operation] = await this.database.update(settlementOperations).set({
      status: 'ESCROW_PREPARED',
      escrowContractAddress: prepared.contractAddress,
      escrowSerializedTransaction: prepared.serializedTransaction,
      escrowTransactionHash: prepared.transactionHash,
      updatedAt: new Date(updatedAt),
    }).where(and(
      eq(settlementOperations.id, operationId),
      eq(settlementOperations.status, 'OUTCOME_CONFIRMED'),
    )).returning();
    if (operation === undefined) throw new Error('Escrow transaction could not be persisted.');
    return rowToOperation(operation);
  }

  public async markEscrowBroadcast(operationId: string, updatedAt: string): Promise<SettlementOperation> {
    return this.#advance(operationId, 'ESCROW_PREPARED', 'ESCROW_BROADCAST', updatedAt);
  }

  public async confirmSettlement(input: {
    operationId: string;
    transactionHash: `0x${string}`;
    blockNumber: string;
    event: BeginSettlementInput['startEvent'];
  }): Promise<SettlementPersistenceResult> {
    const base = await this.database.transaction(async (transaction): Promise<PersistenceBase> => {
      const [operation] = await transaction.select().from(settlementOperations)
        .where(eq(settlementOperations.id, input.operationId)).for('update').limit(1);
      if (operation === undefined) throw new Error('Settlement operation was not found.');
      const [job] = await transaction.select().from(jobs)
        .where(eq(jobs.id, operation.jobId)).for('update').limit(1);
      if (job === undefined) throw new JobNotFoundError(operation.jobId);
      if (operation.status === 'CONFIRMED') {
        return { job: rowToJob(job), operation: rowToOperation(operation), replayed: true };
      }
      const expectedJobState = operation.outcome === 'PASS' ? 'SETTLING' : 'FAILED_FINAL';
      const targetJobState = operation.outcome === 'PASS' ? 'PAID' : 'REFUNDED';
      if (
        operation.status !== 'ESCROW_BROADCAST'
        || operation.escrowTransactionHash !== input.transactionHash
        || operation.outcomeTransactionHash === null
        || operation.outcomeBlockNumber === null
        || job.state !== expectedJobState
        || input.event.jobId !== job.id
        || input.event.fromState !== expectedJobState
        || input.event.toState !== targetJobState
      ) throw new Error('Settlement confirmation does not match the active operation.');
      const [escrow] = await transaction.select().from(escrows)
        .where(eq(escrows.jobId, job.id)).for('update').limit(1);
      if (escrow === undefined) throw new Error('Settlement escrow record was not found.');
      const finalizedAt = new Date(input.event.occurredAt);
      const finalization = {
        jobId: job.id,
        verificationRunId: operation.verificationRunId,
        amountBaseUnits: escrow.amountBaseUnits,
        outcomeTransactionHash: operation.outcomeTransactionHash,
        outcomeBlockNumber: operation.outcomeBlockNumber,
        escrowTransactionHash: input.transactionHash,
        escrowBlockNumber: input.blockNumber,
        finalizedAt,
      };
      if (operation.outcome === 'PASS') await transaction.insert(settlements).values(finalization);
      else await transaction.insert(refunds).values(finalization);
      await transaction.update(escrows).set({
        status: operation.outcome === 'PASS' ? 'RELEASED' : 'REFUNDED',
        updatedAt: finalizedAt,
      }).where(eq(escrows.jobId, job.id));
      const [updatedOperation] = await transaction.update(settlementOperations).set({
        status: 'CONFIRMED',
        escrowSerializedTransaction: null,
        escrowBlockNumber: input.blockNumber,
        updatedAt: finalizedAt,
      }).where(eq(settlementOperations.id, operation.id)).returning();
      const [updatedJob] = await transaction.update(jobs).set({
        state: targetJobState,
        version: sql`${jobs.version} + 1`,
        updatedAt: finalizedAt,
      }).where(eq(jobs.id, job.id)).returning();
      if (updatedOperation === undefined || updatedJob === undefined) {
        throw new Error('Settlement finalization returned incomplete state.');
      }
      await transaction.insert(jobStateEvents).values({
        id: input.event.id,
        jobId: input.event.jobId,
        fromState: input.event.fromState,
        toState: input.event.toState,
        actorType: input.event.actorType,
        actorId: input.event.actorId,
        reason: input.event.reason,
        transactionHash: input.event.transactionHash,
        evidenceReference: input.event.evidenceReference,
        occurredAt: finalizedAt,
      });
      return { job: rowToJob(updatedJob), operation: rowToOperation(updatedOperation), replayed: false };
    });
    const finalization = await this.#loadFinalization(base.operation);
    if (finalization === null) throw new Error('Confirmed settlement row was not found.');
    return { ...base, finalization };
  }

  async #advance(
    operationId: string,
    current: SettlementOperation['status'],
    next: SettlementOperation['status'],
    updatedAt: string,
  ): Promise<SettlementOperation> {
    const [operation] = await this.database.update(settlementOperations)
      .set({ status: next, updatedAt: new Date(updatedAt) })
      .where(and(eq(settlementOperations.id, operationId), eq(settlementOperations.status, current)))
      .returning();
    if (operation === undefined) throw new Error(`Settlement cannot advance from ${current}.`);
    return rowToOperation(operation);
  }

  async #loadFinalization(operation: SettlementOperation): Promise<FinalizationRecord | null> {
    const table = operation.outcome === 'PASS' ? settlements : refunds;
    const [row] = await this.database.select().from(table)
      .where(eq(table.jobId, operation.jobId)).limit(1);
    if (row === undefined) return null;
    return {
      jobId: row.jobId,
      kind: operation.outcome === 'PASS' ? 'PAYMENT' : 'REFUND',
      amountBaseUnits: row.amountBaseUnits,
      outcomeTransactionHash: row.outcomeTransactionHash as `0x${string}`,
      outcomeBlockNumber: row.outcomeBlockNumber,
      escrowTransactionHash: row.escrowTransactionHash as `0x${string}`,
      escrowBlockNumber: row.escrowBlockNumber,
      finalizedAt: row.finalizedAt.toISOString(),
    };
  }
}
