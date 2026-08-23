# Contracts

## JobEscrow

`packages/contracts/src/JobEscrow.sol` is a non-upgradeable native-asset escrow intended for 0G Chain. No payment token, contract address, RPC endpoint, or explorer URL is hardcoded.

Lifecycle:

```text
fund (optional provider)
  |-- unassigned -> assign once by buyer -> settle / fail refund / dispute
  |-- unassigned -> buyer cancellation -> refund credit
  |-- funded and expired -> permissionless refund credit
  `-- disputed -> authorized release or refund
```

Settlement and dispute authorities are distinct OpenZeppelin roles. The default administrator uses a delayed two-step transfer. Deployment must use separate operational addresses for the administrator, settlement authority, dispute authority, and fee recipient.

Finalization uses pull payments. A successful settlement credits the provider and fee recipient; a refund credits the buyer. Each account withdraws its own credit to a chosen recipient. This prevents a reverting recipient from blocking the state transition and keeps the accounting invariant explicit:

```text
contract native balance == total escrowed + total pending withdrawals
```

Unexpected direct native transfers revert. Forced native transfers can make the balance exceed liabilities but cannot reduce user claims.

## OutcomeRegistry

`packages/contracts/src/OutcomeRegistry.sol` is a non-upgradeable commitment registry. An explicitly authorized writer can record one final `PASS` or `FAIL` per job. Each record binds the job key to agreement, submission, verification-report, buyer-identity, and provider-identity hashes plus the finalization time. Zero hashes, non-final outcomes, unauthorized writes, and duplicate finalization revert.

The companion viem gateway signs before broadcast, supports exact raw-transaction replay, waits for confirmation, reads the stored record, and attests every commitment. Contract and gateway behavior are exercised on Anvil. The application has not yet orchestrated this write with escrow settlement, so it is not described as an end-to-end anchored outcome yet.

## Verification status

Both contracts have been compiled and exercised locally with Foundry 1.7.1 and Solidity 0.8.24. The test suite includes unit, revert-path, fuzz, reentrancy, access-control, duplicate-write, and stateful invariant coverage. They have not been independently audited and have not yet been deployed to 0G testnet. Until deployment transactions and resulting bytecode are verified, no repository documentation will present an address as live.

Run:

```bash
forge fmt --check --root packages/contracts
forge test --root packages/contracts -vvv
```
