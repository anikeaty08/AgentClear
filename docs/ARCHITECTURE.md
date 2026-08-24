# Architecture

## Current boundary

AgentClear begins as a modular monolith. HTTP is an adapter, not the owner of job logic. `JobService` owns the create/read/list use cases and depends on repository ports. `PostgresJobRepository` is the production adapter; tests can replace it without changing business behavior. The MCP server is a thin authenticated Streamable HTTP adapter over the versioned REST/application boundary and does not duplicate lifecycle logic.

```text
REST HTTP <- stateless MCP adapter
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

1. Fastify authenticates a bootstrap or PostgreSQL-backed bearer API key and requires `jobs:write`.
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
- Durable API-key plaintext exists only in the create response. The database stores an HMAC digest, principal, scopes, expiry/revocation state, and audit timestamps; scope delegation cannot exceed the caller.

## Chain transaction boundary

`packages/chain` implements the first real adapter for `JobEscrow`. Funding uses a local viem signer to simulate and fully sign the contract transaction before broadcast. The signed payload and its deterministic transaction hash can therefore be persisted by the application before any RPC submission. Replaying the same payload rebroadcasts the same transaction instead of creating a second escrow.

After receipt confirmation, the adapter reads the escrow mapping and checks the buyer, amount, agreement hash, and state. A receipt alone is not treated as proof that the expected state was written. The adapter has been exercised against an ephemeral Anvil EVM; this is local integration evidence, not a 0G testnet deployment claim.

`FundingService` / `PostgresEscrowRepository`, `AssignmentService` / `PostgresAssignmentRepository`, and `JobClosureService` / `PostgresJobClosureRepository` make funding, assignment, buyer cancellation, and deadline expiry resumable:

```text
CREATED -> PREPARED -> BROADCAST -> CONFIRMED
             |             |
             `-- retry same signed transaction hash --'
```

The job stays `QUOTED` until funding receipt and state attestation both succeed. Assignment first records `FUNDED -> OPEN`; it records `OPEN -> ASSIGNED` only after the provider stored in the escrow matches the request. Unfunded cancellation is atomic database state. Funded unassigned cancellation confirms `cancelUnassigned` before `CANCELLED`. Deadline processing records `EXPIRED`, confirms `refundExpired`, and then records `REFUNDED`. Each confirmation updates the operation, escrow record, job state, and immutable state event in one database transaction. Serialized signed transactions are cleared after confirmation and are never returned by REST.

Funding is fail-closed behind `PostgresSpendingPolicyRepository`. A PostgreSQL advisory lock per authenticated principal serializes policy decisions across API instances. The repository atomically checks the deliverable capability and per-job/day/month integer limits and records one job reservation before `FundingService` asks the chain gateway to prepare or sign. Authorized and unexpired approval-pending jobs both reserve capacity. Jobs above an optional threshold return an approval-required decision; an operator-only service rechecks the current policy and aggregate usage before converting that reservation to authorized. The server-wide per-job ceiling and separate `jobs:fund`, `jobs:assign`, `jobs:cancel`, and `spending-policies:manage` scopes remain additional controls.

Funding, assignment, cancellation/expiry refunds, 0G Storage submission, verification publication, outcome anchoring, settlement, ERC-8004 feedback, and receipt publication reuse one configured protocol signer. 0G Compute requires a separate, least-privilege signer. A PostgreSQL session advisory lock spans each complete external operation, including preparation, persistence, broadcast/upload, confirmation, and database finalization, so independent API instances cannot concurrently consume protocol nonces or overlap paid boundaries. Repository transactions take a separate state lock, and any unfinished signed, storage, or Compute operation blocks unrelated writes until it is safely resumed or reconciled. Automated stale-operation reconciliation and hardened external signer custody remain release blockers.

Provider agent identifiers are syntax-checked and agreement-constrained during assignment. ERC-8004 feedback resolves the token through `IdentityRegistry.ownerOf` and rejects self-feedback, but assignment itself does not yet prove token ownership or bind the identity token to the provider payment address.

## Provider submission and evidence boundary

`SubmissionService` authorizes the exact assigned provider identity and constructs one canonical evidence manifest. `PostgresSubmissionRepository` moves the job from `ASSIGNED` or `RETRY` to `IN_PROGRESS`, persists the exact manifest bytes before external I/O, and makes retries use those same bytes. `ZeroGStorageClient` computes the Merkle root, uploads with finalized-content reuse enabled, proof-downloads the root, and byte-compares the retrieved content before confirmation.

```text
ASSIGNED -> IN_PROGRESS -> SUBMITTED
                 |
                 `-> durable CREATED -> STORING -> CONFIRMED operation
                                      -> submission + artifact + audit event
```

The REST response contains evidence metadata, never the stored canonical payload. Confirmation clears the payload from the operation row. The production adapter is implemented against the current official SDK, but no live 0G Storage call has been exercised from this repository yet; automated API integration uses a controlled port implementation and does not claim network behavior.

## Verification and 0G Compute boundary

The agreement carries typed deterministic checks instead of asking the verifier to infer rules from prose. `VerificationService` proof-downloads the latest submission, verifies its SHA-256 commitment and manifest bindings, evaluates paths with exact JSON semantics, dispatches explicit executable vectors through the `SandboxVerifier` port, and calculates one integer weighted score. Hard failures dominate. Reports identify the agreement, submission, verifier version, individual checks, sandbox exit/resource/result metadata, score, and outcome.

`packages/sandbox` is a separate infrastructure adapter. It rejects mutable images and unsafe paths, writes a bounded temporary workspace, creates a networkless/read-only/capability-free/unprivileged/resource-limited Docker container, attaches with bounded output and a real timeout, inspects the terminal state, and force-removes the container in `finally`. No submitted module is loaded on the API host. The production Docker daemon remains a privileged boundary and should live on a dedicated worker host; see `docs/SANDBOX.md`.

AI modes also require an explicit weighted rubric. Domain code constructs and hashes canonical prompt JSON; the 0G adapter validates the configured on-chain provider, advertised model, account balance, and TEE acknowledgement, gets SDK billing headers, sends one bounded inference request, calls `processResponse`, and strictly parses the result. Domain code recomputes rubric totals and applies hard-gate consensus rather than averaging away a deterministic failure.

The database makes report publication recoverable and prevents an ambiguous paid call from being repeated:

```text
SUBMITTED -> VERIFYING -> PASSED | FAILED | NEEDS_REVIEW
                    |
                    `-> CREATED -> COMPUTING -> EVALUATED -> STORING -> CONFIRMED
                                  prompt hash   persist exact report     clear payload
```

