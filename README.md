# AgentClear

AgentClear is an outcome-verification and settlement layer for AI-agent commerce on 0G. It binds a structured task agreement to escrow, evidence-backed verification, settlement or refund, and transaction-backed agent reputation.

The repository is under active development. Authenticated structured job creation, immutable agreement commitments, PostgreSQL persistence, the native-asset `JobEscrow` contract, and its viem chain adapter are implemented and tested. The adapter persists-compatible signed transaction payloads, broadcasts them idempotently, waits for receipts, and attests the resulting contract state. API-to-chain orchestration, a 0G testnet deployment, Storage, Compute, ERC-8004 writes, MCP, and the operator UI remain in progress and are not simulated.

```mermaid
flowchart LR
  Client[Buyer agent / operator] -->|Bearer key + idempotency key| API[Fastify REST API]
  API --> Domain[Canonical agreement + state machine]
  Domain --> DB[(PostgreSQL)]
  DB --> Events[Immutable state events]
  Domain -. integration in progress .-> Chain[JobEscrow / 0G Chain]
  Domain -. planned .-> Storage[0G Storage evidence]
  Domain -. planned .-> Compute[0G Compute verification]
  Chain -. planned .-> Receipt[Portable receipt + ERC-8004 reputation]
```

## Current stack

- Node.js 24, TypeScript 6, pnpm workspaces, and Turborepo
- Fastify 5 with Zod validation, scoped bootstrap API-key authentication, request IDs, stable errors, and rate limiting
- PostgreSQL 17 with Drizzle ORM and checked SQL migrations
- Vitest unit and PostgreSQL integration tests
- Solidity 0.8.24, Foundry 1.7.1, and OpenZeppelin Contracts 5.6.1

PostgreSQL is the only stateful local dependency. Redis is deliberately not used at this stage; future asynchronous work will begin with a PostgreSQL outbox/worker unless measured scale requires another system.

## Run locally

Requirements: Node.js 24+, pnpm 11.6+, Docker, and Foundry 1.7.1.

```bash
cp .env.example .env
# Replace every placeholder in .env.
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm dev
```

The API listens on `http://127.0.0.1:3001` by default. Versioned routes require `Authorization: Bearer <BOOTSTRAP_API_KEY>`. `POST /v1/jobs` also requires an `Idempotency-Key` header.

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
forge fmt --check --root packages/contracts
forge test --root packages/contracts -vvv
```

`pnpm test:integration` requires the PostgreSQL container and applies migrations before running sequential database/API tests.

## Repository map

- `apps/api` -- Fastify transport and authentication boundary
- `packages/contracts` -- native-asset job escrow and Foundry security tests
- `packages/chain` -- viem transaction preparation, broadcast, confirmation, and state attestation
- `packages/domain` -- canonical agreement, state machine, commitments, money conversion, and application service
- `packages/db` -- Drizzle schema, migrations, and PostgreSQL repository adapter
- `packages/config` -- strict environment validation
- `.0g-skills` -- vendored 0G reference material; current official docs and installed package source remain higher authority
- `docs` -- architecture, API, contracts, security, and testing notes matching implemented behavior

See [`AGENTS.md`](./AGENTS.md) for the full product definition and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for current boundaries and the planned 0G flow.

No live contract address, transaction hash, 0G Storage reference, Compute receipt, or ERC-8004 deployment is published yet because none has been exercised on 0G testnet from this repository.
