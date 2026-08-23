# Testing

## Unit gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Unit coverage currently exercises configuration validation, the explicit job state machine, deadline validation, lossless budget conversion, canonical agreement commitments, idempotent replay/conflict behavior, API authentication, request validation, stable errors, and create/read transport behavior.

## PostgreSQL integration

```bash
docker compose up -d postgres
pnpm test:integration
```

The command applies checked migrations and runs integration packages sequentially against the one local database. Tests verify atomic job/event/requirement/idempotency persistence and the authenticated HTTP create/replay/read path.

Integration tests are not evidence of 0G testnet behavior. Separate opt-in suites will be added for real chain, Storage, Compute, and ERC-8004 calls once those adapters and test credentials exist.

