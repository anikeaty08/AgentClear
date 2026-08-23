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

Unit coverage exercises configuration validation, the explicit job state machine, deadline validation, lossless budget conversion, canonical agreement commitments, funding, assignment and submission recovery, provider authorization, evidence size/integrity checks, idempotent replay/conflict behavior, API authentication, request validation, stable errors, and create/read transport behavior. Storage unit tests use the real SDK `MemData` Merkle implementation behind a controlled transport; they verify upload options, proof retrieval, and byte mismatch rejection without claiming a live network call.

The Foundry suite covers access control, funding, optional provider assignment, cancellation before assignment, one-time settlement/refund, expiry races, dispute freezing/resolution, fee math, pull withdrawals, direct-transfer rejection, and a reentrancy attempt. Fuzz tests run 512 cases. Stateful invariants run 256 sequences of 500 calls and require native balance and tracked liabilities to remain equal across arbitrary lifecycle operations.

## PostgreSQL integration

```bash
docker compose up -d postgres
pnpm test:integration
```

The command applies checked migrations and runs integration packages sequentially. PostgreSQL tests verify atomic job/event/requirement/idempotency persistence, recovery from failed funding and assignment broadcasts using stored signed transactions, rejection of unrelated signer work while an operation is unresolved, and cross-pool serialization by the session advisory executor. The chain integration test starts an ephemeral Anvil node, deploys the compiled `JobEscrow`, funds a newly generated local signer, prepares and rebroadcasts one signed funding transaction, verifies its receipt and value, reads the resulting escrow state, and assigns a provider through a second real transaction.

The API integration suite composes the real layers: authenticated HTTP create and quote, PostgreSQL funding intent, viem signing/broadcast, deployed Anvil escrow, receipt/state attestation, provider assignment, and exact idempotent replay. It then uses a deliberately labelled in-process `EvidenceStorage` test adapter to verify provider-only submission authorization, durable evidence metadata, `ASSIGNED -> IN_PROGRESS -> SUBMITTED`, replay without a second upload, and removal of the canonical payload after confirmation. This test does not substitute for or claim live 0G Storage verification.

Foundry 1.7.1 must be available on `PATH` for the Anvil integration test. No test private key is committed; the signer is generated in memory for each run.

Integration tests are not evidence of 0G testnet behavior. A separate opt-in Storage suite and published artifact/transaction reference will be required once test credentials exist; equivalent live checks remain required for chain, Compute, and ERC-8004.
