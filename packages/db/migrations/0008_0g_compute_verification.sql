DROP INDEX "verification_operations_active_job_unique";
ALTER TABLE "verification_operations"
  DROP CONSTRAINT "verification_operations_evaluation_fields";
ALTER TABLE "verification_operations"
  DROP CONSTRAINT "verification_operations_confirmation_fields";

CREATE TYPE "verification_operation_status_v2" AS ENUM (
  'CREATED',
  'COMPUTING',
  'EVALUATED',
  'STORING',
  'CONFIRMED'
);
ALTER TABLE "verification_operations"
  ALTER COLUMN "status" TYPE "verification_operation_status_v2"
  USING "status"::text::"verification_operation_status_v2";
DROP TYPE "verification_operation_status";
ALTER TYPE "verification_operation_status_v2" RENAME TO "verification_operation_status";

ALTER TABLE "verification_operations"
  ADD COLUMN "compute_prompt_hash" varchar(66) CHECK (
    "compute_prompt_hash" IS NULL OR "compute_prompt_hash" ~ '^0x[0-9a-fA-F]{64}$'
  );

ALTER TABLE "verification_runs"
  ADD COLUMN "ai_result" jsonb;

ALTER TABLE "verification_operations"
  ADD CONSTRAINT "verification_operations_evaluation_fields" CHECK (
    (
      "status" = 'CREATED'
      AND "compute_prompt_hash" IS NULL
      AND "canonical_report" IS NULL
      AND "report_hash" IS NULL
      AND "outcome" IS NULL
      AND "score_bps" IS NULL
    )
    OR
    (
      "status" = 'COMPUTING'
      AND "compute_prompt_hash" IS NOT NULL
      AND "canonical_report" IS NULL
      AND "report_hash" IS NULL
      AND "outcome" IS NULL
      AND "score_bps" IS NULL
    )
    OR
    (
      "status" IN ('EVALUATED', 'STORING')
      AND "canonical_report" IS NOT NULL
      AND "report_hash" IS NOT NULL
      AND "outcome" IS NOT NULL
      AND "score_bps" IS NOT NULL
    )
    OR
    (
      "status" = 'CONFIRMED'
      AND "canonical_report" IS NULL
      AND "report_hash" IS NOT NULL
      AND "outcome" IS NOT NULL
      AND "score_bps" IS NOT NULL
    )
  );

ALTER TABLE "verification_operations"
  ADD CONSTRAINT "verification_operations_confirmation_fields" CHECK (
    (
      "status" <> 'CONFIRMED'
      AND "report_storage_root_hash" IS NULL
      AND "report_storage_transaction_sequence" IS NULL
      AND "report_size_bytes" IS NULL
    )
    OR
    (
      "status" = 'CONFIRMED'
      AND "canonical_report" IS NULL
      AND "report_storage_root_hash" IS NOT NULL
      AND "report_storage_transaction_sequence" IS NOT NULL
      AND "report_size_bytes" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "verification_operations_active_job_unique"
  ON "verification_operations" ("job_id")
  WHERE "status" IN ('CREATED', 'COMPUTING', 'EVALUATED', 'STORING');
