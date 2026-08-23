CREATE TYPE "reputation_operation_status" AS ENUM ('CREATED', 'PREPARED', 'BROADCAST', 'CONFIRMED');

CREATE TABLE "reputation_operations" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "verification_run_id" uuid NOT NULL REFERENCES "verification_runs" ("id") ON DELETE RESTRICT,
  "provider_agent_id" text NOT NULL CHECK ("provider_agent_id" ~ '^erc8004:[0-9]+:[0-9]+$'),
  "outcome" "verification_outcome" NOT NULL CHECK ("outcome" IN ('PASS', 'FAIL')),
  "value" numeric(39, 0) NOT NULL,
  "value_decimals" smallint NOT NULL CHECK ("value_decimals" BETWEEN 0 AND 18),
  "tag1" varchar(100) NOT NULL,
  "tag2" varchar(100) NOT NULL,
  "feedback_uri" text NOT NULL,
  "feedback_hash" varchar(66) NOT NULL CHECK ("feedback_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "status" "reputation_operation_status" NOT NULL,
  "agent_token_id" numeric(78, 0) CHECK ("agent_token_id" IS NULL OR "agent_token_id" >= 0),
  "contract_address" varchar(42) CHECK (
    "contract_address" IS NULL OR "contract_address" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  "identity_registry_address" varchar(42) CHECK (
    "identity_registry_address" IS NULL OR "identity_registry_address" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  "signer_address" varchar(42) CHECK (
    "signer_address" IS NULL OR "signer_address" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  "serialized_transaction" text,
  "transaction_hash" varchar(66) CHECK (
    "transaction_hash" IS NULL OR "transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "block_number" numeric(78, 0) CHECK ("block_number" IS NULL OR "block_number" >= 0),
  "feedback_index" numeric(20, 0) CHECK ("feedback_index" IS NULL OR "feedback_index" > 0),
  "idempotency_scope" varchar(255) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(66) NOT NULL CHECK ("request_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "reputation_operations_job_unique" UNIQUE ("job_id"),
  CONSTRAINT "reputation_operations_idempotency_unique" UNIQUE ("idempotency_scope", "idempotency_key"),
  CONSTRAINT "reputation_operations_transaction_unique" UNIQUE ("transaction_hash")
);
CREATE INDEX "reputation_operations_status_updated_at_idx"
  ON "reputation_operations" ("status", "updated_at");

CREATE TABLE "reputation_events" (
  "job_id" uuid PRIMARY KEY REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "provider_agent_id" text NOT NULL CHECK ("provider_agent_id" ~ '^erc8004:[0-9]+:[0-9]+$'),
  "registry_address" varchar(42) NOT NULL CHECK ("registry_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "identity_registry_address" varchar(42) NOT NULL CHECK (
    "identity_registry_address" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  "agent_token_id" numeric(78, 0) NOT NULL CHECK ("agent_token_id" >= 0),
  "client_address" varchar(42) NOT NULL CHECK ("client_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "value" numeric(39, 0) NOT NULL,
  "value_decimals" smallint NOT NULL CHECK ("value_decimals" BETWEEN 0 AND 18),
  "tag1" varchar(100) NOT NULL,
  "tag2" varchar(100) NOT NULL,
  "feedback_uri" text NOT NULL,
  "feedback_hash" varchar(66) NOT NULL CHECK ("feedback_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "transaction_hash" varchar(66) NOT NULL UNIQUE CHECK ("transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "block_number" numeric(78, 0) NOT NULL CHECK ("block_number" >= 0),
  "feedback_index" numeric(20, 0) NOT NULL CHECK ("feedback_index" > 0),
  "created_at" timestamptz NOT NULL
);
