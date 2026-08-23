# 0G Compute verification

AgentClear uses `@0gfoundation/0g-compute-ts-sdk` 0.9.0 for rubric and AI verification. The deprecated `@0glabs/0g-serving-broker` package is not used.

## Configuration

Configure the complete group or leave it blank:

```text
COMPUTE_RPC_URL
COMPUTE_SIGNER_PRIVATE_KEY
COMPUTE_PROVIDER_ADDRESS
COMPUTE_MODEL                    # optional; provider default otherwise
COMPUTE_TIMEOUT_MS               # default 120000
COMPUTE_MAX_RESPONSE_BYTES       # default 1048576
COMPUTE_REQUIRE_TEE              # default true
```

The Compute signer must be a dedicated wallet and must not equal the protocol chain writer. It needs a funded 0G Compute provider sub-account. Provider and model values are configuration, never hardcoded application addresses. Do not put either signer key in browser code, logs, MCP inputs, or git.

## Request flow

1. The frozen agreement supplies a rubric whose unique criterion weights total exactly 10,000 basis points.
2. Domain code creates canonical prompt JSON and commits it with SHA-256.
3. The adapter confirms the selected provider is registered as a chatbot, its configured model is advertised, its TEE signer is acknowledged when required, and the caller provider account has balance.
4. The SDK supplies service metadata and signed billing headers.
5. AgentClear sends one timeout-bounded OpenAI-compatible `/chat/completions` request and accepts at most the configured response byte limit.
6. The adapter calls SDK `processResponse` with `ZG-Res-Key` (falling back to the completion ID) and exact usage JSON.
7. Zod accepts only strict JSON criterion results. Domain code recomputes the weighted score and confidence; model-supplied totals cannot disagree.
8. Provider, model, chat ID, prompt version/hash, usage, raw response, parsed criteria, confidence, and SDK verification result are written into the canonical verification report and stored as evidence.

No centralized-model fallback exists. Missing Compute configuration returns `COMPUTE_UNAVAILABLE` for agreements that require it.

## Decision policy

Signals are hard gates, not blindly averaged:

```text
deterministic hard failure                         -> FAIL
deterministic score below threshold (combined)    -> FAIL
SDK response verification false                   -> NEEDS_REVIEW
TEE verification required but unavailable         -> NEEDS_REVIEW
all required deterministic and AI signals pass    -> PASS
AI score below threshold                          -> FAIL
```

For `deterministic_plus_ai`, the displayed aggregate score is the lower signal. This prevents a high subjective score from masking a deterministic miss.

## Paid-call recovery

Verification operations use:

```text
CREATED -> COMPUTING -> EVALUATED -> STORING -> CONFIRMED
```

The prompt hash is committed before dispatching a potentially paid inference. If the process stops while `COMPUTING`, AgentClear returns `COMPUTE_RECONCILIATION_REQUIRED` instead of sending another paid request. Automated provider-side reconciliation is still required before production release; an operator must inspect the committed run/chat evidence and explicitly recover it.

The adapter blocks non-HTTPS, loopback, link-local, and private-literal provider endpoints. Full DNS-rebinding-resistant endpoint pinning remains a production-hardening item. Provider selection should remain restricted to verified, acknowledged 0G deployments.

Unit tests use an injected broker and HTTP boundary. API integration uses a deliberately named controlled AI verifier to prove orchestration and persistence; neither claims a live 0G Compute request. Live proof requires a funded Compute wallet and must record the real provider/model/chat verification metadata.
