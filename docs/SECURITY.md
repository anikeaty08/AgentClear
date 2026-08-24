# Security

## Implemented controls

- Versioned API routes require a bearer API key and explicit scopes.
- The bootstrap key comparison uses fixed-length HMAC digests and `timingSafeEqual`.
- Durable API keys use a reserved `ac_` namespace, UUID lookup, and random 256-bit secret. Bootstrap credentials are rejected from that namespace to prevent authenticator ambiguity. PostgreSQL stores only an HMAC-SHA256 digest; the plaintext is emitted once with `Cache-Control: no-store`. Expiry and revocation are enforced during every authentication, and last use is recorded.
- Key delegation cannot exceed the caller's own scopes. Non-operator key managers are confined to their exact principal; operators can issue agent/service credentials for onboarding and revoke them without deleting audit metadata.
- Authorization headers are redacted from structured logs.
- Environment configuration is validated at startup; obvious placeholder secrets are rejected in production.
- Mutating job operations require a scoped idempotency key; funding, provider assignment, cancellation/expiry, submission, verification, settlement, reputation, and receipt publication additionally require separate purpose-specific scopes.
- Zod rejects malformed or unknown request fields at the HTTP boundary.
- PostgreSQL writes the agreement, requirements, initial event, and idempotency claim in one transaction.
- Rate limiting is applied globally by Fastify.
- MCP keeps scoped API keys in the Bearer header, re-authorizes every operation through REST, validates Host and optional Origin, bounds request/upstream-response sizes and time, and applies a bounded in-memory per-source rate limit. Wallet keys are never MCP inputs.
- Raw stack traces are not returned to clients.
- `.env`, private-key, and PEM files are ignored by Git.
- The chain signer is optional, server-only configuration. Funding is disabled unless the full chain configuration validates.
- Funding fails closed without a durable policy for the authenticated principal. A PostgreSQL advisory lock serializes per-principal authorization, and capability plus integer per-job/current-UTC-day/current-UTC-month limits are checked before transaction preparation or signing. Authorized and unexpired approval-pending reservations count against the aggregates; the configured server-wide maximum remains a second ceiling.
- Policy creation/read and high-value funding approval are operator-only and require `spending-policies:manage`. Approval thresholds create 24-hour reservations, expose no signer material, and recheck the current policy and aggregate limits before authorization.
- A signed funding payload is persisted before broadcast, never returned by REST, and cleared after confirmation.
- Receipt confirmation is followed by contract-state attestation before the database marks a job funded.
- Assignment rejects the buyer identity, constrains preselected providers, rejects a zero payment address, persists before broadcast, and attests the escrow provider before marking a job assigned.
- Agent cancellation requires the exact buyer identity and stops at provider assignment. Funded cancellation and deadline expiry persist the exact signed refund before broadcast, attest the escrow's refunded state, clear the payload after confirmation, and preserve transaction-backed state events. New agreements require the same expiry-refund policy enforced by the escrow contract.
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

Organization membership/roles, provider identity-to-payment-address binding during assignment, webhook signing, admin authorization, dedicated/rootless sandbox worker deployment with hardened seccomp/AppArmor and image scanning, hardened signer custody, encryption at rest for pending signed transactions/evidence payloads, DNS-rebinding-resistant Compute endpoint pinning, provider-side paid-call reconciliation, and automated stale-operation/released-spend reconciliation remain release blockers. Funding reservations deliberately remain fail-safe after an ambiguous chain failure and age out of the daily/monthly windows; an automated reconciler should eventually release demonstrably unused authorizations sooner. The bootstrap operator key remains a recovery/onboarding credential and should not be used as an everyday runtime key.

The local/API chain path accepts a signer key only from server environment configuration. It must never be placed in frontend code, logs, API bodies, or MCP tool arguments. The checked `.env.example` contains blank placeholders only.
