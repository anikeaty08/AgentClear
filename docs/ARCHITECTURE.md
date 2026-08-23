# Architecture

## Current boundary

AgentClear begins as a modular monolith. HTTP is an adapter, not the owner of job logic. `JobService` owns the create/read use cases and depends on a `JobRepository` port. `PostgresJobRepository` is the production adapter; tests can replace it without changing business behavior. The future MCP server will call the same service instead of duplicating lifecycle logic.

```text
HTTP / future MCP
       |
authentication + validation
       |
JobService
  |-- canonical agreement normalization
  |-- lossless native-token base-unit conversion
  |-- SHA-256 agreement commitment
  |-- explicit JobState
       |
JobRepository port
       |
PostgresJobRepository
  |-- jobs
  |-- job_requirements
  |-- job_state_events
  `-- idempotency_records
```

## Create-job data flow

1. Fastify authenticates a bearer API key and requires `jobs:write`.
2. Zod validates the structured agreement and rejects unknown fields.
3. `JobService` normalizes the deadline, converts the native-token decimal amount to 18-decimal base units without floating-point arithmetic, creates a UUID, and commits the canonical agreement with SHA-256.
4. `PostgresJobRepository` claims `(scope, idempotency key)` and writes the job, normalized requirements, and initial immutable `DRAFT` event in one transaction.
5. An exact retry returns the original job. Reusing the key for a different normalized request returns `IDEMPOTENCY_KEY_REUSED`.

## Invariants

- Job state is a closed enum; legal transitions live in `packages/domain/src/job-state.ts`.
- Monetary token values are strings/base-unit integers, never JavaScript floating-point balances.
- A job and its initial event cannot commit independently.
- Agreement hashes are unique and computed from canonical JSON.
- API errors never expose stack traces.
- Bootstrap secrets are server-only, redacted from logs, and rejected when obvious placeholders are used in production.

## Minimal infrastructure choice

PostgreSQL is currently the only stateful dependency. Redis was intentionally omitted. Verification dispatch, chain reconciliation, and webhook delivery will first use a PostgreSQL outbox/lease design with idempotent workers. Another queue system should be added only when measured throughput or isolation requirements justify it.

## Planned core flow

The next boundaries will preserve the same domain-service pattern:

```text
agreement -> 0G Chain escrow -> submission -> sandbox verification
          -> 0G Storage evidence -> 0G Compute rubric signal
          -> outcome anchor -> settle/refund -> ERC-8004 adapter -> receipt
```

None of those planned boundaries currently report simulated success. Each adapter must expose degraded health until it has valid configuration, and integration tests must distinguish local contract tests from live 0G testnet proof.

