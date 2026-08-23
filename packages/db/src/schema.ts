import type {
  JobAgreement,
  JobState,
  JsonValue,
  PortableReceipt,
  VerificationCheckResult,
  VerificationOutcome,
} from '@agentclear/domain';
import { JOB_STATES } from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const jobStateEnum = pgEnum('job_state', JOB_STATES);
export const jobActorTypeEnum = pgEnum('job_actor_type', [
  'agent',
  'operator',
  'service',
  'verifier',
  'resolver',
]);
export const escrowStatusEnum = pgEnum('escrow_status', [
  'PENDING',
  'FUNDED',
  'DISPUTED',
  'RELEASED',
  'REFUNDED',
  'FAILED',
]);
export const fundingOperationStatusEnum = pgEnum('funding_operation_status', [
  'CREATED',
  'PREPARED',
  'BROADCAST',
  'CONFIRMED',
]);
export const submissionOperationStatusEnum = pgEnum('submission_operation_status', [
  'CREATED',
  'STORING',
  'CONFIRMED',
]);
export const verificationOperationStatusEnum = pgEnum('verification_operation_status', [
  'CREATED',
  'EVALUATED',
  'STORING',
  'CONFIRMED',
]);
export const verificationOutcomeEnum = pgEnum('verification_outcome', [
  'PASS',
  'FAIL',
  'NEEDS_REVIEW',
]);
export const settlementOperationStatusEnum = pgEnum('settlement_operation_status', [
  'CREATED',
  'OUTCOME_PREPARED',
  'OUTCOME_BROADCAST',
  'OUTCOME_CONFIRMED',
  'ESCROW_PREPARED',
  'ESCROW_BROADCAST',
  'CONFIRMED',
]);
export const reputationOperationStatusEnum = pgEnum('reputation_operation_status', [
  'CREATED',
  'PREPARED',
  'BROADCAST',
  'CONFIRMED',
]);
export const receiptOperationStatusEnum = pgEnum('receipt_operation_status', [
  'CREATED',
  'STORING',
  'CONFIRMED',
]);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    buyerAgentId: text('buyer_agent_id').notNull(),
    providerAgentId: text('provider_agent_id'),
    title: varchar('title', { length: 160 }).notNull(),
    description: text('description').notNull(),
    budgetToken: text('budget_token').notNull(),
    budgetMaxAmount: text('budget_max_amount').notNull(),
    budgetAmountBaseUnits: numeric('budget_amount_base_units', { precision: 78, scale: 0 }).notNull(),
    deadline: timestamp('deadline', { withTimezone: true, mode: 'date' }).notNull(),
    deliverableType: varchar('deliverable_type', { length: 32 }).notNull(),
    deliverableFormat: varchar('deliverable_format', { length: 100 }).notNull(),
    verificationMode: varchar('verification_mode', { length: 40 }).notNull(),
    minimumScoreBps: smallint('minimum_score_bps').notNull(),
    refundOnExpiry: boolean('refund_on_expiry').notNull(),
    refundOnFinalFailure: boolean('refund_on_final_failure').notNull(),
    state: jobStateEnum('state').$type<JobState>().notNull(),
    agreementSnapshot: jsonb('agreement_snapshot').$type<JobAgreement>().notNull(),
    agreementHash: varchar('agreement_hash', { length: 66 }).notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('jobs_state_created_at_idx').on(table.state, table.createdAt),
    index('jobs_buyer_agent_created_at_idx').on(table.buyerAgentId, table.createdAt),
    index('jobs_provider_agent_state_idx').on(table.providerAgentId, table.state),
    unique('jobs_agreement_hash_unique').on(table.agreementHash),
  ],
);

export const jobRequirements = pgTable(
  'job_requirements',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    ordinal: smallint('ordinal').notNull(),
    requirement: text('requirement').notNull(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.ordinal] })],
);

export const jobStateEvents = pgTable(
  'job_state_events',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    fromState: jobStateEnum('from_state').$type<JobState>(),
    toState: jobStateEnum('to_state').$type<JobState>().notNull(),
    actorType: jobActorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    reason: text('reason').notNull(),
    transactionHash: varchar('transaction_hash', { length: 66 }),
    evidenceReference: text('evidence_reference'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('job_state_events_job_occurred_at_idx').on(table.jobId, table.occurredAt)],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    scope: varchar('scope', { length: 255 }).notNull(),
    key: varchar('key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 66 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key] }),
    index('idempotency_records_expires_at_idx').on(table.expiresAt),
  ],
);

