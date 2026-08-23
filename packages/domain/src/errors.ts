export type DomainErrorCode =
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_JOB_TRANSITION'
  | 'JOB_DEADLINE_NOT_FUTURE'
  | 'JOB_NOT_FOUND';

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

