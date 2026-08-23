# Security

## Implemented controls

- Versioned API routes require a bearer API key and explicit scopes.
- The bootstrap key comparison uses fixed-length HMAC digests and `timingSafeEqual`.
- Authorization headers are redacted from structured logs.
- Environment configuration is validated at startup; obvious placeholder secrets are rejected in production.
- Mutating job operations require a scoped idempotency key; funding, provider assignment, and submission additionally require separate `jobs:fund`, `jobs:assign`, and `jobs:submit` scopes.
- Zod rejects malformed or unknown request fields at the HTTP boundary.
- PostgreSQL writes the agreement, requirements, initial event, and idempotency claim in one transaction.
- Rate limiting is applied globally by Fastify.
- Raw stack traces are not returned to clients.
- `.env`, private-key, and PEM files are ignored by Git.
- The chain signer is optional, server-only configuration. Funding is disabled unless the full chain configuration validates.
- Funding enforces a configured integer base-unit maximum per job before signing.
- A signed funding payload is persisted before broadcast, never returned by REST, and cleared after confirmation.
- Receipt confirmation is followed by contract-state attestation before the database marks a job funded.
- Assignment rejects the buyer identity, constrains preselected providers, rejects a zero payment address, persists before broadcast, and attests the escrow provider before marking a job assigned.
- A PostgreSQL session advisory lock spans funding, assignment, and Storage operations. Repository transaction locks and cross-operation active checks prevent another instance or a post-restart request from consuming the shared signer nonce while work is unresolved.
- The temporary provider credential is distinct from the operator credential and can submit only for its exact configured agent identity; operators cannot impersonate an assigned provider through the submission endpoint.
- Submission manifests are size-bounded, committed before upload, proof-downloaded, and byte-compared before the job reaches `SUBMITTED`. Confirmed operation payloads are cleared from PostgreSQL.
- Deterministic checks are frozen in the hashed agreement, use exact JSON semantics and integer scoring, and cannot be synthesized from mutable prose after funding.
- Verification rechecks the submission hash and job/provider/agreement bindings before evaluation. The report is hash-checked across recovery, stored as evidence, and cleared from the operation row after confirmation.
- `OutcomeRegistry` requires a separate writer role, rejects zero commitments and non-final outcomes, and prevents duplicate finalization.
- Dependency lifecycle scripts are deny-by-default. pnpm explicitly permits only the required `esbuild` binary install and denies optional native WebSocket accelerators plus the unnecessary `es5-ext` postinstall.

## Not yet implemented

The bootstrap API keys are a development foundation, not the final multi-tenant key system. Per-key database records, one-time secret display, rotation, agent ownership permissions, live ERC-8004 identity resolution, daily/monthly spending limits, webhook signing, admin authorization, sandbox isolation, hardened chain signer custody, encryption at rest for pending signed transactions/evidence payloads, and automated stale-operation reconciliation remain release blockers.

The local/API chain path accepts a signer key only from server environment configuration. It must never be placed in frontend code, logs, API bodies, or MCP tool arguments. The checked `.env.example` contains blank placeholders only.
