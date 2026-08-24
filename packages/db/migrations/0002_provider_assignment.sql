CREATE TABLE "job_assignments" (
  "job_id" uuid PRIMARY KEY REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "provider_agent_id" text NOT NULL CHECK ("provider_agent_id" ~ '^erc8004:[0-9]+:[0-9]+$'),
  "provider_address" varchar(42) NOT NULL CHECK ("provider_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "transaction_hash" varchar(66) NOT NULL UNIQUE CHECK ("transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "block_number" numeric(78, 0) NOT NULL CHECK ("block_number" >= 0),
  "assigned_at" timestamptz NOT NULL
);

CREATE TABLE "job_assignment_operations" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "status" "funding_operation_status" NOT NULL,
  "chain_id" integer NOT NULL CHECK ("chain_id" > 0),
  "contract_address" varchar(42) NOT NULL CHECK ("contract_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "signer_address" varchar(42) NOT NULL CHECK ("signer_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "provider_agent_id" text NOT NULL CHECK ("provider_agent_id" ~ '^erc8004:[0-9]+:[0-9]+$'),
  "provider_address" varchar(42) NOT NULL CHECK ("provider_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "job_key" varchar(66) CHECK ("job_key" IS NULL OR "job_key" ~ '^0x[0-9a-fA-F]{64}$'),
  "serialized_transaction" text CHECK (
    "serialized_transaction" IS NULL OR "serialized_transaction" ~ '^0x[0-9a-fA-F]+$'
  ),
  "transaction_hash" varchar(66) CHECK (
    "transaction_hash" IS NULL OR "transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "block_number" numeric(78, 0),
  "idempotency_scope" varchar(255) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(66) NOT NULL CHECK ("request_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "job_assignment_operations_idempotency_unique" UNIQUE (
    "idempotency_scope",
    "idempotency_key"
  ),
  CONSTRAINT "job_assignment_operations_transaction_hash_unique" UNIQUE ("transaction_hash")
);

CREATE UNIQUE INDEX "job_assignment_operations_active_job_unique"
  ON "job_assignment_operations" ("job_id")
  WHERE "status" IN ('CREATED', 'PREPARED', 'BROADCAST');

CREATE INDEX "job_assignment_operations_status_updated_at_idx"
  ON "job_assignment_operations" ("status", "updated_at");
