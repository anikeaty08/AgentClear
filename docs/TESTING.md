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

Unit coverage exercises configuration validation, the explicit job state machine, deadline validation, lossless budget conversion, canonical agreement commitments, funding and assignment recovery, provider constraints, idempotent replay/conflict behavior, API authentication, request validation, stable errors, and create/read transport behavior.

The Foundry suite covers access control, funding, optional provider assignment, cancellation before assignment, one-time settlement/refund, expiry races, dispute freezing/resolution, fee math, pull withdrawals, direct-transfer rejection, and a reentrancy attempt. Fuzz tests run 512 cases. Stateful invariants run 256 sequences of 500 calls and require native balance and tracked liabilities to remain equal across arbitrary lifecycle operations.

## PostgreSQL integration

```bash
docker compose up -d postgres
pnpm test:integration
```

The command applies checked migrations and runs integration packages sequentially. PostgreSQL tests verify atomic job/event/requirement/idempotency persistence, recovery from failed funding and assignment broadcasts using stored signed transactions, and rejection of unrelated signer work while a signed operation is unresolved. The chain integration test starts an ephemeral Anvil node, deploys the compiled `JobEscrow`, funds a newly generated local signer, prepares and rebroadcasts one signed funding transaction, verifies its receipt and value, reads the resulting escrow state, and assigns a provider through a second real transaction.

The API integration suite composes the real layers: authenticated HTTP create and quote, PostgreSQL funding intent, viem signing/broadcast, deployed Anvil escrow, receipt/state attestation, `FUNDED -> OPEN -> ASSIGNED`, and exact idempotent replay for both writes. It also verifies the provider stored by the contract and asserts that serialized signed transactions never appear in REST responses.

Foundry 1.7.1 must be available on `PATH` for the Anvil integration test. No test private key is committed; the signer is generated in memory for each run.

Integration tests are not evidence of 0G testnet behavior. Separate opt-in suites will be added for real chain, Storage, Compute, and ERC-8004 calls once those adapters and test credentials exist.