`deterministic_plus_ai` never silently substitutes a model. A deterministic hard failure produces `FAIL`; unverified AI output produces `NEEDS_REVIEW`; both required signals must independently reach the threshold for `PASS`. A process interruption during `COMPUTING` produces an explicit reconciliation-required error instead of a duplicate paid request. See `docs/COMPUTE.md`.

## Outcome and settlement boundary

`SettlementService` accepts only the latest evidence-backed final `PASS` or a final `FAIL` whose frozen agreement permits refund. It first anchors agreement, submission, verification-report, buyer-identity, and provider-identity commitments in `OutcomeRegistry`. Only after reading those commitments back does it prepare the escrow release or failure refund. Each signed transaction is persisted before broadcast and exact retries reuse it.

```text
PASSED -> SETTLING -> PAID
FAILED -> FAILED_FINAL -> REFUNDED

CREATED -> OUTCOME_PREPARED -> OUTCOME_BROADCAST -> OUTCOME_CONFIRMED
        -> ESCROW_PREPARED  -> ESCROW_BROADCAST  -> CONFIRMED
```

The database records the outcome and escrow transaction hashes/blocks, final amount, immutable state events, and a single payment or refund row. Serialized transactions are cleared after each confirmation. PostgreSQL and contract guards reject a second finalization; an exact idempotency retry returns the original result. `/ready` checks both configured contract deployments. The complete PASS/pay and FAIL/refund paths are exercised through REST against deployed Anvil contracts; this is local EVM evidence, not a 0G testnet claim.

## ERC-8004 reputation boundary

`ReputationService` derives feedback only from an evidence-backed terminal pairing: `PAID` with `PASS`, or `REFUNDED` with `FAIL`. It does not accept caller-provided scores. The chain adapter uses the current eight-argument `giveFeedback` interface, verifies registry bytecode and IdentityRegistry linkage, checks agent ownership and the self-feedback rule, persists the signed transaction before broadcast, parses `NewFeedback`, and reads the feedback back from the registry before confirmation.

```text
PAID + PASS       -> value 100, decimals 0
REFUNDED + FAIL   -> value   0, decimals 0

CREATED -> PREPARED -> BROADCAST -> CONFIRMED
             `-- exact signed transaction recovery --'
```

One database operation and one confirmed reputation event are permitted per AgentClear job. The report's content-addressed Storage root is the evidence URI; the bytes32 hash is zero as allowed for content-addressed URIs. The app does not hardcode registry deployments. Local tests deploy a controlled exact-interface fixture, while live 0G addresses must come from environment configuration. See `docs/ERC8004.md`.

## Portable receipt boundary

`ReceiptService` materializes an immutable versioned snapshot only after it can join one matching terminal job, submission, verification report, confirmed settlement, payment/refund row, and reputation event. It derives all fields from durable state; clients cannot supply receipt contents. The canonical JSON is persisted and SHA-256 committed before Storage I/O, verified again during recovery, proof-uploaded through the same evidence port, then written to the immutable `receipts` table. The pending operation payload is cleared after confirmation while the exact downloadable bytes remain with the durable receipt.

```text
PAID + PASS + reputation 100       --\
                                      -> canonical receipt -> Storage -> REST/download
REFUNDED + FAIL + reputation 0    --/

CREATED -> STORING -> CONFIRMED
             `-- resume exact canonical bytes --'
```

One receipt is permitted per job and commitment. REST and the future MCP adapter consume the same service. Publication is part of the settlement/reputation recovery chain, but it has a separate idempotent endpoint so an interrupted Storage call cannot require a new payment or reputation transaction. See `docs/RECEIPTS.md`.

## Minimal infrastructure choice

PostgreSQL is currently the only stateful dependency. Redis was intentionally omitted. Verification dispatch, chain reconciliation, and webhook delivery will first use a PostgreSQL outbox/lease design with idempotent workers. Another queue system should be added only when measured throughput or isolation requirements justify it.

## Core flow

The remaining boundaries preserve the same domain-service pattern:

```text
agreement -> 0G Chain escrow -> 0G Storage submission evidence
          -> sandbox verification -> 0G Compute rubric signal
          -> outcome anchor -> settle/refund -> ERC-8004 feedback -> receipt
```

Outcome anchoring, settlement/refund, cancellation/expiry refunds, ERC-8004 feedback, portable receipts, durable scoped API keys and funding policies, the real 0G Compute SDK adapter, the disposable Docker sandbox, and eleven REST-backed MCP tools are implemented locally. Each adapter exposes degraded health until it has valid configuration, and integration tests distinguish controlled local boundaries from live 0G testnet proof. The remaining MCP discovery/reputation queries and web adapter still need to connect to these same services.
