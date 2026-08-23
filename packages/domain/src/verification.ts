import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, sha256Bytes, sha256Commitment, type JsonValue } from './canonical.js';
import {
  DomainError,
  EvidenceIntegrityFailedError,
  JobNotFoundError,
  StorageOperationFailedError,
  VerificationPolicyUnsupportedError,
} from './errors.js';
import { InMemoryExclusiveExecutor, type ExclusiveExecutor } from './exclusive-executor.js';
import type { DeterministicCheck, Job, JobActor, JobStateEvent } from './job.js';
import type { IdempotencyClaim, JobRepository } from './job-repository.js';
import {
  submissionManifestSchema,
  type EvidenceStorageResult,
  type EvidenceStore,
  type Submission,
  type SubmissionRepository,
} from './submission.js';

export const verifyResultInputSchema = z.object({}).strict();

export type VerificationOutcome = 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
export type VerificationOperationStatus = 'CREATED' | 'EVALUATED' | 'STORING' | 'CONFIRMED';

export type VerificationCheckResult = {
  id: string;
  kind: DeterministicCheck['kind'];
  description: string;
  path: readonly (number | string)[];
  weightBps: number;
  hardFailure: boolean;
  passed: boolean;
  expected?: JsonValue;
  actual?: JsonValue;
  message: string;
};

export type VerificationReport = {
  version: '1';
  runId: string;
  jobId: string;
  agreementHash: `0x${string}`;
  submissionId: string;
  submissionHash: `0x${string}`;
  submissionStorageRoot: `0x${string}`;
  mode: Job['agreement']['verification']['mode'];
  minimumScoreBps: number;
  scoreBps: number;
  outcome: VerificationOutcome;
  checks: VerificationCheckResult[];
  verifier: {
    kind: 'deterministic';
    version: 'agentclear-deterministic-v1';
  };
  startedAt: string;
  completedAt: string;
};

const verificationCheckResultSchema = z
  .object({
    id: z.string().min(1).max(100),
    kind: z.enum(['json_path_exists', 'json_path_equals', 'json_type']),
    description: z.string().min(1).max(500),
    path: z.array(z.union([z.string(), z.number().int().min(0)])).min(1).max(32),
    weightBps: z.number().int().min(1).max(10_000),
    hardFailure: z.boolean(),
    passed: z.boolean(),
    expected: z.json().optional(),
    actual: z.json().optional(),
    message: z.string().min(1).max(500),
  })
  .strict();

