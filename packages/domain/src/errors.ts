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
  | 'PROVIDER_MISMATCH';

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
