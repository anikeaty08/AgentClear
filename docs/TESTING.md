# Testing

## Unit gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
forge fmt --check --root packages/contracts
forge test --root packages/contracts -vvv
```

Unit coverage exercises configuration validation, the explicit job state machine, deadline validation, lossless budget conversion, canonical agreement commitments, idempotent replay/conflict behavior, API authentication, request validation, stable errors, and create/read transport behavior.

The Foundry suite covers access control, funding, optional provider assignment, cancellation before assignment, one-time settlement/refund, expiry races, dispute freezing/resolution, fee math, pull withdrawals, direct-transfer rejection, and a reentrancy attempt. Fuzz tests run 512 cases. Stateful invariants run 256 sequences of 500 calls and require native balance and tracked liabilities to remain equal across arbitrary lifecycle operations.

## PostgreSQL integration

```bash
docker compose up -d postgres
pnpm test:integration
```

The command applies checked migrations and runs integration packages sequentially against the one local database. Tests verify atomic job/event/requirement/idempotency persistence and the authenticated HTTP create/replay/read path.

Integration tests are not evidence of 0G testnet behavior. Separate opt-in suites will be added for real chain, Storage, Compute, and ERC-8004 calls once those adapters and test credentials exist.