export const verificationReportSchema = z
  .object({
    version: z.literal('1'),
    runId: z.uuid(),
    jobId: z.uuid(),
    agreementHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    submissionId: z.uuid(),
    submissionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    submissionStorageRoot: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    mode: z.enum(['deterministic', 'rubric', 'ai', 'deterministic_plus_ai']),
    minimumScoreBps: z.number().int().min(0).max(10_000),
    scoreBps: z.number().int().min(0).max(10_000),
    outcome: z.enum(['PASS', 'FAIL', 'NEEDS_REVIEW']),
    checks: z.array(verificationCheckResultSchema).max(50),
    verifier: z
      .object({
        kind: z.literal('deterministic'),
        version: z.literal('agentclear-deterministic-v1'),
      })
      .strict(),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((report, context) => {
    if (Date.parse(report.completedAt) < Date.parse(report.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Verification completion cannot precede its start.',
      });
    }
    const ids = new Set<string>();
    for (const [index, check] of report.checks.entries()) {
      if (ids.has(check.id)) {
        context.addIssue({
          code: 'custom',
          path: ['checks', index, 'id'],
          message: 'Verification check IDs must be unique.',
        });
      }
      ids.add(check.id);
    }
  });

export type VerificationOperation = {
  id: string;
  runId: string;
  jobId: string;
  submissionId: string;
  status: VerificationOperationStatus;
  startedAt: string;
  canonicalReport: string | null;
  reportHash: `0x${string}` | null;
  outcome: VerificationOutcome | null;
  scoreBps: number | null;
  reportStorageRootHash: `0x${string}` | null;
  reportStorageTransactionHash: `0x${string}` | null;
  reportStorageTransactionSequence: number | null;
  reportSizeBytes: number | null;
  idempotencyScope: string;
  idempotencyKey: string;
  requestHash: `0x${string}`;
  createdAt: string;
  updatedAt: string;
};

export type VerificationRecord = {
  runId: string;
  jobId: string;
  submissionId: string;
  mode: Job['agreement']['verification']['mode'];
  outcome: VerificationOutcome;
  scoreBps: number;
  minimumScoreBps: number;
  verifierVersion: string;
  reportHash: `0x${string}`;
  reportStorageRootHash: `0x${string}`;
  reportStorageTransactionHash: `0x${string}` | null;
  reportStorageTransactionSequence: number;
  reportSizeBytes: number;
  checks: VerificationCheckResult[];
  startedAt: string;
  completedAt: string;
};

export type BeginVerificationInput = {
  operation: VerificationOperation;
  idempotency: IdempotencyClaim;
  startEvent: JobStateEvent;
};

export type VerificationPersistenceResult = {
  job: Job;
  operation: VerificationOperation;
  verification: VerificationRecord | null;
  replayed: boolean;
};

export type RecordEvaluationInput = {
  operationId: string;
  canonicalReport: string;
  reportHash: `0x${string}`;
  outcome: VerificationOutcome;
  scoreBps: number;
  updatedAt: string;
};

export type ConfirmVerificationInput = {
  operationId: string;
  report: VerificationReport;
  storage: EvidenceStorageResult;
  event: JobStateEvent;
};

export interface VerificationRepository {
  beginVerification(input: BeginVerificationInput): Promise<VerificationPersistenceResult>;
  recordEvaluation(input: RecordEvaluationInput): Promise<VerificationOperation>;
  markReportStoring(operationId: string, updatedAt: string): Promise<VerificationOperation>;
  confirmVerification(input: ConfirmVerificationInput): Promise<VerificationPersistenceResult>;
  listByJob(jobId: string): Promise<VerificationRecord[]>;
}

type ResolvedPath = { found: false } | { found: true; value: JsonValue };

function resolvePath(root: JsonValue, path: readonly (number | string)[]): ResolvedPath {
  let current: JsonValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (typeof segment !== 'number' || segment >= current.length) return { found: false };
      current = current[segment]!;
      continue;
    }
    if (current === null || typeof current !== 'object' || typeof segment !== 'string') {
      return { found: false };
    }
    const record = current as { readonly [key: string]: JsonValue | undefined };
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return { found: false };
    const next = record[segment];
    if (next === undefined) return { found: false };
    current = next;
  }
  return { found: true, value: current };
}

function jsonType(value: JsonValue): 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as 'boolean' | 'number' | 'object' | 'string';
}

function evaluateCheck(check: DeterministicCheck, result: JsonValue): VerificationCheckResult {
  const resolved = resolvePath(result, check.path);
  const common = {
    id: check.id,
    kind: check.kind,
    description: check.description,
    path: check.path,
    weightBps: check.weightBps,
    hardFailure: check.hardFailure,
  };
  if (check.kind === 'json_path_exists') {
    return {
      ...common,
      passed: resolved.found,
      ...(resolved.found ? { actual: resolved.value } : {}),
      message: resolved.found ? 'Required JSON path exists.' : 'Required JSON path is missing.',
    };
  }
  if (check.kind === 'json_path_equals') {
    const passed = resolved.found && canonicalJson(resolved.value) === canonicalJson(check.expected);
    return {
      ...common,
      passed,
      expected: check.expected,
      ...(resolved.found ? { actual: resolved.value } : {}),
      message: passed ? 'JSON value matched exactly.' : 'JSON value did not match exactly.',
    };
  }
  const actualType = resolved.found ? jsonType(resolved.value) : undefined;
  const passed = actualType === check.expectedType;
  return {
    ...common,
    passed,
    expected: check.expectedType,
    ...(actualType === undefined ? {} : { actual: actualType }),
    message: passed ? 'JSON value has the required type.' : 'JSON value has the wrong type.',
  };
}

export function evaluateDeterministicChecks(
  checks: readonly DeterministicCheck[],
  result: JsonValue,
): { checks: VerificationCheckResult[]; scoreBps: number; hardFailure: boolean } {
  const evaluated = checks.map((check) => evaluateCheck(check, result));
  const totalWeight = evaluated.reduce((total, check) => total + check.weightBps, 0);
  const passedWeight = evaluated.reduce(
    (total, check) => total + (check.passed ? check.weightBps : 0),
    0,
  );
  const scoreBps = totalWeight === 0 ? 0 : Math.round((passedWeight * 10_000) / totalWeight);
  return {
    checks: evaluated,
    scoreBps,
    hardFailure: evaluated.some((check) => check.hardFailure && !check.passed),
  };
}

