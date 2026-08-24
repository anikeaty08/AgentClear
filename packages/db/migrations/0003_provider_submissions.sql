CREATE TYPE "submission_operation_status" AS ENUM ('CREATED', 'STORING', 'CONFIRMED');

CREATE TABLE "submission_operations" (
  "id" uuid PRIMARY KEY,
  "submission_id" uuid NOT NULL UNIQUE,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "status" "submission_operation_status" NOT NULL,
  "provider_agent_id" text NOT NULL CHECK ("provider_agent_id" ~ '^erc8004:[0-9]+:[0-9]+$'),
  "canonical_payload" text,
  "submission_hash" varchar(66) NOT NULL CHECK ("submission_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "storage_root_hash" varchar(66) CHECK (
    "storage_root_hash" IS NULL OR "storage_root_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "storage_transaction_hash" varchar(66) CHECK (
    "storage_transaction_hash" IS NULL OR "storage_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
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
  CONSTRAINT "submission_operations_idempotency_unique" UNIQUE (
    "idempotency_scope",
    "idempotency_key"
  )
);

CREATE UNIQUE INDEX "submission_operations_active_job_unique"
  ON "submission_operations" ("job_id")
  WHERE "status" IN ('CREATED', 'STORING');

CREATE INDEX "submission_operations_status_updated_at_idx"
  ON "submission_operations" ("status", "updated_at");

CREATE TABLE "submissions" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "provider_agent_id" text NOT NULL CHECK ("provider_agent_id" ~ '^erc8004:[0-9]+:[0-9]+$'),
  "submission_hash" varchar(66) NOT NULL CHECK ("submission_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "content_type" varchar(100) NOT NULL CHECK ("content_type" = 'application/json'),
  "storage_root_hash" varchar(66) NOT NULL CHECK ("storage_root_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "storage_transaction_hash" varchar(66) CHECK (
    "storage_transaction_hash" IS NULL OR "storage_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "storage_transaction_sequence" bigint NOT NULL CHECK ("storage_transaction_sequence" >= 0),
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0),
  "submitted_at" timestamptz NOT NULL
);

CREATE INDEX "submissions_job_submitted_at_idx" ON "submissions" ("job_id", "submitted_at");
CREATE INDEX "submissions_storage_root_hash_idx" ON "submissions" ("storage_root_hash");

CREATE TABLE "submission_artifacts" (
  "id" uuid PRIMARY KEY,
  "submission_id" uuid NOT NULL REFERENCES "submissions" ("id") ON DELETE RESTRICT,
  "kind" varchar(32) NOT NULL CHECK ("kind" = 'deliverable'),
  "content_hash" varchar(66) NOT NULL CHECK ("content_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "storage_root_hash" varchar(66) NOT NULL CHECK ("storage_root_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0),
  "created_at" timestamptz NOT NULL
);
