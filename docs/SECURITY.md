# Security

## Implemented controls

- Versioned API routes require a bearer API key and explicit scopes.
- The bootstrap key comparison uses fixed-length HMAC digests and `timingSafeEqual`.
- Authorization headers are redacted from structured logs.
- Environment configuration is validated at startup; obvious placeholder secrets are rejected in production.
- Mutating job creation requires a scoped idempotency key.
- Zod rejects malformed or unknown request fields at the HTTP boundary.
- PostgreSQL writes the agreement, requirements, initial event, and idempotency claim in one transaction.
- Rate limiting is applied globally by Fastify.
- Raw stack traces are not returned to clients.
- `.env`, private-key, and PEM files are ignored by Git.

## Not yet implemented

The bootstrap API key is a development foundation, not the final multi-tenant key system. Per-key database records, one-time secret display, rotation, agent ownership permissions, spending policies, webhook signing, admin authorization, sandbox isolation, and chain signer custody remain release blockers.

No private key is currently required because chain, Storage, Compute, and ERC-8004 writes have not been integrated. When introduced, keys must remain server-side and must never be accepted in MCP tool arguments.

