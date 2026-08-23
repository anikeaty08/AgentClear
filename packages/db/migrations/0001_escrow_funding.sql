CREATE TYPE "escrow_status" AS ENUM (
  'PENDING',
  'FUNDED',
  'DISPUTED',
  'RELEASED',
  'REFUNDED',
  'FAILED'
);

CREATE TYPE "funding_operation_status" AS ENUM (
  'CREATED',
  'PREPARED',
  'BROADCAST',
  'CONFIRMED'
);

CREATE TABLE "escrows" (
  "job_id" uuid PRIMARY KEY REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "chain_id" integer NOT NULL CHECK ("chain_id" > 0),
  "contract_address" varchar(42) NOT NULL CHECK ("contract_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "job_key" varchar(66) CHECK ("job_key" IS NULL OR "job_key" ~ '^0x[0-9a-fA-F]{64}$'),
  "buyer_address" varchar(42) NOT NULL CHECK ("buyer_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "provider_address" varchar(42) CHECK ("provider_address" IS NULL OR "provider_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "amount_base_units" numeric(78, 0) NOT NULL CHECK ("amount_base_units" > 0),
  "deadline" timestamptz NOT NULL,
  "agreement_hash" varchar(66) NOT NULL CHECK ("agreement_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "status" "escrow_status" NOT NULL,
  "funding_transaction_hash" varchar(66) CHECK (
    "funding_transaction_hash" IS NULL OR "funding_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "funding_block_number" numeric(78, 0),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "escrows_job_key_unique" UNIQUE ("job_key"),
  CONSTRAINT "escrows_funding_transaction_hash_unique" UNIQUE ("funding_transaction_hash")
);

CREATE INDEX "escrows_status_updated_at_idx" ON "escrows" ("status", "updated_at");

CREATE TABLE "escrow_funding_operations" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "status" "funding_operation_status" NOT NULL,
  "chain_id" integer NOT NULL CHECK ("chain_id" > 0),
  "contract_address" varchar(42) NOT NULL CHECK ("contract_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "signer_address" varchar(42) NOT NULL CHECK ("signer_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "provider_address" varchar(42) CHECK ("provider_address" IS NULL OR "provider_address" ~ '^0x[0-9a-fA-F]{40}$'),
  "amount_base_units" numeric(78, 0) NOT NULL CHECK ("amount_base_units" > 0),
  "deadline" timestamptz NOT NULL,
  "agreement_hash" varchar(66) NOT NULL CHECK ("agreement_hash" ~ '^0x[0-9a-fA-F]{64}$'),
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
  CONSTRAINT "escrow_funding_operations_idempotency_unique" UNIQUE (
    "idempotency_scope",
    "idempotency_key"
  ),
  CONSTRAINT "escrow_funding_operations_transaction_hash_unique" UNIQUE ("transaction_hash")
);

CREATE UNIQUE INDEX "escrow_funding_operations_active_job_unique"
  ON "escrow_funding_operations" ("job_id")
  WHERE "status" IN ('CREATED', 'PREPARED', 'BROADCAST');

CREATE INDEX "escrow_funding_operations_status_updated_at_idx"
  ON "escrow_funding_operations" ("status", "updated_at");
