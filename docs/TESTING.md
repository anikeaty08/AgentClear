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

Unit coverage exercises configuration validation, the explicit job state machine, deadline validation, lossless budget conversion, canonical agreement commitments, funding, assignment and submission recovery, provider authorization, evidence size/integrity checks, explicit deterministic/sandbox-check validation, rubric validation, canonical Compute prompt commitments, integer weighted scoring, hard-gate consensus, reputation outcome derivation/replay guards, portable receipt derivation/hash/replay guards, idempotent replay/conflict behavior, API authentication, request validation, stable errors, and create/read transport behavior. Storage unit tests use the real SDK `MemData` Merkle implementation behind a controlled transport; they verify upload options, proof retrieval, and byte mismatch rejection without claiming a live network call. Compute unit tests inject the SDK broker and HTTP boundary to verify provider/model/TEE/account preflight, billing headers, structured response parsing, `processResponse`, response limits, and endpoint guards without claiming a live inference. Sandbox unit tests inspect digest enforcement, every isolation/resource flag, size rejection, path bridging, timeout reporting, image health, and force-removal.

The Foundry suite covers access control, funding, optional provider assignment, cancellation before assignment, one-time settlement/refund, expiry races, dispute freezing/resolution, fee math, pull withdrawals, direct-transfer rejection, and a reentrancy attempt. Fuzz tests run 512 cases. Stateful invariants run 256 sequences of 500 calls and require native balance and tracked liabilities to remain equal across arbitrary lifecycle operations.

## PostgreSQL integration

```bash
docker compose up -d postgres
pnpm test:integration
```

The command applies checked migrations and runs integration packages sequentially. PostgreSQL tests verify atomic job/event/requirement/idempotency persistence, recovery from failed funding and assignment broadcasts using stored signed transactions, rejection of unrelated signer work while an operation is unresolved, and cross-pool serialization by the session advisory executor. The chain integration test starts an ephemeral Anvil node, deploys the compiled `JobEscrow`, funds a newly generated local signer, prepares and rebroadcasts one signed funding transaction, verifies its receipt and value, reads the resulting escrow state, and assigns a provider through a second real transaction.

The API integration suite composes authenticated HTTP, PostgreSQL, viem signing/broadcast, deployed Anvil escrow/outcome/ERC-8004-compatible contracts, receipt/state attestation, provider assignment, submission, verification, reputation, portable receipt publication, and exact replay. It uses deliberately labelled content-addressed evidence, controlled-AI, and controlled-sandbox port adapters. The successful full flow declares executable vectors, submits module files, records the sandbox signal in the canonical report, and proves idempotent verification invokes the execution boundary once. It exercises both complete settlement branches and separately proves an AI rubric signal is persisted with its prompt hash while an idempotent replay invokes the potentially paid boundary only once. It verifies both outcome commitments on-chain, escrow terminal state, parsed/read-back feedback, one payment/refund row, one reputation event, one receipt, duplicate-finalization rejection, exact replay/recovery, REST lookup, exact JSON download, receipt hash recomputation, and removal of canonical recovery/signed-transaction payloads after confirmation. These adapters do not substitute for or claim live 0G Storage, Compute, or ERC-8004 network verification.

The lower-level chain integration also deploys `OutcomeRegistry` and controlled exact-interface ERC-8004 registry fixtures. It persists and rebroadcasts signed outcome/feedback transactions, reads back every commitment and feedback field, rejects self-feedback, and releases escrow through the real gateway. Together with the API suite this proves local application orchestration, not a 0G deployment.

Foundry 1.7.1 must be available on `PATH` for the Anvil integration test. No test private key is committed; the signer is generated in memory for each run.

Integration tests are not evidence of 0G testnet behavior. A separate opt-in Storage suite and published artifact/transaction reference will be required once test credentials exist; equivalent live checks remain required for chain, Compute, and ERC-8004.

The opt-in real-container suite is independent of PostgreSQL:

```powershell
$env:SANDBOX_INTEGRATION_IMAGE='node@sha256:<64-hex-digest>'
$env:SANDBOX_INTEGRATION_CLI='wsl-docker' # local Windows only
pnpm --filter @agentclear/sandbox test:integration
```

It executes real provider modules inside disposable containers, asserts loopback-only networking, proves an infinite loop is terminated, and rejects a module that prints a forged success report before exiting. See `docs/SANDBOX.md` for the exact boundary and the digest exercised locally.
