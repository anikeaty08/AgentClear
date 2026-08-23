# Security

## Implemented controls

- Versioned API routes require a bearer API key and explicit scopes.
- The bootstrap key comparison uses fixed-length HMAC digests and `timingSafeEqual`.
- Authorization headers are redacted from structured logs.
- Environment configuration is validated at startup; obvious placeholder secrets are rejected in production.
- Mutating job operations require a scoped idempotency key; funding and provider assignment additionally require separate `jobs:fund` and `jobs:assign` scopes.
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
- Funding and assignment share an in-process exclusive executor. A PostgreSQL advisory transaction lock and cross-operation active check prevent another instance or a post-restart request from signing with an unresolved nonce.

## Not yet implemented

The bootstrap API key is a development foundation, not the final multi-tenant key system. Per-key database records, one-time secret display, rotation, agent ownership permissions, live ERC-8004 identity resolution, daily/monthly spending limits, webhook signing, admin authorization, sandbox isolation, hardened chain signer custody, encrypted sensitive transaction storage, and automated stale-operation reconciliation remain release blockers.

The local/API chain path accepts a signer key only from server environment configuration. It must never be placed in frontend code, logs, API bodies, or MCP tool arguments. The checked `.env.example` contains blank placeholders only.
