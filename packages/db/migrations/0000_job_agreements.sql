CREATE TYPE "job_state" AS ENUM (
  'DRAFT',
  'QUOTED',
  'FUNDED',
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'SUBMITTED',
  'VERIFYING',
  'PASSED',
  'FAILED',
  'NEEDS_REVIEW',
  'SETTLING',
  'RETRY',
  'DISPUTED',
  'PAID',
  'FAILED_FINAL',
  'RESOLVED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED'
);

CREATE TYPE "job_actor_type" AS ENUM ('agent', 'operator', 'service', 'verifier', 'resolver');

CREATE TABLE "jobs" (
  "id" uuid PRIMARY KEY,
  "buyer_agent_id" text NOT NULL,
  "provider_agent_id" text,
  "title" varchar(160) NOT NULL,
  "description" text NOT NULL,
  "budget_token" text NOT NULL,
  "budget_max_amount" text NOT NULL,
  "budget_amount_base_units" numeric(78, 0) NOT NULL CHECK ("budget_amount_base_units" > 0),
  "deadline" timestamptz NOT NULL,
  "deliverable_type" varchar(32) NOT NULL,
  "deliverable_format" varchar(100) NOT NULL,
  "verification_mode" varchar(40) NOT NULL,
  "minimum_score_bps" smallint NOT NULL CHECK ("minimum_score_bps" BETWEEN 0 AND 10000),
  "refund_on_expiry" boolean NOT NULL,
  "refund_on_final_failure" boolean NOT NULL,
  "state" "job_state" NOT NULL,
  "agreement_snapshot" jsonb NOT NULL,
  "agreement_hash" varchar(66) NOT NULL,
  "version" integer NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "jobs_agreement_hash_unique" UNIQUE ("agreement_hash")
);

CREATE INDEX "jobs_state_created_at_idx" ON "jobs" ("state", "created_at");
CREATE INDEX "jobs_buyer_agent_created_at_idx" ON "jobs" ("buyer_agent_id", "created_at");
CREATE INDEX "jobs_provider_agent_state_idx" ON "jobs" ("provider_agent_id", "state");

CREATE TABLE "job_requirements" (
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE CASCADE,
  "ordinal" smallint NOT NULL CHECK ("ordinal" >= 0),
  "requirement" text NOT NULL,
  PRIMARY KEY ("job_id", "ordinal")
);

CREATE TABLE "job_state_events" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "from_state" "job_state",
  "to_state" "job_state" NOT NULL,
  "actor_type" "job_actor_type" NOT NULL,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL,
  "transaction_hash" varchar(66),
  "evidence_reference" text,
  "occurred_at" timestamptz NOT NULL
);

CREATE INDEX "job_state_events_job_occurred_at_idx"
  ON "job_state_events" ("job_id", "occurred_at");

CREATE TABLE "idempotency_records" (
  "scope" varchar(255) NOT NULL,
  "key" varchar(255) NOT NULL,
  "request_hash" varchar(66) NOT NULL,
  "resource_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("scope", "key")
);

CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records" ("expires_at");

