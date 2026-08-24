import {
  ChainSignerBusyError,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobAssignmentInProgressError,
  JobNotFoundError,
  type AssignmentOperation,
  type AssignmentRepository,
  type AssignmentResult,
  type BeginAssignmentInput,
  type ConfirmAssignmentPersistenceInput,
  type PreparedFundingTransaction,
} from '@agentclear/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import {
  escrows,
  escrowFundingOperations,
  idempotencyRecords,
  jobAssignmentOperations,
  jobClosureOperations,
  jobAssignments,
  jobs,
  jobStateEvents,
  submissionOperations,
  verificationOperations,
  settlementOperations,
  reputationOperations,
  receiptOperations,
} from './schema.js';

function rowToAssignmentOperation(
  row: typeof jobAssignmentOperations.$inferSelect,
): AssignmentOperation {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status,
    chainId: row.chainId,
    contractAddress: row.contractAddress as `0x${string}`,
    signerAddress: row.signerAddress as `0x${string}`,
    providerAgentId: row.providerAgentId,
    providerAddress: row.providerAddress as `0x${string}`,
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

export class PostgresAssignmentRepository implements AssignmentRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async beginAssignment(input: BeginAssignmentInput): Promise<AssignmentResult> {
    return this.database.transaction(async (transaction) => {
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
        if (existingClaim === undefined || existingClaim.requestHash !== input.idempotency.requestHash) {
          throw new IdempotencyKeyReusedError();
        }
        const [operation] = await transaction
          .select()
          .from(jobAssignmentOperations)
          .where(
            and(
              eq(jobAssignmentOperations.idempotencyScope, input.idempotency.scope),
              eq(jobAssignmentOperations.idempotencyKey, input.idempotency.key),
            ),
          )
          .limit(1);
        const [job] = await transaction
          .select()
          .from(jobs)
          .where(eq(jobs.id, existingClaim.resourceId))
          .limit(1);
        if (operation === undefined || job === undefined) {
          throw new Error('Assignment idempotency record references missing state.');
        }
        return { job: rowToJob(job), operation: rowToAssignmentOperation(operation), replayed: true };
      }

      let [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, input.operation.jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(input.operation.jobId);
      if (job.state === 'FUNDED') {
        const [openedJob] = await transaction
          .update(jobs)
          .set({ state: 'OPEN', version: sql`${jobs.version} + 1`, updatedAt: createdAt })
          .where(eq(jobs.id, job.id))
          .returning();
        if (openedJob === undefined) throw new Error('Opening the funded job returned no row.');
        await transaction.insert(jobStateEvents).values({
          id: input.openEvent.id,
          jobId: input.openEvent.jobId,
          fromState: input.openEvent.fromState,
          toState: input.openEvent.toState,
          actorType: input.openEvent.actorType,
          actorId: input.openEvent.actorId,
          reason: input.openEvent.reason,
          occurredAt: new Date(input.openEvent.occurredAt),
        });
        job = openedJob;
      }
      if (job.state !== 'OPEN') throw new InvalidJobTransitionError(job.state, 'ASSIGNED');

      const [activeOperation] = await transaction
        .select({ id: jobAssignmentOperations.id })
        .from(jobAssignmentOperations)
        .where(
          and(
            eq(jobAssignmentOperations.jobId, job.id),
            inArray(jobAssignmentOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
          ),
        )
        .limit(1);
      if (activeOperation !== undefined) throw new JobAssignmentInProgressError(job.id);

      const [activeFunding] = await transaction
        .select({ id: escrowFundingOperations.id })
        .from(escrowFundingOperations)
        .where(
          inArray(escrowFundingOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
        )
        .limit(1);
      const [otherAssignment] = await transaction
        .select({ id: jobAssignmentOperations.id })
        .from(jobAssignmentOperations)
        .where(
          and(
            inArray(jobAssignmentOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
            sql`${jobAssignmentOperations.jobId} <> ${job.id}`,
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
        .where(
          inArray(verificationOperations.status, ['CREATED', 'EVALUATED', 'STORING']),
        )
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
      const [activeClosure] = await transaction
        .select({ id: jobClosureOperations.id })
        .from(jobClosureOperations)
        .where(inArray(jobClosureOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']))
        .limit(1);
      if (
        activeFunding !== undefined
        || otherAssignment !== undefined
        || activeSubmission !== undefined
        || activeVerification !== undefined
        || activeSettlement !== undefined
        || activeReputation !== undefined
        || activeReceipt !== undefined
        || activeClosure !== undefined
      ) {
        throw new ChainSignerBusyError();
      }

      const [operation] = await transaction
        .insert(jobAssignmentOperations)
        .values({
          id: input.operation.id,
          jobId: input.operation.jobId,
          status: input.operation.status,
          chainId: input.operation.chainId,
          contractAddress: input.operation.contractAddress,
          signerAddress: input.operation.signerAddress,
          providerAgentId: input.operation.providerAgentId,
          providerAddress: input.operation.providerAddress,
          idempotencyScope: input.operation.idempotencyScope,
          idempotencyKey: input.operation.idempotencyKey,
          requestHash: input.operation.requestHash,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      if (operation === undefined) throw new Error('Assignment operation insert returned no row.');
      return { job: rowToJob(job), operation: rowToAssignmentOperation(operation), replayed: false };
    });
  }

  public async savePreparedAssignment(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<AssignmentOperation> {
    return this.database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(jobAssignmentOperations)
        .where(eq(jobAssignmentOperations.id, operationId))
        .for('update')
        .limit(1);
      if (operation === undefined) throw new Error('Assignment operation was not found.');
      if (
        operation.contractAddress.toLowerCase() !== prepared.contractAddress.toLowerCase()
        || operation.signerAddress.toLowerCase() !== prepared.signerAddress.toLowerCase()
      ) {
        throw new Error('Prepared transaction does not match the assignment operation.');
      }
      if (operation.status !== 'CREATED') return rowToAssignmentOperation(operation);
      const [updated] = await transaction
        .update(jobAssignmentOperations)
        .set({
          status: 'PREPARED',
          jobKey: prepared.jobKey,
          serializedTransaction: prepared.serializedTransaction,
          transactionHash: prepared.transactionHash,
          updatedAt: new Date(updatedAt),
        })
        .where(eq(jobAssignmentOperations.id, operationId))
        .returning();
      if (updated === undefined) throw new Error('Assignment operation update returned no row.');
      return rowToAssignmentOperation(updated);
    });
  }

  public async markAssignmentBroadcast(
    operationId: string,
    updatedAt: string,
  ): Promise<AssignmentOperation> {
    const [operation] = await this.database
      .update(jobAssignmentOperations)
      .set({ status: 'BROADCAST', updatedAt: new Date(updatedAt) })
      .where(
        and(
          eq(jobAssignmentOperations.id, operationId),
          eq(jobAssignmentOperations.status, 'PREPARED'),
        ),
      )
      .returning();
    if (operation !== undefined) return rowToAssignmentOperation(operation);
    const [existing] = await this.database
      .select()
      .from(jobAssignmentOperations)
      .where(eq(jobAssignmentOperations.id, operationId))
      .limit(1);
    if (existing === undefined || !['BROADCAST', 'CONFIRMED'].includes(existing.status)) {
      throw new Error('Assignment operation cannot be marked broadcast in its current state.');
    }
    return rowToAssignmentOperation(existing);
  }

  public async confirmAssignment(
    input: ConfirmAssignmentPersistenceInput,
  ): Promise<AssignmentResult> {
    return this.database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(jobAssignmentOperations)
        .where(eq(jobAssignmentOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (operation === undefined) throw new Error('Assignment operation was not found.');
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, operation.jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(operation.jobId);
      if (operation.status === 'CONFIRMED') {
        return { job: rowToJob(job), operation: rowToAssignmentOperation(operation), replayed: true };
      }
      if (!['PREPARED', 'BROADCAST'].includes(operation.status)) {
        throw new Error('Assignment operation is not ready for confirmation.');
      }
      if (
        operation.transactionHash !== input.confirmation.transactionHash
        || operation.contractAddress.toLowerCase()
          !== input.confirmation.contractAddress.toLowerCase()
        || input.confirmation.escrow.provider?.toLowerCase()
          !== operation.providerAddress.toLowerCase()
      ) {
        throw new Error('Assignment confirmation does not match the operation.');
      }
      if (job.state !== 'OPEN') throw new InvalidJobTransitionError(job.state, 'ASSIGNED');

      const occurredAt = new Date(input.event.occurredAt);
      const [updatedOperation] = await transaction
        .update(jobAssignmentOperations)
        .set({
          status: 'CONFIRMED',
          serializedTransaction: null,
          blockNumber: input.confirmation.blockNumber,
          updatedAt: occurredAt,
        })
        .where(eq(jobAssignmentOperations.id, operation.id))
        .returning();
      if (updatedOperation === undefined) throw new Error('Assignment confirmation returned no row.');

      await transaction.insert(jobAssignments).values({
        jobId: operation.jobId,
        providerAgentId: operation.providerAgentId,
        providerAddress: operation.providerAddress,
        transactionHash: input.confirmation.transactionHash,
        blockNumber: input.confirmation.blockNumber,
        assignedAt: occurredAt,
      });
      const [updatedEscrow] = await transaction
        .update(escrows)
        .set({ providerAddress: operation.providerAddress, updatedAt: occurredAt })
        .where(
          and(
            eq(escrows.jobId, operation.jobId),
            eq(escrows.status, 'FUNDED'),
            sql`${escrows.providerAddress} is null`,
          ),
        )
        .returning({ jobId: escrows.jobId });
      if (updatedEscrow === undefined) {
        throw new Error('Funded escrow was missing or already had a provider.');
      }
      const [updatedJob] = await transaction
        .update(jobs)
        .set({
          providerAgentId: operation.providerAgentId,
          state: 'ASSIGNED',
          version: sql`${jobs.version} + 1`,
          updatedAt: occurredAt,
        })
        .where(eq(jobs.id, operation.jobId))
        .returning();
      if (updatedJob === undefined) throw new Error('Assignment job transition returned no row.');
      await transaction.insert(jobStateEvents).values({
        id: input.event.id,
        jobId: input.event.jobId,
        fromState: input.event.fromState,
        toState: input.event.toState,
        actorType: input.event.actorType,
        actorId: input.event.actorId,
        reason: input.event.reason,
        transactionHash: input.event.transactionHash,
        occurredAt,
      });

      return {
        job: rowToJob(updatedJob),
        operation: rowToAssignmentOperation(updatedOperation),
        replayed: false,
      };
    });
  }
}
