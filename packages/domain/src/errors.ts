export type DomainErrorCode =
  | 'API_KEY_NOT_FOUND'
  | 'API_KEY_PERMISSION_DENIED'
  | 'API_KEY_SCOPE_ESCALATION'
  | 'API_KEY_EXPIRY_INVALID'
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
  | 'COMPUTE_UNAVAILABLE'
  | 'COMPUTE_OPERATION_FAILED'
  | 'COMPUTE_RECONCILIATION_REQUIRED'
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_EXECUTION_FAILED'
  | 'EVIDENCE_INTEGRITY_FAILED'
  | 'SETTLEMENT_IN_PROGRESS'
  | 'JOB_NOT_SETTLEABLE'
  | 'REPUTATION_IN_PROGRESS'
  | 'JOB_NOT_REPUTABLE'
  | 'RECEIPT_IN_PROGRESS'
  | 'JOB_NOT_RECEIPTABLE'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_TOO_LARGE'
  | 'RECEIPT_INTEGRITY_FAILED';

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

export class ApiKeyNotFoundError extends DomainError {
  public constructor(id: string) {
    super('API_KEY_NOT_FOUND', `API key ${id} was not found.`, 404);
  }
}

export class ApiKeyPermissionDeniedError extends DomainError {
  public constructor() {
    super(
      'API_KEY_PERMISSION_DENIED',
      'The caller cannot manage API keys for the requested principal.',
      403,
    );
  }
}

export class ApiKeyScopeEscalationError extends DomainError {
  public constructor() {
    super(
      'API_KEY_SCOPE_ESCALATION',
      'A delegated API key cannot receive scopes the caller does not hold.',
      403,
    );
  }
}

export class ApiKeyExpiryInvalidError extends DomainError {
  public constructor() {
    super('API_KEY_EXPIRY_INVALID', 'The API key expiry must be in the future.', 422);
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
      'This agreement does not contain the executable verification policy required by its mode.',
      422,
    );
  }
}

export class ComputeUnavailableError extends DomainError {
  public constructor() {
    super(
      'COMPUTE_UNAVAILABLE',
      'This verification policy requires configured 0G Compute access.',
      503,
    );
  }
}

export class ComputeOperationFailedError extends DomainError {
  public constructor() {
    super(
      'COMPUTE_OPERATION_FAILED',
      'The 0G Compute verification request failed before a durable report was recorded.',
      502,
    );
  }
}

export class ComputeReconciliationRequiredError extends DomainError {
  public constructor(runId: string) {
    super(
      'COMPUTE_RECONCILIATION_REQUIRED',
      `Verification run ${runId} may have incurred a paid 0G Compute request and requires operator reconciliation before retry.`,
      409,
    );
  }
}

export class SandboxUnavailableError extends DomainError {
  public constructor() {
    super(
      'SANDBOX_UNAVAILABLE',
      'This verification policy requires a configured isolated code sandbox.',
      503,
    );
  }
}

export class SandboxExecutionFailedError extends DomainError {
  public constructor() {
    super(
      'SANDBOX_EXECUTION_FAILED',
      'The isolated code sandbox could not complete the verification run safely.',
      502,
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

export class ReputationInProgressError extends DomainError {
  public constructor(jobId: string) {
    super(
      'REPUTATION_IN_PROGRESS',
      `Job ${jobId} already has an unfinished reputation operation.`,
      409,
    );
  }
}

export class JobNotReputableError extends DomainError {
  public constructor() {
    super(
      'JOB_NOT_REPUTABLE',
      'The job does not have a matching finalized payment or refund outcome.',
      409,
    );
  }
}

export class ReceiptInProgressError extends DomainError {
  public constructor(jobId: string) {
    super(
      'RECEIPT_IN_PROGRESS',
      `Job ${jobId} already has an unfinished receipt operation.`,
      409,
    );
  }
}

export class JobNotReceiptableError extends DomainError {
  public constructor() {
    super(
      'JOB_NOT_RECEIPTABLE',
      'The job does not have matching finalized settlement, evidence, and reputation records.',
      409,
    );
  }
}

export class ReceiptNotFoundError extends DomainError {
  public constructor(id: string) {
    super('RECEIPT_NOT_FOUND', `Receipt ${id} was not found.`, 404);
  }
}

export class ReceiptTooLargeError extends DomainError {
  public constructor() {
    super('RECEIPT_TOO_LARGE', 'The canonical receipt exceeds the configured payload limit.', 413);
  }
}

export class ReceiptIntegrityFailedError extends DomainError {
  public constructor() {
    super(
      'RECEIPT_INTEGRITY_FAILED',
      'The portable receipt does not match its persisted cryptographic commitment.',
      502,
    );
  }
}
