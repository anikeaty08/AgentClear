CREATE TYPE "verification_operation_status" AS ENUM (
  'CREATED',
  'EVALUATED',
  'STORING',
  'CONFIRMED'
);
CREATE TYPE "verification_outcome" AS ENUM ('PASS', 'FAIL', 'NEEDS_REVIEW');

CREATE TABLE "verification_operations" (
  "id" uuid PRIMARY KEY,
  "run_id" uuid NOT NULL UNIQUE,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "submission_id" uuid NOT NULL REFERENCES "submissions" ("id") ON DELETE RESTRICT,
  "status" "verification_operation_status" NOT NULL,
  "started_at" timestamptz NOT NULL,
  "canonical_report" text,
  "report_hash" varchar(66) CHECK (
    "report_hash" IS NULL OR "report_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "outcome" "verification_outcome",
  "score_bps" smallint CHECK ("score_bps" IS NULL OR "score_bps" BETWEEN 0 AND 10000),
  "report_storage_root_hash" varchar(66) CHECK (
    "report_storage_root_hash" IS NULL OR "report_storage_root_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "report_storage_transaction_hash" varchar(66) CHECK (
    "report_storage_transaction_hash" IS NULL OR "report_storage_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "report_storage_transaction_sequence" bigint CHECK (
    "report_storage_transaction_sequence" IS NULL OR "report_storage_transaction_sequence" >= 0
  ),
  "report_size_bytes" integer CHECK ("report_size_bytes" IS NULL OR "report_size_bytes" > 0),
  "idempotency_scope" varchar(255) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(66) NOT NULL CHECK ("request_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "verification_operations_idempotency_unique" UNIQUE (
    "idempotency_scope",
    "idempotency_key"
  ),
  CONSTRAINT "verification_operations_evaluation_fields" CHECK (
    ("status" = 'CREATED' AND "canonical_report" IS NULL AND "report_hash" IS NULL AND "outcome" IS NULL AND "score_bps" IS NULL)
    OR
    ("status" IN ('EVALUATED', 'STORING') AND "canonical_report" IS NOT NULL AND "report_hash" IS NOT NULL AND "outcome" IS NOT NULL AND "score_bps" IS NOT NULL)
    OR
    ("status" = 'CONFIRMED' AND "canonical_report" IS NULL AND "report_hash" IS NOT NULL AND "outcome" IS NOT NULL AND "score_bps" IS NOT NULL)
  ),
  CONSTRAINT "verification_operations_confirmation_fields" CHECK (
    ("status" <> 'CONFIRMED' AND "report_storage_root_hash" IS NULL AND "report_storage_transaction_sequence" IS NULL AND "report_size_bytes" IS NULL)
    OR
    ("status" = 'CONFIRMED' AND "canonical_report" IS NULL AND "report_storage_root_hash" IS NOT NULL AND "report_storage_transaction_sequence" IS NOT NULL AND "report_size_bytes" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "verification_operations_active_job_unique"
  ON "verification_operations" ("job_id")
  WHERE "status" IN ('CREATED', 'EVALUATED', 'STORING');
CREATE INDEX "verification_operations_status_updated_at_idx"
  ON "verification_operations" ("status", "updated_at");

CREATE TABLE "verification_runs" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "submission_id" uuid NOT NULL REFERENCES "submissions" ("id") ON DELETE RESTRICT,
  "mode" varchar(40) NOT NULL CHECK (
    "mode" IN ('deterministic', 'rubric', 'ai', 'deterministic_plus_ai')
  ),
  "outcome" "verification_outcome" NOT NULL,
  "score_bps" smallint NOT NULL CHECK ("score_bps" BETWEEN 0 AND 10000),
  "minimum_score_bps" smallint NOT NULL CHECK ("minimum_score_bps" BETWEEN 0 AND 10000),
  "verifier_version" varchar(100) NOT NULL,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz NOT NULL CHECK ("completed_at" >= "started_at")
);
CREATE INDEX "verification_runs_job_completed_at_idx"
  ON "verification_runs" ("job_id", "completed_at");

CREATE TABLE "verification_checks" (
  "run_id" uuid NOT NULL REFERENCES "verification_runs" ("id") ON DELETE RESTRICT,
  "check_id" varchar(100) NOT NULL,
  "kind" varchar(40) NOT NULL CHECK (
    "kind" IN ('json_path_exists', 'json_path_equals', 'json_type')
  ),
  "description" text NOT NULL,
  "path" jsonb NOT NULL,
  "weight_bps" smallint NOT NULL CHECK ("weight_bps" BETWEEN 1 AND 10000),
  "hard_failure" boolean NOT NULL,
  "passed" boolean NOT NULL,
  "expected" jsonb,
  "actual" jsonb,
  "expected_present" boolean NOT NULL,
  "actual_present" boolean NOT NULL,
  "message" text NOT NULL,
  PRIMARY KEY ("run_id", "check_id")
);

CREATE TABLE "verification_reports" (
  "run_id" uuid PRIMARY KEY REFERENCES "verification_runs" ("id") ON DELETE RESTRICT,
  "report_hash" varchar(66) NOT NULL CHECK ("report_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "storage_root_hash" varchar(66) NOT NULL CHECK ("storage_root_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  "storage_transaction_hash" varchar(66) CHECK (
    "storage_transaction_hash" IS NULL OR "storage_transaction_hash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  "storage_transaction_sequence" bigint NOT NULL CHECK ("storage_transaction_sequence" >= 0),
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0),
  "created_at" timestamptz NOT NULL
);
