ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_scope_values_check";
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scope_values_check" CHECK (
  "scopes" <@ ARRAY[
    'jobs:read',
    'jobs:write',
    'jobs:fund',
    'jobs:assign',
    'jobs:submit',
    'jobs:verify',
    'jobs:settle',
    'jobs:reputation',
    'jobs:receipt',
    'api-keys:manage',
    'spending-policies:manage'
  ]::text[]
);

CREATE TYPE "funding_authorization_status" AS ENUM (
  'PENDING_APPROVAL',
  'AUTHORIZED',
  'EXPIRED'
);

CREATE TABLE "spending_policies" (
  "principal_id" text PRIMARY KEY,
  "principal_kind" "api_key_principal_kind" NOT NULL,
  "max_per_job_base_units" numeric(78, 0) NOT NULL,
  "max_per_day_base_units" numeric(78, 0) NOT NULL,
  "max_per_month_base_units" numeric(78, 0) NOT NULL,
  "allowed_capabilities" text[] NOT NULL,
  "require_human_approval_above_base_units" numeric(78, 0),
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "spending_policies_principal_format_check" CHECK (
    length("principal_id") BETWEEN 1 AND 200
    AND "principal_id" ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT "spending_policies_agent_identity_check" CHECK (
    "principal_kind" <> 'agent' OR "principal_id" ~ '^erc8004:[0-9]+:[0-9]+$'
  ),
  CONSTRAINT "spending_policies_limits_check" CHECK (
    "max_per_job_base_units" > 0
    AND "max_per_job_base_units" <= "max_per_day_base_units"
    AND "max_per_day_base_units" <= "max_per_month_base_units"
  ),
  CONSTRAINT "spending_policies_capabilities_check" CHECK (
    cardinality("allowed_capabilities") > 0
    AND "allowed_capabilities" <@ ARRAY['code','data','research','content','other']::text[]
  ),
  CONSTRAINT "spending_policies_approval_threshold_check" CHECK (
    "require_human_approval_above_base_units" IS NULL
    OR (
      "require_human_approval_above_base_units" >= 0
      AND "require_human_approval_above_base_units" <= "max_per_job_base_units"
    )
  )
);

CREATE TABLE "funding_authorizations" (
  "job_id" uuid PRIMARY KEY REFERENCES "jobs" ("id") ON DELETE RESTRICT,
  "principal_id" text NOT NULL REFERENCES "spending_policies" ("principal_id") ON DELETE RESTRICT,
  "amount_base_units" numeric(78, 0) NOT NULL CHECK ("amount_base_units" > 0),
  "capability" varchar(32) NOT NULL CHECK (
    "capability" IN ('code','data','research','content','other')
  ),
  "status" "funding_authorization_status" NOT NULL,
  "reserved_at" timestamptz NOT NULL,
  "approval_expires_at" timestamptz,
  "approved_by" text,
  "approved_at" timestamptz,
  CONSTRAINT "funding_authorizations_state_fields_check" CHECK (
    (
      "status" = 'PENDING_APPROVAL'
      AND "approval_expires_at" IS NOT NULL
      AND "approval_expires_at" > "reserved_at"
      AND "approved_by" IS NULL
      AND "approved_at" IS NULL
    )
    OR
    (
      "status" = 'AUTHORIZED'
      AND "approval_expires_at" IS NULL
      AND (
        ("approved_by" IS NULL AND "approved_at" IS NULL)
        OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL)
      )
    )
    OR
    (
      "status" = 'EXPIRED'
      AND "approval_expires_at" IS NOT NULL
      AND "approved_by" IS NULL
      AND "approved_at" IS NULL
    )
  )
);

CREATE INDEX "funding_authorizations_principal_reserved_idx"
  ON "funding_authorizations" ("principal_id", "reserved_at");

CREATE INDEX "funding_authorizations_pending_expiry_idx"
  ON "funding_authorizations" ("status", "approval_expires_at");