export const escrows = pgTable(
  'escrows',
  {
    jobId: uuid('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    jobKey: varchar('job_key', { length: 66 }),
    buyerAddress: varchar('buyer_address', { length: 42 }).notNull(),
    providerAddress: varchar('provider_address', { length: 42 }),
    amountBaseUnits: numeric('amount_base_units', { precision: 78, scale: 0 }).notNull(),
    deadline: timestamp('deadline', { withTimezone: true, mode: 'date' }).notNull(),
    agreementHash: varchar('agreement_hash', { length: 66 }).notNull(),
    status: escrowStatusEnum('status').notNull(),
    fundingTransactionHash: varchar('funding_transaction_hash', { length: 66 }),
    fundingBlockNumber: numeric('funding_block_number', { precision: 78, scale: 0 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('escrows_job_key_unique').on(table.jobKey),
    unique('escrows_funding_transaction_hash_unique').on(table.fundingTransactionHash),
    index('escrows_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const escrowFundingOperations = pgTable(
  'escrow_funding_operations',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    status: fundingOperationStatusEnum('status').notNull(),
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    signerAddress: varchar('signer_address', { length: 42 }).notNull(),
    providerAddress: varchar('provider_address', { length: 42 }),
    amountBaseUnits: numeric('amount_base_units', { precision: 78, scale: 0 }).notNull(),
    deadline: timestamp('deadline', { withTimezone: true, mode: 'date' }).notNull(),
    agreementHash: varchar('agreement_hash', { length: 66 }).notNull(),
    jobKey: varchar('job_key', { length: 66 }),
    serializedTransaction: text('serialized_transaction'),
    transactionHash: varchar('transaction_hash', { length: 66 }),
    blockNumber: numeric('block_number', { precision: 78, scale: 0 }),
    idempotencyScope: varchar('idempotency_scope', { length: 255 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 66 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('escrow_funding_operations_idempotency_unique').on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    unique('escrow_funding_operations_transaction_hash_unique').on(table.transactionHash),
    uniqueIndex('escrow_funding_operations_active_job_unique')
      .on(table.jobId)
      .where(sql`${table.status} in ('CREATED', 'PREPARED', 'BROADCAST')`),
    index('escrow_funding_operations_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const jobAssignments = pgTable('job_assignments', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'restrict' }),
  providerAgentId: text('provider_agent_id').notNull(),
  providerAddress: varchar('provider_address', { length: 42 }).notNull(),
  transactionHash: varchar('transaction_hash', { length: 66 }).notNull().unique(),
  blockNumber: numeric('block_number', { precision: 78, scale: 0 }).notNull(),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const jobAssignmentOperations = pgTable(
  'job_assignment_operations',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    status: fundingOperationStatusEnum('status').notNull(),
    chainId: integer('chain_id').notNull(),
    contractAddress: varchar('contract_address', { length: 42 }).notNull(),
    signerAddress: varchar('signer_address', { length: 42 }).notNull(),
    providerAgentId: text('provider_agent_id').notNull(),
    providerAddress: varchar('provider_address', { length: 42 }).notNull(),
    jobKey: varchar('job_key', { length: 66 }),
    serializedTransaction: text('serialized_transaction'),
    transactionHash: varchar('transaction_hash', { length: 66 }),
    blockNumber: numeric('block_number', { precision: 78, scale: 0 }),
    idempotencyScope: varchar('idempotency_scope', { length: 255 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 66 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('job_assignment_operations_idempotency_unique').on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    unique('job_assignment_operations_transaction_hash_unique').on(table.transactionHash),
    uniqueIndex('job_assignment_operations_active_job_unique')
      .on(table.jobId)
      .where(sql`${table.status} in ('CREATED', 'PREPARED', 'BROADCAST')`),
    index('job_assignment_operations_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const submissionOperations = pgTable(
  'submission_operations',
  {
    id: uuid('id').primaryKey(),
    submissionId: uuid('submission_id').notNull().unique(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    status: submissionOperationStatusEnum('status').notNull(),
    providerAgentId: text('provider_agent_id').notNull(),
    canonicalPayload: text('canonical_payload'),
    submissionHash: varchar('submission_hash', { length: 66 }).notNull(),
    storageRootHash: varchar('storage_root_hash', { length: 66 }),
    storageTransactionHash: varchar('storage_transaction_hash', { length: 66 }),
    storageTransactionSequence: bigint('storage_transaction_sequence', { mode: 'number' }),
    sizeBytes: integer('size_bytes').notNull(),
    idempotencyScope: varchar('idempotency_scope', { length: 255 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 66 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('submission_operations_idempotency_unique').on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    uniqueIndex('submission_operations_active_job_unique')
      .on(table.jobId)
      .where(sql`${table.status} in ('CREATED', 'STORING')`),
    index('submission_operations_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    providerAgentId: text('provider_agent_id').notNull(),
    submissionHash: varchar('submission_hash', { length: 66 }).notNull(),
    contentType: varchar('content_type', { length: 100 }).notNull(),
    storageRootHash: varchar('storage_root_hash', { length: 66 }).notNull(),
    storageTransactionHash: varchar('storage_transaction_hash', { length: 66 }),
    storageTransactionSequence: bigint('storage_transaction_sequence', {
      mode: 'number',
    }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('submissions_job_submitted_at_idx').on(table.jobId, table.submittedAt),
    index('submissions_storage_root_hash_idx').on(table.storageRootHash),
  ],
);

export const submissionArtifacts = pgTable('submission_artifacts', {
  id: uuid('id').primaryKey(),
  submissionId: uuid('submission_id')
    .notNull()
    .references(() => submissions.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 32 }).notNull(),
  contentHash: varchar('content_hash', { length: 66 }).notNull(),
  storageRootHash: varchar('storage_root_hash', { length: 66 }).notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const verificationOperations = pgTable(
  'verification_operations',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull().unique(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'restrict' }),
    status: verificationOperationStatusEnum('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    canonicalReport: text('canonical_report'),
    reportHash: varchar('report_hash', { length: 66 }),
    outcome: verificationOutcomeEnum('outcome').$type<VerificationOutcome>(),
    scoreBps: smallint('score_bps'),
    reportStorageRootHash: varchar('report_storage_root_hash', { length: 66 }),
    reportStorageTransactionHash: varchar('report_storage_transaction_hash', { length: 66 }),
    reportStorageTransactionSequence: bigint('report_storage_transaction_sequence', {
      mode: 'number',
    }),
    reportSizeBytes: integer('report_size_bytes'),
    idempotencyScope: varchar('idempotency_scope', { length: 255 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 66 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('verification_operations_idempotency_unique').on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    uniqueIndex('verification_operations_active_job_unique')
      .on(table.jobId)
      .where(sql`${table.status} in ('CREATED', 'EVALUATED', 'STORING')`),
    index('verification_operations_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const verificationRuns = pgTable(
  'verification_runs',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'restrict' }),
    mode: varchar('mode', { length: 40 }).notNull(),
    outcome: verificationOutcomeEnum('outcome').$type<VerificationOutcome>().notNull(),
    scoreBps: smallint('score_bps').notNull(),
    minimumScoreBps: smallint('minimum_score_bps').notNull(),
    verifierVersion: varchar('verifier_version', { length: 100 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('verification_runs_job_completed_at_idx').on(table.jobId, table.completedAt)],
);

export const verificationChecks = pgTable(
  'verification_checks',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => verificationRuns.id, { onDelete: 'restrict' }),
    checkId: varchar('check_id', { length: 100 }).notNull(),
    kind: varchar('kind', { length: 40 }).$type<VerificationCheckResult['kind']>().notNull(),
    description: text('description').notNull(),
    path: jsonb('path').$type<readonly (number | string)[]>().notNull(),
    weightBps: smallint('weight_bps').notNull(),
    hardFailure: boolean('hard_failure').notNull(),
    passed: boolean('passed').notNull(),
    expected: jsonb('expected').$type<JsonValue>(),
    actual: jsonb('actual').$type<JsonValue>(),
    expectedPresent: boolean('expected_present').notNull(),
    actualPresent: boolean('actual_present').notNull(),
    message: text('message').notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.checkId] })],
);

export const verificationReports = pgTable('verification_reports', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => verificationRuns.id, { onDelete: 'restrict' }),
  reportHash: varchar('report_hash', { length: 66 }).notNull(),
  storageRootHash: varchar('storage_root_hash', { length: 66 }).notNull(),
  storageTransactionHash: varchar('storage_transaction_hash', { length: 66 }),
  storageTransactionSequence: bigint('storage_transaction_sequence', { mode: 'number' }).notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const settlementOperations = pgTable(
  'settlement_operations',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'restrict' }),
    verificationRunId: uuid('verification_run_id')
      .notNull()
      .references(() => verificationRuns.id, { onDelete: 'restrict' }),
    outcome: verificationOutcomeEnum('outcome').$type<VerificationOutcome>().notNull(),
    status: settlementOperationStatusEnum('status').notNull(),
    agreementHash: varchar('agreement_hash', { length: 66 }).notNull(),
    submissionHash: varchar('submission_hash', { length: 66 }).notNull(),
    verificationReportHash: varchar('verification_report_hash', { length: 66 }).notNull(),
    buyerAgentId: text('buyer_agent_id').notNull(),
    providerAgentId: text('provider_agent_id').notNull(),
    jobKey: varchar('job_key', { length: 66 }),
    outcomeContractAddress: varchar('outcome_contract_address', { length: 42 }),
    outcomeSerializedTransaction: text('outcome_serialized_transaction'),
    outcomeTransactionHash: varchar('outcome_transaction_hash', { length: 66 }),
    outcomeBlockNumber: numeric('outcome_block_number', { precision: 78, scale: 0 }),
    escrowContractAddress: varchar('escrow_contract_address', { length: 42 }),
    escrowSerializedTransaction: text('escrow_serialized_transaction'),
    escrowTransactionHash: varchar('escrow_transaction_hash', { length: 66 }),
    escrowBlockNumber: numeric('escrow_block_number', { precision: 78, scale: 0 }),
    signerAddress: varchar('signer_address', { length: 42 }),
    idempotencyScope: varchar('idempotency_scope', { length: 255 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 66 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('settlement_operations_idempotency_unique').on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    unique('settlement_operations_outcome_tx_unique').on(table.outcomeTransactionHash),
    unique('settlement_operations_escrow_tx_unique').on(table.escrowTransactionHash),
    uniqueIndex('settlement_operations_active_job_unique')
      .on(table.jobId)
      .where(sql`${table.status} <> 'CONFIRMED'`),
    index('settlement_operations_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const settlements = pgTable('settlements', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'restrict' }),
  verificationRunId: uuid('verification_run_id')
    .notNull()
    .references(() => verificationRuns.id, { onDelete: 'restrict' }),
  amountBaseUnits: numeric('amount_base_units', { precision: 78, scale: 0 }).notNull(),
  outcomeTransactionHash: varchar('outcome_transaction_hash', { length: 66 }).notNull(),
  outcomeBlockNumber: numeric('outcome_block_number', { precision: 78, scale: 0 }).notNull(),
  escrowTransactionHash: varchar('escrow_transaction_hash', { length: 66 }).notNull(),
  escrowBlockNumber: numeric('escrow_block_number', { precision: 78, scale: 0 }).notNull(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const refunds = pgTable('refunds', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'restrict' }),
  verificationRunId: uuid('verification_run_id')
    .notNull()
    .references(() => verificationRuns.id, { onDelete: 'restrict' }),
  amountBaseUnits: numeric('amount_base_units', { precision: 78, scale: 0 }).notNull(),
  outcomeTransactionHash: varchar('outcome_transaction_hash', { length: 66 }).notNull(),
  outcomeBlockNumber: numeric('outcome_block_number', { precision: 78, scale: 0 }).notNull(),
  escrowTransactionHash: varchar('escrow_transaction_hash', { length: 66 }).notNull(),
  escrowBlockNumber: numeric('escrow_block_number', { precision: 78, scale: 0 }).notNull(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const reputationOperations = pgTable(
  'reputation_operations',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    verificationRunId: uuid('verification_run_id')
      .notNull()
      .references(() => verificationRuns.id, { onDelete: 'restrict' }),
    providerAgentId: text('provider_agent_id').notNull(),
    outcome: verificationOutcomeEnum('outcome').$type<VerificationOutcome>().notNull(),
    value: numeric('value', { precision: 39, scale: 0 }).notNull(),
    valueDecimals: smallint('value_decimals').notNull(),
    tag1: varchar('tag1', { length: 100 }).notNull(),
    tag2: varchar('tag2', { length: 100 }).notNull(),
    feedbackUri: text('feedback_uri').notNull(),
    feedbackHash: varchar('feedback_hash', { length: 66 }).notNull(),
    status: reputationOperationStatusEnum('status').notNull(),
    agentTokenId: numeric('agent_token_id', { precision: 78, scale: 0 }),
    contractAddress: varchar('contract_address', { length: 42 }),
    identityRegistryAddress: varchar('identity_registry_address', { length: 42 }),
    signerAddress: varchar('signer_address', { length: 42 }),
    serializedTransaction: text('serialized_transaction'),
    transactionHash: varchar('transaction_hash', { length: 66 }),
    blockNumber: numeric('block_number', { precision: 78, scale: 0 }),
    feedbackIndex: numeric('feedback_index', { precision: 20, scale: 0 }),
    idempotencyScope: varchar('idempotency_scope', { length: 255 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 66 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('reputation_operations_job_unique').on(table.jobId),
    unique('reputation_operations_idempotency_unique').on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    unique('reputation_operations_transaction_unique').on(table.transactionHash),
    index('reputation_operations_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const reputationEvents = pgTable('reputation_events', {
  jobId: uuid('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'restrict' }),
  providerAgentId: text('provider_agent_id').notNull(),
  registryAddress: varchar('registry_address', { length: 42 }).notNull(),
  identityRegistryAddress: varchar('identity_registry_address', { length: 42 }).notNull(),
  agentTokenId: numeric('agent_token_id', { precision: 78, scale: 0 }).notNull(),
  clientAddress: varchar('client_address', { length: 42 }).notNull(),
  value: numeric('value', { precision: 39, scale: 0 }).notNull(),
  valueDecimals: smallint('value_decimals').notNull(),
  tag1: varchar('tag1', { length: 100 }).notNull(),
  tag2: varchar('tag2', { length: 100 }).notNull(),
  feedbackUri: text('feedback_uri').notNull(),
  feedbackHash: varchar('feedback_hash', { length: 66 }).notNull(),
  transactionHash: varchar('transaction_hash', { length: 66 }).notNull().unique(),
  blockNumber: numeric('block_number', { precision: 78, scale: 0 }).notNull(),
  feedbackIndex: numeric('feedback_index', { precision: 20, scale: 0 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const receiptOperations = pgTable(
  'receipt_operations',
  {
    id: uuid('id').primaryKey(),
    receiptId: uuid('receipt_id').notNull(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    status: receiptOperationStatusEnum('status').notNull(),
    canonicalPayload: text('canonical_payload'),
    receiptHash: varchar('receipt_hash', { length: 66 }).notNull(),
    storageRootHash: varchar('storage_root_hash', { length: 66 }),
    storageTransactionHash: varchar('storage_transaction_hash', { length: 66 }),
    storageTransactionSequence: bigint('storage_transaction_sequence', { mode: 'number' }),
    sizeBytes: integer('size_bytes').notNull(),
    idempotencyScope: varchar('idempotency_scope', { length: 255 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 66 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('receipt_operations_receipt_unique').on(table.receiptId),
    unique('receipt_operations_job_unique').on(table.jobId),
    unique('receipt_operations_hash_unique').on(table.receiptHash),
    unique('receipt_operations_idempotency_unique').on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    index('receipt_operations_status_updated_at_idx').on(table.status, table.updatedAt),
  ],
);

export const receipts = pgTable(
  'receipts',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    version: varchar('version', { length: 10 }).notNull(),
    receiptHash: varchar('receipt_hash', { length: 66 }).notNull(),
    receipt: jsonb('receipt').$type<PortableReceipt>().notNull(),
    canonicalPayload: text('canonical_payload').notNull(),
    storageRootHash: varchar('storage_root_hash', { length: 66 }).notNull(),
    storageTransactionHash: varchar('storage_transaction_hash', { length: 66 }),
    storageTransactionSequence: bigint('storage_transaction_sequence', { mode: 'number' }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    unique('receipts_job_unique').on(table.jobId),
    unique('receipts_hash_unique').on(table.receiptHash),
    index('receipts_storage_root_hash_idx').on(table.storageRootHash),
  ],
);

export const databaseSchema = {
  jobs,
  jobRequirements,
  jobStateEvents,
  idempotencyRecords,
  escrows,
  escrowFundingOperations,
  jobAssignments,
  jobAssignmentOperations,
  submissionOperations,
  submissions,
  submissionArtifacts,
  verificationOperations,
  verificationRuns,
  verificationChecks,
  verificationReports,
  settlementOperations,
  settlements,
  refunds,
  reputationOperations,
  reputationEvents,
  receiptOperations,
  receipts,
};
