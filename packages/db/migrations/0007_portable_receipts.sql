CREATE TYPE "receipt_operation_status" AS ENUM ('CREATED', 'STORING', 'CONFIRMED');

CREATE TABLE "receipt_operations" (
  "id" uuid PRIMARY KEY,
  "receipt_id" uuid NOT NULL,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "status" "receipt_operation_status" NOT NULL,
  "canonical_payload" text,
  "receipt_hash" varchar(66) NOT NULL CHECK ("receipt_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "storage_root_hash" varchar(66) CHECK (
    "storage_root_hash" IS NULL OR "storage_root_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "storage_transaction_hash" varchar(66) CHECK (
    "storage_transaction_hash" IS NULL
    OR "storage_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "storage_transaction_sequence" bigint CHECK (
    "storage_transaction_sequence" IS NULL OR "storage_transaction_sequence" >= 0
  ),
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0),
  "idempotency_scope" varchar(255) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(66) NOT NULL CHECK ("request_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "receipt_operations_receipt_unique" UNIQUE ("receipt_id"),
  CONSTRAINT "receipt_operations_job_unique" UNIQUE ("job_id"),
  CONSTRAINT "receipt_operations_hash_unique" UNIQUE ("receipt_hash"),
  CONSTRAINT "receipt_operations_idempotency_unique" UNIQUE ("idempotency_scope", "idempotency_key")
);
CREATE INDEX "receipt_operations_status_updated_at_idx"
  ON "receipt_operations" ("status", "updated_at");

CREATE TABLE "receipts" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "version" varchar(10) NOT NULL CHECK ("version" = '1'),
  "receipt_hash" varchar(66) NOT NULL CHECK ("receipt_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "receipt" jsonb NOT NULL,
  "canonical_payload" text NOT NULL,
  "storage_root_hash" varchar(66) NOT NULL CHECK (
    "storage_root_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "storage_transaction_hash" varchar(66) CHECK (
    "storage_transaction_hash" IS NULL
    OR "storage_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "storage_transaction_sequence" bigint NOT NULL CHECK ("storage_transaction_sequence" >= 0),
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0),
  "published_at" timestamptz NOT NULL,
  CONSTRAINT "receipts_job_unique" UNIQUE ("job_id"),
  CONSTRAINT "receipts_hash_unique" UNIQUE ("receipt_hash")
);
CREATE INDEX "receipts_storage_root_hash_idx" ON "receipts" ("storage_root_hash");