export function determineVerificationOutcome(
  mode: Job['agreement']['verification']['mode'],
  scoreBps: number,
  minimumScoreBps: number,
  hardFailure: boolean,
): VerificationOutcome {
  if (hardFailure) return 'FAIL';
  if (mode === 'deterministic') return scoreBps >= minimumScoreBps ? 'PASS' : 'FAIL';
  return 'NEEDS_REVIEW';
}

export class VerificationQueryService {
  public constructor(
    private readonly jobRepository: JobRepository,
    private readonly repository: VerificationRepository,
  ) {}

  public async listVerifications(jobId: string): Promise<VerificationRecord[]> {
    if (await this.jobRepository.findById(jobId) === null) throw new JobNotFoundError(jobId);
    return this.repository.listByJob(jobId);
  }
}

export class VerificationService {
  readonly #jobRepository: JobRepository;
  readonly #submissionRepository: SubmissionRepository;
  readonly #repository: VerificationRepository;
  readonly #storage: EvidenceStore;
  readonly #maxReportBytes: number;
  readonly #executor: ExclusiveExecutor;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  public constructor(dependencies: {
    jobRepository: JobRepository;
    submissionRepository: SubmissionRepository;
    verificationRepository: VerificationRepository;
    storage: EvidenceStore;
    maxReportBytes: number;
    executor?: ExclusiveExecutor;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    if (!Number.isSafeInteger(dependencies.maxReportBytes) || dependencies.maxReportBytes <= 0) {
      throw new TypeError('Verification report limit must be a positive integer.');
    }
    this.#jobRepository = dependencies.jobRepository;
    this.#submissionRepository = dependencies.submissionRepository;
    this.#repository = dependencies.verificationRepository;
    this.#storage = dependencies.storage;
    this.#maxReportBytes = dependencies.maxReportBytes;
    this.#executor = dependencies.executor ?? new InMemoryExclusiveExecutor();
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  public async verifyResult(
    jobId: string,
    rawInput: unknown,
    context: { actor: JobActor; idempotencyKey: string },
  ): Promise<VerificationPersistenceResult> {
    verifyResultInputSchema.parse(rawInput);
    return this.#executor.runExclusive(async () => {
      const job = await this.#jobRepository.findById(jobId);
      if (job === null) throw new JobNotFoundError(jobId);
      const submissions = await this.#submissionRepository.listByJob(jobId);
      const submission = submissions.at(-1);
      if (submission === undefined) throw new EvidenceIntegrityFailedError();
      const configuredChecks = job.agreement.verification.deterministicChecks ?? [];
      if (job.agreement.verification.mode === 'deterministic' && configuredChecks.length === 0) {
        throw new VerificationPolicyUnsupportedError();
      }

      const now = this.#clock();
      const runId = this.#idGenerator();
      const idempotencyScope = `jobs:verify:${context.actor.id}:${jobId}`;
      const requestHash = sha256Commitment({ jobId, submissionId: submission.id });
      let persisted = await this.#repository.beginVerification({
        operation: {
          id: this.#idGenerator(),
          runId,
          jobId,
          submissionId: submission.id,
          status: 'CREATED',
          startedAt: now.toISOString(),
          canonicalReport: null,
          reportHash: null,
          outcome: null,
          scoreBps: null,
          reportStorageRootHash: null,
          reportStorageTransactionHash: null,
          reportStorageTransactionSequence: null,
          reportSizeBytes: null,
          idempotencyScope,
          idempotencyKey: context.idempotencyKey,
          requestHash,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        idempotency: {
          scope: idempotencyScope,
          key: context.idempotencyKey,
          requestHash,
          resourceId: jobId,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        },
        startEvent: {
          id: this.#idGenerator(),
          jobId,
          fromState: 'SUBMITTED',
          toState: 'VERIFYING',
          actorType: context.actor.type,
          actorId: context.actor.id,
          reason: 'Evidence-backed verification started.',
          evidenceReference: `0g://${submission.storageRootHash}`,
          occurredAt: now.toISOString(),
        },
      });
      if (persisted.operation.status === 'CONFIRMED') return persisted;

