export type DomainErrorCode =
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_JOB_TRANSITION'
  | 'JOB_DEADLINE_NOT_FUTURE'
  | 'JOB_NOT_FOUND'
  | 'JOB_FUNDING_IN_PROGRESS'
  | 'CHAIN_OPERATION_FAILED'
  | 'CHAIN_SIGNER_BUSY'
  | 'SPENDING_POLICY_EXCEEDED'
  | 'JOB_ASSIGNMENT_IN_PROGRESS'
  | 'PROVIDER_MISMATCH'
  | 'PROVIDER_NOT_AUTHORIZED'
  | 'SUBMISSION_IN_PROGRESS'
  | 'SUBMISSION_TOO_LARGE'
  | 'STORAGE_OPERATION_FAILED'
  | 'VERIFICATION_IN_PROGRESS'
  | 'VERIFICATION_POLICY_UNSUPPORTED'
  | 'EVIDENCE_INTEGRITY_FAILED'
  | 'SETTLEMENT_IN_PROGRESS'
  | 'JOB_NOT_SETTLEABLE';

export class DomainError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidJobTransitionError extends DomainError {
  public constructor(from: string, to: string) {
    super('INVALID_JOB_TRANSITION', `A job cannot transition from ${from} to ${to}.`, 409);
  }
}

export class JobNotFoundError extends DomainError {
  public constructor(jobId: string) {
    super('JOB_NOT_FOUND', `Job ${jobId} was not found.`, 404);
  }
}

export class JobDeadlineNotFutureError extends DomainError {
  public constructor() {
    super('JOB_DEADLINE_NOT_FUTURE', 'The job deadline must be in the future.', 422);
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  public constructor() {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'The idempotency key was already used for a different request.',
      409,
    );
  }
}

export class JobFundingInProgressError extends DomainError {
  public constructor(jobId: string) {
    super(
      'JOB_FUNDING_IN_PROGRESS',
      `Job ${jobId} already has a funding operation in progress.`,
      409,
    );
  }
}

export class ChainOperationFailedError extends DomainError {
  public constructor() {
    super(
      'CHAIN_OPERATION_FAILED',
      'The chain operation did not complete. Retry with the same idempotency key.',
      502,
    );
  }
}

export class ChainSignerBusyError extends DomainError {
  public constructor() {
    super(
      'CHAIN_SIGNER_BUSY',
      'The chain signer is recovering another operation. Retry that operation first.',
      409,
    );
  }
}

export class SpendingPolicyExceededError extends DomainError {
  public constructor() {
    super(
      'SPENDING_POLICY_EXCEEDED',
      'The job budget exceeds the configured per-job spending limit.',
      403,
    );
  }
}

export class JobAssignmentInProgressError extends DomainError {
  public constructor(jobId: string) {
    super(
      'JOB_ASSIGNMENT_IN_PROGRESS',
      `Job ${jobId} already has a provider assignment in progress.`,
      409,
    );
  }
}

export class ProviderMismatchError extends DomainError {
  public constructor() {
    super(
      'PROVIDER_MISMATCH',
      'The provider does not match the job agreement or buyer/provider separation rules.',
      409,
    );
  }
}

export class ProviderNotAuthorizedError extends DomainError {
  public constructor() {
    super(
      'PROVIDER_NOT_AUTHORIZED',
      'Only the provider agent assigned to this job may submit its result.',
      403,
    );
  }
}

export class SubmissionInProgressError extends DomainError {
  public constructor(jobId: string) {
    super(
      'SUBMISSION_IN_PROGRESS',
      `Job ${jobId} already has a submission operation in progress.`,
      409,
    );
  }
}

export class SubmissionTooLargeError extends DomainError {
  public constructor() {
    super(
      'SUBMISSION_TOO_LARGE',
      'The canonical submission exceeds the configured payload limit.',
      413,
    );
  }
}

export class StorageOperationFailedError extends DomainError {
  public constructor() {
    super(
      'STORAGE_OPERATION_FAILED',
      'The evidence was not durably verified in 0G Storage. Retry with the same idempotency key.',
      502,
    );
  }
}

export class VerificationInProgressError extends DomainError {
  public constructor(jobId: string) {
    super(
      'VERIFICATION_IN_PROGRESS',
      `Job ${jobId} already has a verification operation in progress.`,
      409,
    );
  }
}

export class VerificationPolicyUnsupportedError extends DomainError {
  public constructor() {
    super(
      'VERIFICATION_POLICY_UNSUPPORTED',
      'This agreement does not contain an executable deterministic verification policy.',
      422,
    );
  }
}

export class EvidenceIntegrityFailedError extends DomainError {
  public constructor() {
    super(
      'EVIDENCE_INTEGRITY_FAILED',
      'Stored evidence did not match the committed submission metadata.',
      502,
    );
  }
}

export class SettlementInProgressError extends DomainError {
  public constructor(jobId: string) {
    super(
      'SETTLEMENT_IN_PROGRESS',
      `Job ${jobId} already has a settlement operation in progress.`,
      409,
    );
  }
}

export class JobNotSettleableError extends DomainError {
  public constructor() {
    super(
      'JOB_NOT_SETTLEABLE',
      'The job has no final PASS or FAIL that can be settled under its refund policy.',
      409,
    );
  }
}
