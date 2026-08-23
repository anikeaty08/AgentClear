import {
  ChainSignerBusyError,
  IdempotencyKeyReusedError,
  InvalidJobTransitionError,
  JobNotFoundError,
  VerificationInProgressError,
  type BeginVerificationInput,
  type ConfirmVerificationInput,
  type Job,
  type JsonValue,
  type MarkVerificationComputingInput,
  type RecordEvaluationInput,
  type VerificationCheckResult,
  type VerificationOperation,
  type VerificationPersistenceResult,
  type VerificationRecord,
  type VerificationRepository,
} from '@agentclear/domain';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import {
  escrowFundingOperations,
  idempotencyRecords,
  jobAssignmentOperations,
  jobs,
  jobStateEvents,
  submissionOperations,
  verificationChecks,
  verificationOperations,
  verificationReports,
  verificationRuns,
  settlementOperations,
  reputationOperations,
  receiptOperations,
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

function rowToOperation(row: typeof verificationOperations.$inferSelect): VerificationOperation {
  return {
    id: row.id,
    runId: row.runId,
    jobId: row.jobId,
    submissionId: row.submissionId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    computePromptHash: row.computePromptHash as `0x${string}` | null,
    canonicalReport: row.canonicalReport,
    reportHash: row.reportHash as `0x${string}` | null,
    outcome: row.outcome,
    scoreBps: row.scoreBps,
    reportStorageRootHash: row.reportStorageRootHash as `0x${string}` | null,
    reportStorageTransactionHash: row.reportStorageTransactionHash as `0x${string}` | null,
    reportStorageTransactionSequence: row.reportStorageTransactionSequence,
    reportSizeBytes: row.reportSizeBytes,
    idempotencyScope: row.idempotencyScope,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash as `0x${string}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type PersistenceBase = Omit<VerificationPersistenceResult, 'verification'>;

export class PostgresVerificationRepository implements VerificationRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async beginVerification(
    input: BeginVerificationInput,
  ): Promise<VerificationPersistenceResult> {
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
        ) {
          throw new IdempotencyKeyReusedError();
        }
        const [operation] = await transaction
          .select()
          .from(verificationOperations)
          .where(
            and(
              eq(verificationOperations.idempotencyScope, input.idempotency.scope),
              eq(verificationOperations.idempotencyKey, input.idempotency.key),
            ),
          )
          .limit(1);
        const [job] = await transaction
          .select()
          .from(jobs)
          .where(eq(jobs.id, existingClaim.resourceId))
          .limit(1);
        if (operation === undefined || job === undefined) {
          throw new Error('Verification idempotency record references missing state.');
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
      if (job.state !== 'SUBMITTED') {
        if (job.state === 'VERIFYING') throw new VerificationInProgressError(job.id);
        throw new InvalidJobTransitionError(job.state, 'VERIFYING');
      }
      if (
        input.startEvent.jobId !== job.id
        || input.startEvent.fromState !== 'SUBMITTED'
        || input.startEvent.toState !== 'VERIFYING'
      ) {
        throw new Error('Verification start event does not match the locked job state.');
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
        .select({ id: submissionOperations.id })
        .from(submissionOperations)
        .where(inArray(submissionOperations.status, ['CREATED', 'STORING']))
        .limit(1);
      const [activeVerification] = await transaction
        .select({ jobId: verificationOperations.jobId })
        .from(verificationOperations)
        .where(
          inArray(verificationOperations.status, ['CREATED', 'COMPUTING', 'EVALUATED', 'STORING']),
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
      if (
        activeFunding !== undefined
        || activeAssignment !== undefined
        || activeSubmission !== undefined
        || activeSettlement !== undefined
        || activeReputation !== undefined
        || activeReceipt !== undefined
      ) {
        throw new ChainSignerBusyError();
      }
      if (activeVerification !== undefined) {
        if (activeVerification.jobId === job.id) throw new VerificationInProgressError(job.id);
        throw new ChainSignerBusyError();
      }

      const [operation] = await transaction
        .insert(verificationOperations)
        .values({
          id: input.operation.id,
          runId: input.operation.runId,
          jobId: input.operation.jobId,
          submissionId: input.operation.submissionId,
          status: 'CREATED',
          startedAt: new Date(input.operation.startedAt),
          idempotencyScope: input.operation.idempotencyScope,
          idempotencyKey: input.operation.idempotencyKey,
          requestHash: input.operation.requestHash,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      if (operation === undefined) throw new Error('Verification operation insert returned no row.');

      const [updatedJob] = await transaction
        .update(jobs)
        .set({
          state: 'VERIFYING',
          version: sql`${jobs.version} + 1`,
          updatedAt: createdAt,
        })
        .where(eq(jobs.id, job.id))
        .returning();
      if (updatedJob === undefined) throw new Error('Verification start returned no job.');
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
      return {
        job: rowToJob(updatedJob),
        operation: rowToOperation(operation),
        replayed: false,
      };
    });
    return {
      ...base,
      verification: base.operation.status === 'CONFIRMED'
        ? await this.#findRecordByRunId(base.operation.runId)
        : null,
    };
  }

  public async recordEvaluation(input: RecordEvaluationInput): Promise<VerificationOperation> {
    const [operation] = await this.database
      .update(verificationOperations)
      .set({
        status: 'EVALUATED',
        canonicalReport: input.canonicalReport,
        reportHash: input.reportHash,
        outcome: input.outcome,
        scoreBps: input.scoreBps,
        updatedAt: new Date(input.updatedAt),
      })
      .where(
        and(
          eq(verificationOperations.id, input.operationId),
          inArray(verificationOperations.status, ['CREATED', 'COMPUTING']),
        ),
      )
      .returning();
    if (operation === undefined) throw new Error('Verification evaluation could not be recorded.');
    return rowToOperation(operation);
  }

  public async markComputing(
    input: MarkVerificationComputingInput,
  ): Promise<VerificationOperation> {
    const [operation] = await this.database
      .update(verificationOperations)
      .set({
        status: 'COMPUTING',
        computePromptHash: input.promptHash,
        updatedAt: new Date(input.updatedAt),
      })
      .where(
        and(
          eq(verificationOperations.id, input.operationId),
          eq(verificationOperations.status, 'CREATED'),
        ),
      )
      .returning();
    if (operation === undefined) {
      throw new Error('Verification compute request cannot begin in its current state.');
    }
    return rowToOperation(operation);
  }

  public async markReportStoring(
    operationId: string,
    updatedAt: string,
  ): Promise<VerificationOperation> {
    const [operation] = await this.database
      .update(verificationOperations)
      .set({ status: 'STORING', updatedAt: new Date(updatedAt) })
      .where(
        and(
          eq(verificationOperations.id, operationId),
          eq(verificationOperations.status, 'EVALUATED'),
        ),
      )
      .returning();
    if (operation !== undefined) return rowToOperation(operation);
    const [existing] = await this.database
      .select()
      .from(verificationOperations)
      .where(eq(verificationOperations.id, operationId))
      .limit(1);
    if (existing === undefined || !['STORING', 'CONFIRMED'].includes(existing.status)) {
      throw new Error('Verification report cannot begin storage in its current state.');
    }
    return rowToOperation(existing);
  }

  public async confirmVerification(
    input: ConfirmVerificationInput,
  ): Promise<VerificationPersistenceResult> {
    const base = await this.database.transaction(async (transaction): Promise<PersistenceBase> => {
      const [operation] = await transaction
        .select()
        .from(verificationOperations)
        .where(eq(verificationOperations.id, input.operationId))
        .for('update')
        .limit(1);
      if (operation === undefined) throw new Error('Verification operation was not found.');
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, operation.jobId))
        .for('update')
        .limit(1);
      if (job === undefined) throw new JobNotFoundError(operation.jobId);
      if (operation.status === 'CONFIRMED') {
        return { job: rowToJob(job), operation: rowToOperation(operation), replayed: true };
      }
      const reportBytes = new TextEncoder().encode(operation.canonicalReport ?? '');
      const expectedState = input.report.outcome === 'PASS'
        ? 'PASSED'
        : input.report.outcome === 'FAIL'
          ? 'FAILED'
          : 'NEEDS_REVIEW';
      const reportPromptHash = input.report.version === '2' && input.report.ai !== null
        ? input.report.ai.promptHash
        : null;
      if (
        operation.status !== 'STORING'
        || operation.reportHash === null
        || operation.outcome !== input.report.outcome
        || operation.scoreBps !== input.report.scoreBps
        || operation.runId !== input.report.runId
        || operation.jobId !== input.report.jobId
        || operation.submissionId !== input.report.submissionId
        || (reportPromptHash === null
          ? operation.computePromptHash !== null
          : operation.computePromptHash?.toLowerCase() !== reportPromptHash.toLowerCase())
        || input.storage.sizeBytes !== reportBytes.byteLength
        || job.state !== 'VERIFYING'
        || input.event.jobId !== job.id
        || input.event.fromState !== 'VERIFYING'
        || input.event.toState !== expectedState
      ) {
        throw new Error('Verification confirmation does not match the active operation.');
      }

      const completedAt = new Date(input.event.occurredAt);
      await transaction.insert(verificationRuns).values({
        id: operation.runId,
        jobId: operation.jobId,
        submissionId: operation.submissionId,
        mode: input.report.mode,
        outcome: input.report.outcome,
        scoreBps: input.report.scoreBps,
        minimumScoreBps: input.report.minimumScoreBps,
        verifierVersion: input.report.verifier.version,
        aiResult: input.report.version === '2' ? input.report.ai : null,
        startedAt: operation.startedAt,
        completedAt,
      });
      if (input.report.checks.length > 0) {
        await transaction.insert(verificationChecks).values(
          input.report.checks.map((check) => ({
            runId: operation.runId,
            checkId: check.id,
            kind: check.kind,
            description: check.description,
            path: check.path,
            weightBps: check.weightBps,
            hardFailure: check.hardFailure,
            passed: check.passed,
            expected: check.expected ?? null,
            actual: check.actual ?? null,
            expectedPresent: check.expected !== undefined,
            actualPresent: check.actual !== undefined,
            message: check.message,
          })),
        );
      }
      await transaction.insert(verificationReports).values({
        runId: operation.runId,
        reportHash: operation.reportHash,
        storageRootHash: input.storage.rootHash,
        storageTransactionHash: input.storage.transactionHash,
        storageTransactionSequence: input.storage.transactionSequence,
        sizeBytes: input.storage.sizeBytes,
        createdAt: completedAt,
      });
      const [updatedOperation] = await transaction
        .update(verificationOperations)
        .set({
          status: 'CONFIRMED',
          canonicalReport: null,
          reportStorageRootHash: input.storage.rootHash,
          reportStorageTransactionHash: input.storage.transactionHash,
          reportStorageTransactionSequence: input.storage.transactionSequence,
          reportSizeBytes: input.storage.sizeBytes,
          updatedAt: completedAt,
        })
        .where(eq(verificationOperations.id, operation.id))
        .returning();
      if (updatedOperation === undefined) throw new Error('Verification confirmation returned no row.');
      const [updatedJob] = await transaction
        .update(jobs)
        .set({ state: expectedState, version: sql`${jobs.version} + 1`, updatedAt: completedAt })
        .where(eq(jobs.id, job.id))
        .returning();
      if (updatedJob === undefined) throw new Error('Verification finalization returned no job.');
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
        occurredAt: completedAt,
      });
      return {
        job: rowToJob(updatedJob),
        operation: rowToOperation(updatedOperation),
        replayed: false,
      };
    });
    const verification = await this.#findRecordByRunId(base.operation.runId);
    if (verification === null) throw new Error('Confirmed verification record was not found.');
    return { ...base, verification };
  }

  public async listByJob(jobId: string): Promise<VerificationRecord[]> {
    const rows = await this.database
      .select({ runId: verificationRuns.id })
      .from(verificationRuns)
      .where(eq(verificationRuns.jobId, jobId))
      .orderBy(asc(verificationRuns.completedAt));
    return Promise.all(rows.map(async (row) => {
      const record = await this.#findRecordByRunId(row.runId);
      if (record === null) throw new Error('Verification run is missing its report.');
      return record;
    }));
  }

  async #findRecordByRunId(runId: string): Promise<VerificationRecord | null> {
    const [row] = await this.database
      .select({ run: verificationRuns, report: verificationReports })
      .from(verificationRuns)
      .innerJoin(verificationReports, eq(verificationReports.runId, verificationRuns.id))
      .where(eq(verificationRuns.id, runId))
      .limit(1);
    if (row === undefined) return null;
    const checkRows = await this.database
      .select()
      .from(verificationChecks)
      .where(eq(verificationChecks.runId, runId))
      .orderBy(asc(verificationChecks.checkId));
    const checks: VerificationCheckResult[] = checkRows.map((check) => ({
      id: check.checkId,
      kind: check.kind,
      description: check.description,
      path: check.path,
      weightBps: check.weightBps,
      hardFailure: check.hardFailure,
      passed: check.passed,
      ...(check.expectedPresent ? { expected: check.expected as JsonValue } : {}),
      ...(check.actualPresent ? { actual: check.actual as JsonValue } : {}),
      message: check.message,
    }));
    return {
      runId: row.run.id,
      jobId: row.run.jobId,
      submissionId: row.run.submissionId,
      mode: row.run.mode as VerificationRecord['mode'],
      outcome: row.run.outcome,
      scoreBps: row.run.scoreBps,
      minimumScoreBps: row.run.minimumScoreBps,
      verifierVersion: row.run.verifierVersion,
      ai: row.run.aiResult,
      reportHash: row.report.reportHash as `0x${string}`,
      reportStorageRootHash: row.report.storageRootHash as `0x${string}`,
      reportStorageTransactionHash: row.report.storageTransactionHash as `0x${string}` | null,
      reportStorageTransactionSequence: row.report.storageTransactionSequence,
      reportSizeBytes: row.report.sizeBytes,
      checks,
      startedAt: row.run.startedAt.toISOString(),
      completedAt: row.run.completedAt.toISOString(),
    };
  }
}
