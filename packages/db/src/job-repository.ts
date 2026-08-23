import {
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobNotFoundError,
  type CreateJobPersistenceInput,
  type CreateJobPersistenceResult,
  type Job,
  type JobRepository,
  type TransitionJobPersistenceInput,
  type TransitionJobPersistenceResult,
} from '@agentclear/domain';
import { and, eq, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import { idempotencyRecords, jobRequirements, jobs, jobStateEvents } from './schema.js';

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

export class PostgresJobRepository implements JobRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async create(input: CreateJobPersistenceInput): Promise<CreateJobPersistenceResult> {
    return this.database.transaction(async (transaction) => {
      const claimedAt = new Date(input.job.createdAt);
      const [claim] = await transaction
        .insert(idempotencyRecords)
        .values({
          scope: input.idempotency.scope,
          key: input.idempotency.key,
          requestHash: input.idempotency.requestHash,
          resourceId: input.idempotency.resourceId,
          createdAt: claimedAt,
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

        const [existingJob] = await transaction
          .select()
          .from(jobs)
          .where(eq(jobs.id, existingClaim.resourceId))
          .limit(1);
        if (existingJob === undefined) {
          throw new Error('Idempotency record references a missing job.');
        }

        return { job: rowToJob(existingJob), replayed: true };
      }

      await transaction.insert(jobs).values({
        id: input.job.id,
        buyerAgentId: input.job.agreement.buyerAgentId,
        providerAgentId: input.job.agreement.providerAgentId,
        title: input.job.agreement.title,
        description: input.job.agreement.description,
        budgetToken: input.job.agreement.budget.token,
        budgetMaxAmount: input.job.agreement.budget.maxAmount,
        budgetAmountBaseUnits: input.job.budgetAmountBaseUnits,
        deadline: new Date(input.job.agreement.deadline),
        deliverableType: input.job.agreement.deliverable.type,
        deliverableFormat: input.job.agreement.deliverable.format,
        verificationMode: input.job.agreement.verification.mode,
        minimumScoreBps: input.job.minimumScoreBps,
        refundOnExpiry: input.job.agreement.refundPolicy.onExpiry,
        refundOnFinalFailure: input.job.agreement.refundPolicy.onFinalFailure,
        state: input.job.state,
        agreementSnapshot: input.job.agreement,
        agreementHash: input.job.agreementHash,
        version: input.job.version,
        createdAt: new Date(input.job.createdAt),
        updatedAt: new Date(input.job.updatedAt),
      });

      await transaction.insert(jobRequirements).values(
        input.job.agreement.verification.requirements.map((requirement, ordinal) => ({
          jobId: input.job.id,
          ordinal,
          requirement,
        })),
      );

      await transaction.insert(jobStateEvents).values({
        id: input.initialEvent.id,
        jobId: input.initialEvent.jobId,
        fromState: input.initialEvent.fromState,
        toState: input.initialEvent.toState,
        actorType: input.initialEvent.actorType,
        actorId: input.initialEvent.actorId,
        reason: input.initialEvent.reason,
        transactionHash: input.initialEvent.transactionHash,
        evidenceReference: input.initialEvent.evidenceReference,
        occurredAt: new Date(input.initialEvent.occurredAt),
      });

      return { job: input.job, replayed: false };
    });
  }

  public async findById(jobId: string): Promise<Job | null> {
    const [row] = await this.database.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    return row === undefined ? null : rowToJob(row);
  }

  public async transition(
    input: TransitionJobPersistenceInput,
  ): Promise<TransitionJobPersistenceResult> {
    return this.database.transaction(async (transaction) => {
      const occurredAt = new Date(input.event.occurredAt);
      const [claim] = await transaction
        .insert(idempotencyRecords)
        .values({
          scope: input.idempotency.scope,
          key: input.idempotency.key,
          requestHash: input.idempotency.requestHash,
          resourceId: input.idempotency.resourceId,
          createdAt: occurredAt,
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
        const [existingJob] = await transaction
          .select()
          .from(jobs)
          .where(eq(jobs.id, existingClaim.resourceId))
          .limit(1);
        if (existingJob === undefined) {
          throw new Error('Idempotency record references a missing job.');
        }
        return { job: rowToJob(existingJob), replayed: true };
      }

      const [currentJob] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, input.jobId))
        .for('update')
        .limit(1);
      if (currentJob === undefined) {
        throw new JobNotFoundError(input.jobId);
      }
      if (currentJob.state !== input.expectedState) {
        throw new InvalidJobTransitionError(currentJob.state, input.nextState);
      }

      const [updatedJob] = await transaction
        .update(jobs)
        .set({
          state: input.nextState,
          version: sql`${jobs.version} + 1`,
          updatedAt: occurredAt,
        })
        .where(eq(jobs.id, input.jobId))
        .returning();
      if (updatedJob === undefined) {
        throw new Error('Locked job disappeared during state transition.');
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
        occurredAt,
      });

      return { job: rowToJob(updatedJob), replayed: false };
    });
  }

  public async ping(): Promise<void> {
    await this.database.execute(sql`select 1`);
  }
}
