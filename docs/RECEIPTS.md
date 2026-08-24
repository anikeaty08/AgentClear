# Portable receipts

AgentClear publishes one versioned receipt after a job has a cryptographically consistent final outcome. The receipt is an application proof bundle, not a claim that all source evidence is stored on-chain.

## Publication rules

A receipt can be created only when these durable records agree:

- the job is `PAID` with a `PASS` verification and ERC-8004 value `100`, or `REFUNDED` with a `FAIL` verification and value `0`;
- the assigned provider, submission, verification run, and settlement operation reference one another;
- agreement, submission, and report commitments match the confirmed settlement operation;
- outcome and escrow transaction hashes match the payment/refund row;
- the reputation feedback URI references the verification report's content-addressed Storage root.

The caller supplies only an empty body. Receipt fields are derived from confirmed state.

## Integrity model

The service serializes the version-1 object with AgentClear canonical JSON, computes SHA-256 over its UTF-8 bytes, and persists both before Storage I/O. A retry revalidates the byte count, hash, JSON schema, receipt ID, and job ID before uploading the same bytes. Publication completes only after the Storage adapter verifies the upload.

The durable record contains:

- agreement, submission, and verification commitments;
- submission and verification-report Storage references;
- outcome-registry and escrow transaction proofs;
- the transaction-backed ERC-8004 feedback reference;
- finalization and issuance timestamps;
- receipt hash and receipt Storage publication metadata.

`GET /v1/receipts/:id/download` returns the exact canonical bytes. Consumers should compute SHA-256 and compare `0x<digest>` with `receiptHash`. The Storage root is separately recorded because the current 0G Storage content root need not equal the plain SHA-256 digest.

## Recovery and availability

`POST /v1/jobs/:id/receipt` resumes an interrupted publication with the original idempotency key. A separate key cannot create a second receipt. Publication shares the external-write lock used by chain and Storage operations, preventing nonce or upload races across API instances.

The local integration suite verifies this contract with a controlled content-addressed adapter. No receipt in this repository should be described as live 0G proof until its Storage reference is exercised and published from configured 0G infrastructure.