      try {
        if (persisted.operation.status === 'CREATED') {
          const report = await this.#evaluate(job, submission, persisted.operation);
          const canonicalReport = canonicalJson(report);
          const reportBytes = new TextEncoder().encode(canonicalReport);
          if (reportBytes.byteLength > this.#maxReportBytes) {
            throw new StorageOperationFailedError();
          }
          persisted = {
            ...persisted,
            operation: await this.#repository.recordEvaluation({
              operationId: persisted.operation.id,
              canonicalReport,
              reportHash: sha256Bytes(reportBytes),
              outcome: report.outcome,
              scoreBps: report.scoreBps,
              updatedAt: report.completedAt,
            }),
          };
        }
        if (persisted.operation.status === 'EVALUATED') {
          persisted = {
            ...persisted,
            operation: await this.#repository.markReportStoring(
              persisted.operation.id,
              this.#clock().toISOString(),
            ),
          };
        }
        const canonicalReport = persisted.operation.canonicalReport;
        const reportHash = persisted.operation.reportHash;
        if (canonicalReport === null || reportHash === null) {
          throw new EvidenceIntegrityFailedError();
        }
        const reportBytes = new TextEncoder().encode(canonicalReport);
        if (
          reportBytes.byteLength > this.#maxReportBytes
          || sha256Bytes(reportBytes).toLowerCase() !== reportHash.toLowerCase()
        ) {
          throw new EvidenceIntegrityFailedError();
        }
        let parsedReport: unknown;
        try {
          parsedReport = JSON.parse(canonicalReport);
        } catch {
          throw new EvidenceIntegrityFailedError();
        }
        const parsed = verificationReportSchema.safeParse(parsedReport);
        if (!parsed.success) throw new EvidenceIntegrityFailedError();
        const report = parsed.data as VerificationReport;
        if (
          report.runId !== persisted.operation.runId
          || report.jobId !== jobId
          || report.submissionId !== submission.id
          || report.outcome !== persisted.operation.outcome
          || report.scoreBps !== persisted.operation.scoreBps
        ) {
          throw new EvidenceIntegrityFailedError();
        }
        const storage = await this.#storage.uploadVerified(reportBytes);
        if (storage.sizeBytes !== reportBytes.byteLength) throw new StorageOperationFailedError();
        const targetState = report.outcome === 'PASS'
          ? 'PASSED'
          : report.outcome === 'FAIL'
            ? 'FAILED'
            : 'NEEDS_REVIEW';
        return this.#repository.confirmVerification({
          operationId: persisted.operation.id,
          report,
          storage,
          event: {
            id: this.#idGenerator(),
            jobId,
            fromState: 'VERIFYING',
            toState: targetState,
            actorType: 'verifier',
            actorId: 'agentclear-deterministic-v1',
            reason: `Deterministic verification completed with ${report.outcome}.`,
            ...(storage.transactionHash === null ? {} : { transactionHash: storage.transactionHash }),
            evidenceReference: `0g://${storage.rootHash}`,
            occurredAt: this.#clock().toISOString(),
          },
        });
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new StorageOperationFailedError();
      }
    });
  }

  async #evaluate(
    job: Job,
    submission: Submission,
    operation: VerificationOperation,
  ): Promise<VerificationReport> {
    const evidence = await this.#storage.downloadVerified(submission.storageRootHash);
    if (sha256Bytes(evidence).toLowerCase() !== submission.submissionHash.toLowerCase()) {
      throw new EvidenceIntegrityFailedError();
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(evidence));
    } catch {
      throw new EvidenceIntegrityFailedError();
    }
    const parsed = submissionManifestSchema.safeParse(rawManifest);
    if (!parsed.success) throw new EvidenceIntegrityFailedError();
    const manifest = parsed.data;
    if (
      manifest.jobId !== job.id
      || manifest.submissionId !== submission.id
      || manifest.providerAgentId !== submission.providerAgentId
      || manifest.agreementHash.toLowerCase() !== job.agreementHash.toLowerCase()
    ) {
      throw new EvidenceIntegrityFailedError();
    }
    const evaluated = evaluateDeterministicChecks(
      job.agreement.verification.deterministicChecks ?? [],
      manifest.deliverable.result as JsonValue,
    );
    const outcome = determineVerificationOutcome(
      job.agreement.verification.mode,
      evaluated.scoreBps,
      job.minimumScoreBps,
      evaluated.hardFailure,
    );
    return {
      version: '1',
      runId: operation.runId,
      jobId: job.id,
      agreementHash: job.agreementHash,
      submissionId: submission.id,
      submissionHash: submission.submissionHash,
      submissionStorageRoot: submission.storageRootHash,
      mode: job.agreement.verification.mode,
      minimumScoreBps: job.minimumScoreBps,
      scoreBps: evaluated.scoreBps,
      outcome,
      checks: evaluated.checks,
      verifier: { kind: 'deterministic', version: 'agentclear-deterministic-v1' },
      startedAt: operation.startedAt,
      completedAt: this.#clock().toISOString(),
    };
  }
}
