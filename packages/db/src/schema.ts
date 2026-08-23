import type { JobAgreement, JobState } from '@agentclear/domain';
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
};
