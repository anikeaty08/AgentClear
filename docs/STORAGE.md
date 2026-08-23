# 0G Storage integration

## Implemented adapter

`packages/storage` uses the current official `@0gfoundation/0g-storage-ts-sdk` 1.2.11 package and its required `ethers` 6.13.1 peer. The vendored `.0g-skills` Storage examples still reference `@0glabs/0g-ts-sdk`; official current documentation, the official repository, and installed package types take precedence, so AgentClear does not use the deprecated package name.

The SDK currently depends on `open-jsonrpc-provider` 0.2.1, whose Axios range resolves to a release with published high-severity advisories, while the SDK-pinned Ethers release permits an affected `ws`. Root pnpm overrides force Axios 1.19.0 and `ws` 8.21.3. The provider's HTTP usage is compatible with the current Axios request API, and the repository exercises the resulting SDK tree through lint, type checks, unit tests, build, and dependency audit. These overrides should be removed when the upstream packages publish safe minimums.

For each bounded canonical submission manifest the adapter:

1. creates SDK `MemData` from the exact persisted bytes;
2. computes its Merkle root before upload;
3. calls `Indexer.upload` with `skipTx: true`, `skipIfFinalized: true`, `finalityRequired: true`, and one expected replica;
4. requires a single-file result whose root equals the locally computed root;
5. calls `downloadToBlob(root, { proof: true })`; and
6. byte-compares the retrieved content with the submitted content.

An empty transaction hash is represented as `null` because finalized content may already exist and be reused. A fragmented response is rejected for the current payload bound rather than silently changing the receipt shape.

## Configuration

Storage is enabled only when `STORAGE_INDEXER_URL` is set together with the complete chain group. It reuses `CHAIN_RPC_URL`, `CHAIN_SIGNER_PRIVATE_KEY`, and the PostgreSQL-backed exclusive signer executor. `STORAGE_MAX_PAYLOAD_BYTES` defaults to 262,144 bytes and may be configured from 1 KiB through 1 MiB.

When Storage is disabled, the submission mutation returns `STORAGE_UNAVAILABLE`; it never stores a fake root. When configured but unhealthy, `/ready` reports a degraded Storage dependency without exposing credentials.

## Verification status

Unit tests use the real SDK Merkle implementation with a controlled transport. The end-to-end local API test uses an explicitly labelled `EvidenceStorage` test adapter so it remains deterministic. No live 0G Storage upload, retrieval, transaction, or public root has been exercised from this repository yet because no test credential is configured. A live opt-in test must upload, proof-download, byte-compare, and publish the resulting root and transaction metadata before this integration is described as network-verified.
