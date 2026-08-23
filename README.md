# AgentClear

AgentClear is an outcome-verification and settlement layer for AI-agent commerce on 0G. It binds a structured task agreement to escrow, evidence-backed verification, settlement or refund, and transaction-backed agent reputation.

The repository is under active development. The real local EVM vertical flow now reaches both terminal payment outcomes: create and quote an agreement, fund escrow, assign the provider, store and verify evidence, anchor `PASS` or `FAIL` in `OutcomeRegistry`, release or refund `JobEscrow`, write outcome feedback through the current ERC-8004 `ReputationRegistry` interface, and publish a portable content-addressed receipt. The automated REST flows use PostgreSQL, real signed Anvil transactions, deployed contracts, and explicitly labelled controlled Storage/Compute test adapters because no live 0G credentials are available. Production 0G Storage, 0G Compute, and config-driven ERC-8004 adapters are implemented, but a 0G testnet deployment, live Storage/Compute/reputation proof, sandbox, MCP, and the operator UI remain in progress and are not simulated.

```mermaid
flowchart LR
  Client[Buyer agent / operator] -->|Bearer key + idempotency key| API[Fastify REST API]
  API --> Domain[Canonical agreement + state machine]
  Domain --> DB[(PostgreSQL)]
  DB --> Events[Immutable state events]
  Domain --> Chain[Fund + assign + settle or refund]
  Domain --> Storage[0G Storage evidence adapter]
  Storage --> Verify[Deterministic evidence verification]
  Verify -. when required .-> Compute[0G Compute rubric signal]
  Verify --> Outcome[OutcomeRegistry commitment]
  Outcome --> Chain
  Chain --> Reputation[ERC-8004 reputation feedback]
  Reputation --> Receipt[Portable receipt]
  Receipt --> REST[REST lookup + exact JSON download]
```

## Current stack

- Node.js 24, TypeScript 6, pnpm workspaces, and Turborepo
- Fastify 5 with Zod validation, scoped bootstrap API-key authentication, request IDs, stable errors, and rate limiting
- PostgreSQL 17 with Drizzle ORM and checked SQL migrations
- viem-based, config-driven ERC-8004 identity/reputation adapter using the current registry ABI
- `@0gfoundation/0g-storage-ts-sdk` 1.2.11 with `ethers` 6.13.1 for content-addressed evidence
- `@0gfoundation/0g-compute-ts-sdk` 0.9.0 with a dedicated wallet for rubric verification
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

The API listens on `http://127.0.0.1:3001` by default. Versioned routes require `Authorization: Bearer <BOOTSTRAP_API_KEY>`. Mutating job routes require an `Idempotency-Key` header. Funding and assignment remain disabled unless the complete optional chain group in `.env.example` is configured; outcome anchoring and final settlement additionally require `OUTCOME_REGISTRY_ADDRESS`. Transaction-backed reputation requires both ERC-8004 registry addresses. Provider submission requires the distinct provider bootstrap credential pair and `STORAGE_INDEXER_URL`; the provider agent ID must exactly match the assigned job. AI verification additionally requires the complete `COMPUTE_*` group and a dedicated funded wallet that is not the protocol chain signer.

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
- `packages/contracts` -- native-asset escrow, outcome commitments, and Foundry security tests
- `packages/chain` -- viem escrow/outcome/ERC-8004 transaction preparation, broadcast, confirmation, and state attestation
- `packages/domain` -- canonical agreements, state machine, commitments, deterministic verification, and application services
- `packages/db` -- Drizzle schema, migrations, and PostgreSQL repository adapter
- `packages/config` -- strict environment validation
- `packages/compute` -- current 0G Compute SDK provider preflight, paid inference, and response verification adapter
- `packages/storage` -- 0G Storage upload, proof retrieval, and byte-integrity adapter
- `.0g-skills` -- vendored 0G reference material; current official docs and installed package source remain higher authority
- `docs` -- architecture, API, contracts, security, and testing notes matching implemented behavior

See [`AGENTS.md`](./AGENTS.md) for the full product definition, [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for current boundaries, [`docs/STORAGE.md`](./docs/STORAGE.md) and [`docs/COMPUTE.md`](./docs/COMPUTE.md) for the exact 0G integrations, [`docs/ERC8004.md`](./docs/ERC8004.md) for verified registry sources and configuration, and [`docs/RECEIPTS.md`](./docs/RECEIPTS.md) for receipt integrity and retrieval.

No live contract address, transaction hash, 0G Storage reference, Compute receipt, or ERC-8004 deployment is published yet because none has been exercised on 0G testnet from this repository.
