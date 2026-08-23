CREATE TYPE "settlement_operation_status" AS ENUM (
  'CREATED',
  'OUTCOME_PREPARED',
  'OUTCOME_BROADCAST',
  'OUTCOME_CONFIRMED',
  'ESCROW_PREPARED',
  'ESCROW_BROADCAST',
  'CONFIRMED'
);

CREATE TABLE "settlement_operations" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "submission_id" uuid NOT NULL REFERENCES "submissions" ("id") ON DELETE RESTRICT,
  "verification_run_id" uuid NOT NULL REFERENCES "verification_runs" ("id") ON DELETE RESTRICT,
  "outcome" "verification_outcome" NOT NULL CHECK ("outcome" IN ('PASS', 'FAIL')),
  "status" "settlement_operation_status" NOT NULL,
  "agreement_hash" varchar(66) NOT NULL CHECK ("agreement_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "submission_hash" varchar(66) NOT NULL CHECK ("submission_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "verification_report_hash" varchar(66) NOT NULL CHECK ("verification_report_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "buyer_agent_id" text NOT NULL CHECK ("buyer_agent_id" ~ '^erc8004:[0-9]+:[0-9]+$'),
  "provider_agent_id" text NOT NULL CHECK ("provider_agent_id" ~ '^erc8004:[0-9]+:[0-9]+$'),
  "job_key" varchar(66) CHECK ("job_key" IS NULL OR "job_key" ~ '^0x[0-9a-fA-F]{64}$'),
  "outcome_contract_address" varchar(42) CHECK (
    "outcome_contract_address" IS NULL OR "outcome_contract_address" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  "outcome_serialized_transaction" text,
  "outcome_transaction_hash" varchar(66) CHECK (
    "outcome_transaction_hash" IS NULL OR "outcome_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "outcome_block_number" numeric(78, 0) CHECK (
    "outcome_block_number" IS NULL OR "outcome_block_number" >= 0
  ),
  "escrow_contract_address" varchar(42) CHECK (
    "escrow_contract_address" IS NULL OR "escrow_contract_address" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  "escrow_serialized_transaction" text,
  "escrow_transaction_hash" varchar(66) CHECK (
    "escrow_transaction_hash" IS NULL OR "escrow_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "escrow_block_number" numeric(78, 0) CHECK (
    "escrow_block_number" IS NULL OR "escrow_block_number" >= 0
  ),
  "signer_address" varchar(42) CHECK (
    "signer_address" IS NULL OR "signer_address" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  "idempotency_scope" varchar(255) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(66) NOT NULL CHECK ("request_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "settlement_operations_idempotency_unique" UNIQUE ("idempotency_scope", "idempotency_key"),
  CONSTRAINT "settlement_operations_outcome_tx_unique" UNIQUE ("outcome_transaction_hash"),
  CONSTRAINT "settlement_operations_escrow_tx_unique" UNIQUE ("escrow_transaction_hash")
);
CREATE UNIQUE INDEX "settlement_operations_active_job_unique"
  ON "settlement_operations" ("job_id") WHERE "status" <> 'CONFIRMED';
CREATE INDEX "settlement_operations_status_updated_at_idx"
  ON "settlement_operations" ("status", "updated_at");

CREATE TABLE "settlements" (
  "job_id" uuid PRIMARY KEY REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "verification_run_id" uuid NOT NULL REFERENCES "verification_runs" ("id") ON DELETE RESTRICT,
  "amount_base_units" numeric(78, 0) NOT NULL CHECK ("amount_base_units" > 0),
  "outcome_transaction_hash" varchar(66) NOT NULL CHECK ("outcome_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "outcome_block_number" numeric(78, 0) NOT NULL CHECK ("outcome_block_number" >= 0),
  "escrow_transaction_hash" varchar(66) NOT NULL CHECK ("escrow_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "escrow_block_number" numeric(78, 0) NOT NULL CHECK ("escrow_block_number" >= 0),
  "finalized_at" timestamptz NOT NULL
);

CREATE TABLE "refunds" (
  "job_id" uuid PRIMARY KEY REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "verification_run_id" uuid NOT NULL REFERENCES "verification_runs" ("id") ON DELETE RESTRICT,
  "amount_base_units" numeric(78, 0) NOT NULL CHECK ("amount_base_units" > 0),
  "outcome_transaction_hash" varchar(66) NOT NULL CHECK ("outcome_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "outcome_block_number" numeric(78, 0) NOT NULL CHECK ("outcome_block_number" >= 0),
  "escrow_transaction_hash" varchar(66) NOT NULL CHECK ("escrow_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "escrow_block_number" numeric(78, 0) NOT NULL CHECK ("escrow_block_number" >= 0),
  "finalized_at" timestamptz NOT NULL
);
