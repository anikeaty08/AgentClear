import {
  ChainSignerBusyError,
  ChainUnavailableError,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobClosureInProgressError,
  JobNotFoundError,
  type BeginJobClosureInput,
  type ConfirmJobClosureInput,
  type JobClosureOperation,
  type JobClosureRepository,
  type JobClosureResult,
  type PreparedFundingTransaction,
} from '@agentclear/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import {
  escrowFundingOperations,
  escrows,
  idempotencyRecords,
  jobAssignmentOperations,
  jobClosureOperations,
  jobs,
  jobStateEvents,
  receiptOperations,
  reputationOperations,
  settlementOperations,
  submissionOperations,
  verificationOperations,
} from './schema.js';

function rowToClosureOperation(
  row: typeof jobClosureOperations.$inferSelect,
): JobClosureOperation {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind,
    initialState: row.initialState,
    status: row.status,
    actorType: row.actorType,
    actorId: row.actorId,
    reason: row.reason,
    chainId: row.chainId,
    contractAddress: row.contractAddress as `0x${string}`,
    signerAddress: row.signerAddress as `0x${string}`,
    amountBaseUnits: row.amountBaseUnits,
    jobKey: row.jobKey as `0x${string}` | null,
    serializedTransaction: row.serializedTransaction as `0x${string}` | null,
    transactionHash: row.transactionHash as `0x${string}` | null,
    blockNumber: row.blockNumber,
    idempotencyScope: row.idempotencyScope,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash as `0x${string}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToJob(row: typeof jobs.$inferSelect) {
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

export class PostgresJobClosureRepository implements JobClosureRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async beginClosure(input: BeginJobClosureInput): Promise<JobClosureResult> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('agentclear:chain-signer-state'))`,
      );
      const requestedAt = new Date(input.requestedAt);
      const [claim] = await transaction
        .insert(idempotencyRecords)
        .values({
          scope: input.idempotency.scope,
          key: input.idempotency.key,
          requestHash: input.idempotency.requestHash,
          resourceId: input.idempotency.resourceId,
          createdAt: requestedAt,
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
        if (existingClaim === undefined || existingClaim.requestHash !== input.idempotency.requestHash) {
          throw new IdempotencyKeyReusedError();
        }
        const [job] = await transaction
          .select()
          .from(jobs)
          .where(eq(jobs.id, existingClaim.resourceId))
          .limit(1);
        if (job === undefined) throw new Error('Closure idempotency record references a missing job.');
        const [operation] = await transaction
          .select()
          .from(jobClosureOperations)
          .where(
            and(
              eq(jobClosureOperations.idempotencyScope, input.idempotency.scope),
              eq(jobClosureOperations.idempotencyKey, input.idempotency.key),
            ),
          )
          .limit(1);
        return {
          job: rowToJob(job),
          operation: operation === undefined ? null : rowToClosureOperation(operation),
          replayed: true,
        };
      }

      const jobId = input.idempotency.resourceId;
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(jobId);
      const kind = input.operation?.kind ?? (input.startEvent.toState === 'CANCELLED' ? 'CANCEL' : 'EXPIRE');

      if (job.state === 'DRAFT' || job.state === 'QUOTED') {
        const targetState = kind === 'CANCEL' ? 'CANCELLED' : 'EXPIRED';
        const [updatedJob] = await transaction
          .update(jobs)
          .set({ state: targetState, version: sql`${jobs.version} + 1`, updatedAt: requestedAt })
          .where(eq(jobs.id, job.id))
          .returning();
        if (updatedJob === undefined) throw new Error('Direct job closure returned no row.');
        await transaction.insert(jobStateEvents).values({
          id: input.startEvent.id,
          jobId: input.startEvent.jobId,
          fromState: job.state,
          toState: targetState,
          actorType: input.startEvent.actorType,
          actorId: input.startEvent.actorId,
          reason: input.startEvent.reason,
          occurredAt: requestedAt,
        });
        return { job: rowToJob(updatedJob), operation: null, replayed: false };
      }

      if (input.operation === null) throw new ChainUnavailableError();
      if (kind === 'CANCEL' && job.state !== 'FUNDED') {
        throw new InvalidJobTransitionError(job.state, 'CANCELLED');
      }
      if (
        kind === 'EXPIRE'
        && !['FUNDED', 'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RETRY'].includes(job.state)
      ) {
        throw new InvalidJobTransitionError(job.state, 'EXPIRED');
      }

      const [activeClosure] = await transaction
        .select({ id: jobClosureOperations.id })
        .from(jobClosureOperations)
        .where(
          and(
            eq(jobClosureOperations.jobId, job.id),
            inArray(jobClosureOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
          ),
        )
        .limit(1);
      if (activeClosure !== undefined) throw new JobClosureInProgressError(job.id);

      const [escrow] = await transaction
        .select()
        .from(escrows)
        .where(eq(escrows.jobId, job.id))
        .for('update')
        .limit(1);
      if (escrow === undefined || escrow.status !== 'FUNDED') {
        throw new InvalidJobTransitionError(job.state, kind === 'CANCEL' ? 'CANCELLED' : 'EXPIRED');
      }
      if (kind === 'CANCEL' && escrow.providerAddress !== null) {
        throw new InvalidJobTransitionError(job.state, 'CANCELLED');
      }
      if (
        escrow.chainId !== input.operation.chainId
        || escrow.contractAddress.toLowerCase() !== input.operation.contractAddress.toLowerCase()
        || escrow.buyerAddress.toLowerCase() !== input.operation.signerAddress.toLowerCase()
        || escrow.amountBaseUnits !== input.operation.amountBaseUnits
      ) {
        throw new Error('Closure operation does not match the funded escrow.');
      }

      await this.#assertNoOtherActiveOperation(transaction, job.id);
      const [operation] = await transaction
        .insert(jobClosureOperations)
        .values({
          id: input.operation.id,
          jobId: input.operation.jobId,
          kind: input.operation.kind,
          initialState: job.state,
          status: input.operation.status,
          actorType: input.operation.actorType,
          actorId: input.operation.actorId,
          reason: input.operation.reason,
          chainId: input.operation.chainId,
          contractAddress: input.operation.contractAddress,
          signerAddress: input.operation.signerAddress,
          amountBaseUnits: input.operation.amountBaseUnits,
          idempotencyScope: input.operation.idempotencyScope,
          idempotencyKey: input.operation.idempotencyKey,
          requestHash: input.operation.requestHash,
          createdAt: requestedAt,
          updatedAt: requestedAt,
        })
        .returning();
      if (operation === undefined) throw new Error('Closure operation insert returned no row.');

      let persistedJob = job;
      if (kind === 'EXPIRE') {
        const [expiredJob] = await transaction
          .update(jobs)
          .set({ state: 'EXPIRED', version: sql`${jobs.version} + 1`, updatedAt: requestedAt })
          .where(eq(jobs.id, job.id))
          .returning();
        if (expiredJob === undefined) throw new Error('Expiry transition returned no row.');
        await transaction.insert(jobStateEvents).values({
          id: input.startEvent.id,
          jobId: input.startEvent.jobId,
          fromState: job.state,
          toState: 'EXPIRED',
          actorType: input.startEvent.actorType,
          actorId: input.startEvent.actorId,
          reason: input.startEvent.reason,
          occurredAt: requestedAt,
        });
        persistedJob = expiredJob;
      }

      return {
        job: rowToJob(persistedJob),
        operation: rowToClosureOperation(operation),
        replayed: false,
      };
    });
  }

  public async savePrepared(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<JobClosureOperation> {
    return this.database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(jobClosureOperations)
        .where(eq(jobClosureOperations.id, operationId))
        .for('update')
        .limit(1);
      if (operation === undefined) throw new Error('Closure operation was not found.');
      if (
        operation.contractAddress.toLowerCase() !== prepared.contractAddress.toLowerCase()
        || operation.signerAddress.toLowerCase() !== prepared.signerAddress.toLowerCase()
      ) {
        throw new Error('Prepared transaction does not match the closure operation.');
      }
      if (operation.status !== 'CREATED') return rowToClosureOperation(operation);
      const [updated] = await transaction
        .update(jobClosureOperations)
        .set({
          status: 'PREPARED',
          jobKey: prepared.jobKey,
          serializedTransaction: prepared.serializedTransaction,
          transactionHash: prepared.transactionHash,
          updatedAt: new Date(updatedAt),
        })
        .where(eq(jobClosureOperations.id, operationId))
        .returning();
      if (updated === undefined) throw new Error('Closure operation update returned no row.');
      return rowToClosureOperation(updated);
    });
  }

  public async markBroadcast(
    operationId: string,
    updatedAt: string,
  ): Promise<JobClosureOperation> {
    const [operation] = await this.database
      .update(jobClosureOperations)
      .set({ status: 'BROADCAST', updatedAt: new Date(updatedAt) })
      .where(
        and(
          eq(jobClosureOperations.id, operationId),
          eq(jobClosureOperations.status, 'PREPARED'),
        ),
      )
      .returning();
    if (operation !== undefined) return rowToClosureOperation(operation);
    const [existing] = await this.database
      .select()
      .from(jobClosureOperations)
      .where(eq(jobClosureOperations.id, operationId))
      .limit(1);
    if (existing === undefined || !['BROADCAST', 'CONFIRMED'].includes(existing.status)) {
      throw new Error('Closure operation cannot be marked broadcast in its current state.');
    }
    return rowToClosureOperation(existing);
  }

  public async confirmClosure(input: ConfirmJobClosureInput): Promise<JobClosureResult> {
    return this.database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(jobClosureOperations)
        .where(eq(jobClosureOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (operation === undefined) throw new Error('Closure operation was not found.');
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, operation.jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(operation.jobId);
      if (operation.status === 'CONFIRMED') {
        return { job: rowToJob(job), operation: rowToClosureOperation(operation), replayed: true };
      }
      if (!['PREPARED', 'BROADCAST'].includes(operation.status)) {
        throw new Error('Closure operation is not ready for confirmation.');
      }
      const confirmation = input.confirmation;
      if (
        operation.transactionHash !== confirmation.transactionHash
        || operation.contractAddress.toLowerCase() !== confirmation.contractAddress.toLowerCase()
        || operation.jobKey !== confirmation.escrow.jobKey
        || operation.signerAddress.toLowerCase() !== confirmation.escrow.buyer.toLowerCase()
        || operation.amountBaseUnits !== confirmation.escrow.amountBaseUnits
        || confirmation.escrow.agreementHash !== job.agreementHash
        || confirmation.escrow.state !== 4
        || (operation.kind === 'CANCEL' && confirmation.escrow.provider !== null)
      ) {
        throw new Error('Closure confirmation does not match the operation or refunded escrow.');
      }
      const expectedState = operation.kind === 'CANCEL' ? 'FUNDED' : 'EXPIRED';
      const finalState = operation.kind === 'CANCEL' ? 'CANCELLED' : 'REFUNDED';
      if (job.state !== expectedState) throw new InvalidJobTransitionError(job.state, finalState);
      const occurredAt = new Date(input.finalEvent.occurredAt);
      const [updatedOperation] = await transaction
        .update(jobClosureOperations)
        .set({
          status: 'CONFIRMED',
          serializedTransaction: null,
          blockNumber: confirmation.blockNumber,
          updatedAt: occurredAt,
        })
        .where(eq(jobClosureOperations.id, operation.id))
        .returning();
      if (updatedOperation === undefined) throw new Error('Closure confirmation returned no row.');
      const [updatedEscrow] = await transaction
        .update(escrows)
        .set({ status: 'REFUNDED', updatedAt: occurredAt })
        .where(and(eq(escrows.jobId, job.id), eq(escrows.status, 'FUNDED')))
        .returning({ jobId: escrows.jobId });
      if (updatedEscrow === undefined) throw new Error('Funded escrow was missing at closure.');
      const [updatedJob] = await transaction
        .update(jobs)
        .set({ state: finalState, version: sql`${jobs.version} + 1`, updatedAt: occurredAt })
        .where(eq(jobs.id, job.id))
        .returning();
      if (updatedJob === undefined) throw new Error('Closure job transition returned no row.');
      await transaction.insert(jobStateEvents).values({
        id: input.finalEvent.id,
        jobId: input.finalEvent.jobId,
        fromState: expectedState,
        toState: finalState,
        actorType: input.finalEvent.actorType,
        actorId: input.finalEvent.actorId,
        reason: input.finalEvent.reason,
        transactionHash: confirmation.transactionHash,
        occurredAt,
      });
      return {
        job: rowToJob(updatedJob),
        operation: rowToClosureOperation(updatedOperation),
        replayed: false,
      };
    });
  }

  async #assertNoOtherActiveOperation(
    transaction: Parameters<Parameters<AgentClearDatabase['transaction']>[0]>[0],
    jobId: string,
  ): Promise<void> {
    const [activeFunding] = await transaction
      .select({ id: escrowFundingOperations.id })
      .from(escrowFundingOperations)
      .where(inArray(escrowFundingOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']))
      .limit(1);
    const [activeAssignment] = await transaction
      .select({ id: jobAssignmentOperations.id })
      .from(jobAssignmentOperations)
      .where(inArray(jobAssignmentOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']))
      .limit(1);
    const [otherClosure] = await transaction
      .select({ id: jobClosureOperations.id })
      .from(jobClosureOperations)
      .where(
        and(
          inArray(jobClosureOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
          sql`${jobClosureOperations.jobId} <> ${jobId}`,
        ),
      )
      .limit(1);
    const [activeSubmission] = await transaction
      .select({ id: submissionOperations.id })
      .from(submissionOperations)
      .where(inArray(submissionOperations.status, ['CREATED', 'STORING']))
      .limit(1);
    const [activeVerification] = await transaction
      .select({ id: verificationOperations.id })
      .from(verificationOperations)
      .where(inArray(verificationOperations.status, ['CREATED', 'EVALUATED', 'STORING']))
      .limit(1);
    const [activeSettlement] = await transaction
      .select({ id: settlementOperations.id })
      .from(settlementOperations)
      .where(sql`${settlementOperations.status} <> 'CONFIRMED'`)
      .limit(1);
    const [activeReputation] = await transaction
      .select({ id: reputationOperations.id })
      .from(reputationOperations)
      .where(sql`${reputationOperations.status} <> 'CONFIRMED'`)
      .limit(1);
    const [activeReceipt] = await transaction
      .select({ id: receiptOperations.id })
      .from(receiptOperations)
      .where(sql`${receiptOperations.status} <> 'CONFIRMED'`)
      .limit(1);
    if (
      activeFunding !== undefined
      || activeAssignment !== undefined
      || otherClosure !== undefined
      || activeSubmission !== undefined
      || activeVerification !== undefined
      || activeSettlement !== undefined
      || activeReputation !== undefined
      || activeReceipt !== undefined
    ) {
      throw new ChainSignerBusyError();
    }
  }
}
