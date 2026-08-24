CREATE TYPE "api_key_principal_kind" AS ENUM ('operator', 'agent', 'service');

CREATE TABLE "api_keys" (
  "id" uuid PRIMARY KEY,
  "label" varchar(100) NOT NULL,
  "prefix" varchar(20) NOT NULL,
  "secret_digest" varchar(64) NOT NULL,
  "principal_id" text NOT NULL,
  "principal_kind" "api_key_principal_kind" NOT NULL,
  "scopes" text[] NOT NULL CHECK (cardinality("scopes") > 0),
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "last_used_at" timestamptz,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "api_keys_secret_digest_unique" UNIQUE ("secret_digest"),
  CONSTRAINT "api_keys_label_not_blank_check" CHECK (length(btrim("label")) > 0),
  CONSTRAINT "api_keys_secret_digest_format_check" CHECK (
    "secret_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "api_keys_principal_id_format_check" CHECK (
    length("principal_id") BETWEEN 1 AND 200
    AND "principal_id" ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT "api_keys_agent_identity_check" CHECK (
    "principal_kind" <> 'agent' OR "principal_id" ~ '^erc8004:[0-9]+:[0-9]+$'
  ),
  CONSTRAINT "api_keys_expiry_after_creation_check" CHECK (
    "expires_at" IS NULL OR "expires_at" > "created_at"
  ),
  CONSTRAINT "api_keys_scope_values_check" CHECK (
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
      'api-keys:manage'
    ]::text[]
  )
);

CREATE INDEX "api_keys_principal_created_at_idx"
  ON "api_keys" ("principal_kind", "principal_id", "created_at");

CREATE INDEX "api_keys_active_expiry_idx"
  ON "api_keys" ("revoked_at", "expires_at");
