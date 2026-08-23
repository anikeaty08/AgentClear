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

## Verification status

The contract has been compiled and exercised locally with Foundry 1.7.1 and Solidity 0.8.24. The test suite includes unit, revert-path, fuzz, reentrancy, and stateful invariant coverage. It has not been independently audited and has not yet been deployed to 0G testnet. Until a deployment transaction and resulting bytecode are verified, no repository documentation will present an address as live.

Run:

```bash
forge fmt --check --root packages/contracts
forge test --root packages/contracts -vvv
```
