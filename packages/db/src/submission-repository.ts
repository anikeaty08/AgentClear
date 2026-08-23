import {
  ChainSignerBusyError,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobNotFoundError,
  ProviderNotAuthorizedError,
  SubmissionInProgressError,
  type BeginSubmissionInput,
  type ConfirmSubmissionPersistenceInput,
  type Submission,
  type SubmissionOperation,
  type SubmissionRepository,
  type SubmissionResult,
} from '@agentclear/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import {
  escrowFundingOperations,
  idempotencyRecords,
  jobAssignmentOperations,
  jobs,
  jobStateEvents,
  submissionArtifacts,
  submissionOperations,
  submissions,
} from './schema.js';

function rowToOperation(row: typeof submissionOperations.$inferSelect): SubmissionOperation {
  return {
    id: row.id,
    submissionId: row.submissionId,
    jobId: row.jobId,
    status: row.status,
    providerAgentId: row.providerAgentId,
    canonicalPayload: row.canonicalPayload,
    submissionHash: row.submissionHash as `0x${string}`,
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

export class PostgresSubmissionRepository implements SubmissionRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async beginSubmission(input: BeginSubmissionInput): Promise<SubmissionResult> {
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
        if (
          existingClaim === undefined
          || existingClaim.requestHash !== input.idempotency.requestHash
        ) {
          throw new IdempotencyKeyReusedError();
        }
        const [operation] = await transaction
          .select()
          .from(submissionOperations)
          .where(
            and(
              eq(submissionOperations.idempotencyScope, input.idempotency.scope),
              eq(submissionOperations.idempotencyKey, input.idempotency.key),
            ),
          )
          .limit(1);
        const [job] = await transaction
          .select()
          .from(jobs)
          .where(eq(jobs.id, existingClaim.resourceId))
          .limit(1);
        if (operation === undefined || job === undefined) {
          throw new Error('Submission idempotency record references missing state.');
        }
        const [submission] = await transaction
          .select()
          .from(submissions)
          .where(eq(submissions.id, operation.submissionId))
          .limit(1);
        return {
          job: rowToJob(job),
          operation: rowToOperation(operation),
          submission: submission === undefined ? null : rowToSubmission(submission),
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
      if (job.providerAgentId !== input.operation.providerAgentId) {
        throw new ProviderNotAuthorizedError();
      }
      if (!['ASSIGNED', 'RETRY'].includes(job.state)) {
        if (job.state === 'IN_PROGRESS') throw new SubmissionInProgressError(job.id);
        throw new InvalidJobTransitionError(job.state, 'IN_PROGRESS');
      }
      if (
        input.startEvent.fromState !== job.state
        || input.startEvent.toState !== 'IN_PROGRESS'
      ) {
        throw new Error('Submission start event does not match the locked job state.');
      }

      const [activeFunding] = await transaction
        .select({ id: escrowFundingOperations.id })
        .from(escrowFundingOperations)
        .where(inArray(escrowFundingOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']))
        .limit(1);
      const [activeAssignment] = await transaction
        .select({ id: jobAssignmentOperations.id })
        .from(jobAssignmentOperations)
        .where(
          inArray(jobAssignmentOperations.status, ['CREATED', 'PREPARED', 'BROADCAST']),
        )
        .limit(1);
      const [activeSubmission] = await transaction
        .select({ jobId: submissionOperations.jobId })
        .from(submissionOperations)
        .where(inArray(submissionOperations.status, ['CREATED', 'STORING']))
        .limit(1);
      if (activeFunding !== undefined || activeAssignment !== undefined) {
        throw new ChainSignerBusyError();
      }
      if (activeSubmission !== undefined) {
        if (activeSubmission.jobId === job.id) throw new SubmissionInProgressError(job.id);
        throw new ChainSignerBusyError();
      }

      const [operation] = await transaction
        .insert(submissionOperations)
        .values({
          id: input.operation.id,
          submissionId: input.operation.submissionId,
          jobId: input.operation.jobId,
          status: input.operation.status,
          providerAgentId: input.operation.providerAgentId,
          canonicalPayload: input.operation.canonicalPayload,
          submissionHash: input.operation.submissionHash,
          sizeBytes: input.operation.sizeBytes,
          idempotencyScope: input.operation.idempotencyScope,
          idempotencyKey: input.operation.idempotencyKey,
          requestHash: input.operation.requestHash,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      if (operation === undefined) throw new Error('Submission operation insert returned no row.');

      const [updatedJob] = await transaction
        .update(jobs)
        .set({
          state: 'IN_PROGRESS',
          version: sql`${jobs.version} + 1`,
          updatedAt: createdAt,
        })
        .where(eq(jobs.id, job.id))
        .returning();
      if (updatedJob === undefined) throw new Error('Submission job start returned no row.');
      await transaction.insert(jobStateEvents).values({
        id: input.startEvent.id,
        jobId: input.startEvent.jobId,
        fromState: input.startEvent.fromState,
        toState: input.startEvent.toState,
        actorType: input.startEvent.actorType,
        actorId: input.startEvent.actorId,
        reason: input.startEvent.reason,
        occurredAt: createdAt,
      });

      return {
        job: rowToJob(updatedJob),
        operation: rowToOperation(operation),
        submission: null,
        replayed: false,
      };
    });
  }

  public async markStoring(
    operationId: string,
    updatedAt: string,
  ): Promise<SubmissionOperation> {
    const [operation] = await this.database
      .update(submissionOperations)
      .set({ status: 'STORING', updatedAt: new Date(updatedAt) })
      .where(
        and(eq(submissionOperations.id, operationId), eq(submissionOperations.status, 'CREATED')),
      )
      .returning();
    if (operation !== undefined) return rowToOperation(operation);
    const [existing] = await this.database
      .select()
      .from(submissionOperations)
      .where(eq(submissionOperations.id, operationId))
      .limit(1);
    if (existing === undefined || !['STORING', 'CONFIRMED'].includes(existing.status)) {
      throw new Error('Submission operation cannot begin storage in its current state.');
    }
    return rowToOperation(existing);
  }

  public async confirmSubmission(
    input: ConfirmSubmissionPersistenceInput,
  ): Promise<SubmissionResult> {
    return this.database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(submissionOperations)
        .where(eq(submissionOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (operation === undefined) throw new Error('Submission operation was not found.');
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, operation.jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(operation.jobId);
      if (operation.status === 'CONFIRMED') {
        const [submission] = await transaction
          .select()
          .from(submissions)
          .where(eq(submissions.id, operation.submissionId))
          .limit(1);
        if (submission === undefined) throw new Error('Confirmed submission row was not found.');
        return {
          job: rowToJob(job),
          operation: rowToOperation(operation),
          submission: rowToSubmission(submission),
          replayed: true,
        };
      }
      if (operation.status !== 'STORING') {
        throw new Error('Submission operation is not ready for confirmation.');
      }
      if (
        !input.storage.verified
        || input.storage.sizeBytes !== operation.sizeBytes
        || job.state !== 'IN_PROGRESS'
      ) {
        throw new Error('Storage confirmation does not match the active submission.');
      }

      const submittedAt = new Date(input.event.occurredAt);
      const [updatedOperation] = await transaction
        .update(submissionOperations)
        .set({
          status: 'CONFIRMED',
          canonicalPayload: null,
          storageRootHash: input.storage.rootHash,
          storageTransactionHash: input.storage.transactionHash,
          storageTransactionSequence: input.storage.transactionSequence,
          updatedAt: submittedAt,
        })
        .where(eq(submissionOperations.id, operation.id))
        .returning();
      if (updatedOperation === undefined) throw new Error('Submission confirmation returned no row.');

      const [submission] = await transaction
        .insert(submissions)
        .values({
          id: operation.submissionId,
          jobId: operation.jobId,
          providerAgentId: operation.providerAgentId,
          submissionHash: operation.submissionHash,
          contentType: 'application/json',
          storageRootHash: input.storage.rootHash,
          storageTransactionHash: input.storage.transactionHash,
          storageTransactionSequence: input.storage.transactionSequence,
          sizeBytes: operation.sizeBytes,
          submittedAt,
        })
        .returning();
      if (submission === undefined) throw new Error('Submission insert returned no row.');
      await transaction.insert(submissionArtifacts).values({
        id: operation.id,
        submissionId: operation.submissionId,
        kind: 'deliverable',
        contentHash: operation.submissionHash,
        storageRootHash: input.storage.rootHash,
        sizeBytes: operation.sizeBytes,
        createdAt: submittedAt,
      });

      const [updatedJob] = await transaction
        .update(jobs)
        .set({
          state: 'SUBMITTED',
          version: sql`${jobs.version} + 1`,
          updatedAt: submittedAt,
        })
        .where(eq(jobs.id, operation.jobId))
        .returning();
      if (updatedJob === undefined) throw new Error('Submission job transition returned no row.');
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
        occurredAt: submittedAt,
      });

      return {
        job: rowToJob(updatedJob),
        operation: rowToOperation(updatedOperation),
        submission: rowToSubmission(submission),
        replayed: false,
      };
    });
  }

  public async listByJob(jobId: string): Promise<Submission[]> {
    const rows = await this.database
      .select()
      .from(submissions)
      .where(eq(submissions.jobId, jobId))
      .orderBy(submissions.submittedAt);
    return rows.map(rowToSubmission);
  }
}
