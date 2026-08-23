import {
  ChainSignerBusyError,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobFundingInProgressError,
  JobNotFoundError,
  type BeginFundingInput,
  type BeginFundingResult,
  type ConfirmFundingPersistenceInput,
  type EscrowRepository,
  type FundingOperation,
  type PreparedFundingTransaction,
} from '@agentclear/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import {
  escrowFundingOperations,
  escrows,
  idempotencyRecords,
  jobAssignmentOperations,
  jobs,
  jobStateEvents,
  submissionOperations,
  verificationOperations,
  settlementOperations,
  reputationOperations,
} from './schema.js';

function rowToFundingOperation(
  row: typeof escrowFundingOperations.$inferSelect,
): FundingOperation {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status,
    chainId: row.chainId,
    contractAddress: row.contractAddress as `0x${string}`,
    signerAddress: row.signerAddress as `0x${string}`,
    providerAddress: row.providerAddress as `0x${string}` | null,
    amountBaseUnits: row.amountBaseUnits,
    deadline: row.deadline.toISOString(),
    agreementHash: row.agreementHash as `0x${string}`,
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

export class PostgresEscrowRepository implements EscrowRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async beginFunding(input: BeginFundingInput): Promise<BeginFundingResult> {
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
        const [existingOperation] = await transaction
          .select()
          .from(escrowFundingOperations)
          .where(
            and(
              eq(escrowFundingOperations.idempotencyScope, input.idempotency.scope),
              eq(escrowFundingOperations.idempotencyKey, input.idempotency.key),
            ),
          )
          .limit(1);
        const [existingJob] = await transaction
          .select()
          .from(jobs)
          .where(eq(jobs.id, existingClaim.resourceId))
          .limit(1);
        if (existingOperation === undefined || existingJob === undefined) {
          throw new Error('Funding idempotency record references missing state.');
        }
        return {
          job: rowToJob(existingJob),
          operation: rowToFundingOperation(existingOperation),
          replayed: true,
        };
      }

      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, input.operation.jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(input.operation.jobId);
      if (job.state !== 'QUOTED') throw new InvalidJobTransitionError(job.state, 'FUNDED');

      const [activeOperation] = await transaction
        .select({ id: escrowFundingOperations.id })
        .from(escrowFundingOperations)
        .where(
          and(
            eq(escrowFundingOperations.jobId, input.operation.jobId),
            inArray(escrowFundingOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
          ),
        )
        .limit(1);
      if (activeOperation !== undefined) {
        throw new JobFundingInProgressError(input.operation.jobId);
      }
      const [activeAssignment] = await transaction
        .select({ id: jobAssignmentOperations.id })
        .from(jobAssignmentOperations)
        .where(
          inArray(jobAssignmentOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
        )
        .limit(1);
      const [otherFunding] = await transaction
        .select({ id: escrowFundingOperations.id })
        .from(escrowFundingOperations)
        .where(
          and(
            inArray(escrowFundingOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
            sql`${escrowFundingOperations.jobId} <> ${input.operation.jobId}`,
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
      if (
        activeAssignment !== undefined
        || otherFunding !== undefined
        || activeSubmission !== undefined
        || activeVerification !== undefined
        || activeSettlement !== undefined
        || activeReputation !== undefined
      ) {
        throw new ChainSignerBusyError();
      }

      const [operation] = await transaction
        .insert(escrowFundingOperations)
        .values({
          id: input.operation.id,
          jobId: input.operation.jobId,
          status: input.operation.status,
          chainId: input.operation.chainId,
          contractAddress: input.operation.contractAddress,
          signerAddress: input.operation.signerAddress,
          providerAddress: input.operation.providerAddress,
          amountBaseUnits: input.operation.amountBaseUnits,
          deadline: new Date(input.operation.deadline),
          agreementHash: input.operation.agreementHash,
          jobKey: input.operation.jobKey,
          serializedTransaction: input.operation.serializedTransaction,
          transactionHash: input.operation.transactionHash,
          blockNumber: input.operation.blockNumber,
          idempotencyScope: input.operation.idempotencyScope,
          idempotencyKey: input.operation.idempotencyKey,
          requestHash: input.operation.requestHash,
          createdAt,
          updatedAt: new Date(input.operation.updatedAt),
        })
        .returning();
      if (operation === undefined) throw new Error('Funding operation insert returned no row.');

      await transaction
        .insert(escrows)
        .values({
          jobId: input.operation.jobId,
          chainId: input.operation.chainId,
          contractAddress: input.operation.contractAddress,
          buyerAddress: input.operation.signerAddress,
          providerAddress: input.operation.providerAddress,
          amountBaseUnits: input.operation.amountBaseUnits,
          deadline: new Date(input.operation.deadline),
          agreementHash: input.operation.agreementHash,
          status: 'PENDING',
          createdAt,
          updatedAt: createdAt,
        })
        .onConflictDoUpdate({
          target: escrows.jobId,
          set: {
            chainId: input.operation.chainId,
            contractAddress: input.operation.contractAddress,
            buyerAddress: input.operation.signerAddress,
            providerAddress: input.operation.providerAddress,
            amountBaseUnits: input.operation.amountBaseUnits,
            deadline: new Date(input.operation.deadline),
            agreementHash: input.operation.agreementHash,
            status: 'PENDING',
            updatedAt: createdAt,
          },
        });

      return { job: rowToJob(job), operation: rowToFundingOperation(operation), replayed: false };
    });
  }

  public async savePrepared(
    operationId: string,
    prepared: PreparedFundingTransaction,
    updatedAt: string,
  ): Promise<FundingOperation> {
    return this.database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(escrowFundingOperations)
        .where(eq(escrowFundingOperations.id, operationId))
        .for('update')
        .limit(1);
      if (operation === undefined) throw new Error('Funding operation was not found.');
      if (
        operation.contractAddress.toLowerCase() !== prepared.contractAddress.toLowerCase()
        || operation.signerAddress.toLowerCase() !== prepared.signerAddress.toLowerCase()
      ) {
        throw new Error('Prepared transaction does not match the funding operation.');
      }
      if (operation.status !== 'CREATED') return rowToFundingOperation(operation);

      const timestamp = new Date(updatedAt);
      const [updated] = await transaction
        .update(escrowFundingOperations)
        .set({
          status: 'PREPARED',
          jobKey: prepared.jobKey,
          serializedTransaction: prepared.serializedTransaction,
          transactionHash: prepared.transactionHash,
          updatedAt: timestamp,
        })
        .where(eq(escrowFundingOperations.id, operationId))
        .returning();
      if (updated === undefined) throw new Error('Funding operation update returned no row.');

      await transaction
        .update(escrows)
        .set({ jobKey: prepared.jobKey, updatedAt: timestamp })
        .where(eq(escrows.jobId, operation.jobId));
      return rowToFundingOperation(updated);
    });
  }

  public async markBroadcast(operationId: string, updatedAt: string): Promise<FundingOperation> {
    const [operation] = await this.database
      .update(escrowFundingOperations)
      .set({ status: 'BROADCAST', updatedAt: new Date(updatedAt) })
      .where(
        and(
          eq(escrowFundingOperations.id, operationId),
          eq(escrowFundingOperations.status, 'PREPARED'),
        ),
      )
      .returning();
    if (operation !== undefined) return rowToFundingOperation(operation);

    const [existing] = await this.database
      .select()
      .from(escrowFundingOperations)
      .where(eq(escrowFundingOperations.id, operationId))
      .limit(1);
    if (existing === undefined || !['BROADCAST', 'CONFIRMED'].includes(existing.status)) {
      throw new Error('Funding operation cannot be marked broadcast in its current state.');
    }
    return rowToFundingOperation(existing);
  }

  public async confirmFunding(input: ConfirmFundingPersistenceInput): Promise<BeginFundingResult> {
    return this.database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(escrowFundingOperations)
        .where(eq(escrowFundingOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (operation === undefined) throw new Error('Funding operation was not found.');

      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, operation.jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(operation.jobId);
      if (operation.status === 'CONFIRMED') {
        return { job: rowToJob(job), operation: rowToFundingOperation(operation), replayed: true };
      }
      if (!['PREPARED', 'BROADCAST'].includes(operation.status)) {
        throw new Error('Funding operation is not ready for confirmation.');
      }
      if (operation.transactionHash !== input.confirmation.transactionHash) {
        throw new Error('Funding confirmation transaction hash does not match the operation.');
      }
      if (job.state !== 'QUOTED') throw new InvalidJobTransitionError(job.state, 'FUNDED');

      const occurredAt = new Date(input.event.occurredAt);
      const [updatedOperation] = await transaction
        .update(escrowFundingOperations)
        .set({
          status: 'CONFIRMED',
          serializedTransaction: null,
          blockNumber: input.confirmation.blockNumber,
          updatedAt: occurredAt,
        })
        .where(eq(escrowFundingOperations.id, operation.id))
        .returning();
      if (updatedOperation === undefined) throw new Error('Funding confirmation returned no row.');

      await transaction
        .update(escrows)
        .set({
          jobKey: input.confirmation.escrow.jobKey,
          buyerAddress: input.confirmation.escrow.buyer,
          providerAddress: input.confirmation.escrow.provider,
          status: 'FUNDED',
          fundingTransactionHash: input.confirmation.transactionHash,
          fundingBlockNumber: input.confirmation.blockNumber,
          updatedAt: occurredAt,
        })
        .where(eq(escrows.jobId, operation.jobId));

      const [updatedJob] = await transaction
        .update(jobs)
        .set({ state: 'FUNDED', version: sql`${jobs.version} + 1`, updatedAt: occurredAt })
        .where(eq(jobs.id, operation.jobId))
        .returning();
      if (updatedJob === undefined) throw new Error('Funding job transition returned no row.');

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
        operation: rowToFundingOperation(updatedOperation),
        replayed: false,
      };
    });
  }
}
