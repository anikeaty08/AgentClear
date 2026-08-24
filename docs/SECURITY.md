# Security

## Implemented controls

- Versioned API routes require a bearer API key and explicit scopes.
- The bootstrap key comparison uses fixed-length HMAC digests and `timingSafeEqual`.
- Authorization headers are redacted from structured logs.
- Environment configuration is validated at startup; obvious placeholder secrets are rejected in production.
- Mutating job operations require a scoped idempotency key; funding, provider assignment, submission, verification, settlement, reputation, and receipt publication additionally require separate purpose-specific scopes.
- Zod rejects malformed or unknown request fields at the HTTP boundary.
- PostgreSQL writes the agreement, requirements, initial event, and idempotency claim in one transaction.
- Rate limiting is applied globally by Fastify.
- MCP keeps scoped API keys in the Bearer header, re-authorizes every operation through REST, validates Host and optional Origin, bounds request/upstream-response sizes and time, and applies a bounded in-memory per-source rate limit. Wallet keys are never MCP inputs.
- Raw stack traces are not returned to clients.
- `.env`, private-key, and PEM files are ignored by Git.
- The chain signer is optional, server-only configuration. Funding is disabled unless the full chain configuration validates.
- Funding enforces a configured integer base-unit maximum per job before signing.
- A signed funding payload is persisted before broadcast, never returned by REST, and cleared after confirmation.
- Receipt confirmation is followed by contract-state attestation before the database marks a job funded.
- Assignment rejects the buyer identity, constrains preselected providers, rejects a zero payment address, persists before broadcast, and attests the escrow provider before marking a job assigned.
- A PostgreSQL session advisory lock spans funding, assignment, Storage, verification, outcome anchoring, escrow finalization, reputation, and receipt publication. Repository transaction locks and cross-operation active checks prevent another instance or a post-restart request from consuming the shared signer nonce while work is unresolved.
- The temporary provider credential is distinct from the operator credential and can submit only for its exact configured agent identity; operators cannot impersonate an assigned provider through the submission endpoint.
- Submission manifests are size-bounded, committed before upload, proof-downloaded, and byte-compared before the job reaches `SUBMITTED`. Confirmed operation payloads are cleared from PostgreSQL.
- Deterministic checks are frozen in the hashed agreement, use exact JSON semantics and integer scoring, and cannot be synthesized from mutable prose after funding.
- Verification rechecks the submission hash and job/provider/agreement bindings before evaluation. The report is hash-checked across recovery, stored as evidence, and cleared from the operation row after confirmation.
- AI modes require a frozen rubric whose unique weights total exactly 10,000 basis points. The domain commits the canonical prompt, recomputes model-supplied weighted totals, hard-gates deterministic failures, and refuses silent fallback to another model.
- 0G Compute uses a dedicated signer distinct from the protocol writer. Provider/model/account/TEE state is checked before dispatch; requests have time and response-size limits; loopback, private-literal, credential-bearing, and non-TLS endpoints are rejected; and the SDK verifies response metadata through `processResponse`.
- A potentially paid Compute request moves the operation to `COMPUTING` before dispatch. An ambiguous retry returns `COMPUTE_RECONCILIATION_REQUIRED` instead of issuing a second paid request.
- `OutcomeRegistry` requires a separate writer role, rejects zero commitments and non-final outcomes, and prevents duplicate finalization.
- Settlement anchors the exact agreement, submission, report, and agent-identity commitments before releasing/refunding escrow. Both signed transactions are persisted before broadcast, attested after confirmation, cleared afterward, and protected against duplicate finalization by database and contract state.
- Reputation values are derived from matching terminal job/verification states, not accepted from API callers. The adapter checks registry linkage, agent existence, and self-feedback; it attests the emitted and stored feedback and prevents duplicate feedback per job.
- Receipt contents are derived only from matching confirmed rows. Exact canonical bytes and their SHA-256 commitment are checked before upload and retained for reproducible download, while the recovery-operation copy is cleared after confirmation. API responses omit internal payload state.
- Dependency lifecycle scripts are deny-by-default. pnpm explicitly permits only the required `esbuild` binary install and denies the optional `blake-hash` native build (which has a JavaScript fallback), optional native WebSocket accelerators, and the unnecessary `es5-ext` postinstall.
- The official Compute SDK currently permits vulnerable `adm-zip` releases through a transitive range; the workspace overrides it to patched 0.6.0 and the high-severity audit gate verifies the resolution. npm also reports low-severity `elliptic` GHSA-848j-6mx2-7j84 through SDK dependencies, but its declared patched 6.6.2 release is not published in the npm registry as of 2026-08-23; forcing a nonexistent version is not possible. Track and upgrade when the official SDK or package publishes a compatible fix.
- Executable submissions run only through the `SandboxVerifier` port. The Docker adapter requires a digest-pinned image, disables networking, mounts provider code read-only, uses an unprivileged UID, drops all capabilities, forbids privilege gain, caps memory/CPU/PIDs/tmpfs/time/output, and force-cleans the container. No wallet, environment secret, Docker socket, or writable host path is mounted. Each test vector runs below a trusted parent harness and must return over nonce-authenticated IPC, preventing module top-level output/exit forgery. Real-container tests cover loopback-only networking, timeout termination, and a malicious forged-success attempt.

## Not yet implemented

The bootstrap API keys are a development foundation, not the final multi-tenant key system. Per-key database records, one-time secret display, rotation, provider identity-to-payment-address binding during assignment, daily/monthly spending limits, webhook signing, admin authorization, dedicated/rootless sandbox worker deployment with hardened seccomp/AppArmor and image scanning, hardened signer custody, encryption at rest for pending signed transactions/evidence payloads, DNS-rebinding-resistant Compute endpoint pinning, provider-side paid-call reconciliation, and automated stale-operation reconciliation remain release blockers.

The local/API chain path accepts a signer key only from server environment configuration. It must never be placed in frontend code, logs, API bodies, or MCP tool arguments. The checked `.env.example` contains blank placeholders only.
