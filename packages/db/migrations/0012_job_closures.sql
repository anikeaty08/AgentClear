ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_scope_values_check";
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scope_values_check" CHECK (
  "scopes" <@ ARRAY[
    'jobs:read',
    'jobs:write',
    'jobs:fund',
    'jobs:assign',
    'jobs:cancel',
    'jobs:submit',
    'jobs:verify',
    'jobs:settle',
    'jobs:reputation',
    'jobs:receipt',
    'api-keys:manage',
    'spending-policies:manage'
  ]::text[]
);

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_refund_on_expiry_required_check"
  CHECK ("refund_on_expiry" = true) NOT VALID;

CREATE TYPE "job_closure_kind" AS ENUM ('CANCEL', 'EXPIRE');
CREATE TYPE "job_closure_operation_status" AS ENUM (
  'CREATED',
  'PREPARED',
  'BROADCAST',
  'CONFIRMED'
);

CREATE TABLE "job_closure_operations" (
  "id" uuid PRIMARY KEY,
  "job_id" uuid NOT NULL REFERENCES "jobs"("id") ON DELETE RESTRICT,
  "kind" "job_closure_kind" NOT NULL,
  "initial_state" "job_state" NOT NULL,
  "status" "job_closure_operation_status" NOT NULL,
  "actor_type" "job_actor_type" NOT NULL,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL,
  "chain_id" integer NOT NULL,
  "contract_address" varchar(42) NOT NULL,
  "signer_address" varchar(42) NOT NULL,
  "amount_base_units" numeric(78, 0) NOT NULL,
  "job_key" varchar(66),
  "serialized_transaction" text,
  "transaction_hash" varchar(66),
  "block_number" numeric(78, 0),
  "idempotency_scope" varchar(255) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(66) NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "job_closure_operations_idempotency_unique"
    UNIQUE ("idempotency_scope", "idempotency_key"),
  CONSTRAINT "job_closure_operations_transaction_hash_unique" UNIQUE ("transaction_hash"),
  CONSTRAINT "job_closure_operations_amount_positive_check" CHECK ("amount_base_units" > 0),
  CONSTRAINT "job_closure_operations_reason_not_blank_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "job_closure_operations_initial_state_check" CHECK (
    ("kind" = 'CANCEL' AND "initial_state" = 'FUNDED')
    OR (
      "kind" = 'EXPIRE'
      AND "initial_state" IN ('FUNDED', 'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RETRY')
    )
  ),
  CONSTRAINT "job_closure_operations_state_fields_check" CHECK (
    (
      "status" = 'CREATED'
      AND "job_key" IS NULL
      AND "serialized_transaction" IS NULL
      AND "transaction_hash" IS NULL
      AND "block_number" IS NULL
    ) OR (
      "status" IN ('PREPARED', 'BROADCAST')
      AND "job_key" IS NOT NULL
      AND "serialized_transaction" IS NOT NULL
      AND "transaction_hash" IS NOT NULL
      AND "block_number" IS NULL
    ) OR (
      "status" = 'CONFIRMED'
      AND "job_key" IS NOT NULL
      AND "serialized_transaction" IS NULL
      AND "transaction_hash" IS NOT NULL
      AND "block_number" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "job_closure_operations_active_job_unique"
  ON "job_closure_operations" ("job_id")
  WHERE "status" IN ('CREATED', 'PREPARED', 'BROADCAST');

CREATE INDEX "job_closure_operations_status_updated_at_idx"
  ON "job_closure_operations" ("status", "updated_at");
