# AGENTS.md — AgentClear / Proof-of-Outcome Buildathon Product

> **Purpose:** This file is the operating contract for Codex (or another coding agent) building this repository.
>
> **Product:** AgentClear — a verifiable clearing and settlement layer for AI-agent work on 0G.
>
> **Core promise:** An agent should be able to delegate a task with a budget and explicit success criteria, escrow payment, receive work from another agent, verify the outcome, settle automatically, and write transaction-backed reputation.
>
> **Rule zero:** Do not build a generic agent marketplace. Build the **trust + verification + settlement infrastructure** that any agent marketplace, MCP client, or application can use.

---

## 0. How the coding agent must behave

You are the senior product engineer, protocol engineer, security reviewer, QA engineer, and release engineer for this repository.

Do not stop at scaffolding, mock screens, or TODO comments if the required behavior can be implemented now.

Before changing code:

1. Read this file completely.
2. Inspect the current repository structure.
3. Read existing package manifests, env examples, contracts, migrations, tests, and deployment scripts.
4. Reuse existing abstractions when they are sound.
5. Make a short internal implementation plan.
6. Implement the smallest complete vertical slice first.
7. Run the relevant checks after every meaningful change.
8. Fix failures before proceeding.
9. Never silently downgrade a real integration to a mock.
10. Never claim an integration works unless it was actually exercised or the limitation is explicitly documented.

### Do not guess APIs

For any framework, SDK, protocol, or 0G integration that may have changed:

1. Use current official documentation first.
2. Use Context7 when available.
3. Inspect the installed package types/source if docs are ambiguous.
4. Consult the vendored 0G skills for patterns.
5. Only then rely on model memory.

**Authority order:**

```text
current official docs / package source
    >
Context7 current docs
    >
vendored 0G Agent Skills
    >
existing project examples
    >
model memory
```

If two sources conflict, prefer the higher source and document the discrepancy in the PR/commit notes.

### Never invent protocol support

Do not invent:
- contract addresses
- SDK methods
- token addresses
- RPC endpoints
- MCP methods
- 0G Pay APIs
- ERC-8004 registry deployments
- wallet capabilities
- explorer URLs

Verify all of them before use.

---

# 1. Product definition

## 1.1 The problem

AI agents can increasingly:
- discover other agents
- call tools
- use MCP
- make payments
- return outputs

The missing layer is:

> **How does the buyer know the work was actually completed correctly before payment settles?**

A star rating is not enough.

A payment receipt only proves payment occurred.

A model-generated review is not enough.

AgentClear makes reputation come from **real paid outcomes with verifiable success criteria**.

---

## 1.2 Product sentence

> **AgentClear is an outcome-verification and settlement layer for AI-agent commerce: escrow payment, verify delivered work, settle on success, refund on failure, and record transaction-backed reputation on 0G.**

---

## 1.3 What we are NOT building

Do not turn the product into:

- Fiverr for agents
- a chat app
- a generic agent directory
- a token launch
- a DAO
- a social network
- a simple ratings dashboard
- a wrapper around an LLM judge
- a smart-contract-only demo
- a static mock interface

Agent discovery can exist, but it is a supporting surface.

The core system is:

```text
TASK AGREEMENT
      ↓
ESCROW
      ↓
PROVIDER AGENT
      ↓
OUTPUT
      ↓
OUTCOME VERIFICATION
      ↓
PASS / FAIL / REVIEW
      ↓
SETTLEMENT
      ↓
VERIFIABLE RECEIPT
      ↓
REPUTATION UPDATE
```

---

# 2. Product principles

1. **Success conditions are first-class data.**
2. **Payment must be linked to an outcome.**
3. **Reputation must be linked to a real transaction.**
4. **Deterministic verification beats subjective AI judgment whenever possible.**
5. **AI verification is a signal, not magic truth.**
6. **No untrusted code runs on the host machine.**
7. **The blockchain stores commitments/state, not giant payloads.**
8. **0G must be used where it creates real value, not as decoration.**
9. **Humans should be able to inspect every automated decision.**
10. **Machine access through MCP/API is as important as the web UI.**
11. **Every important state transition must be observable and testable.**
12. **A beautiful demo is useful only if the underlying flow is real.**

---

# 3. Primary user types

## 3.1 Buyer / requester agent

An agent that wants work done.

Examples:
- coding agent
- research agent
- data transformation agent
- content agent
- trading/research workflow agent
- enterprise orchestration agent

It specifies:
- task
- budget
- deadline
- success criteria
- verification mode
- provider or discovery requirements

---

## 3.2 Provider agent

An agent that performs the work.

It:
- has an identity
- advertises capabilities
- accepts jobs
- submits structured results
- receives payment after verification
- accumulates verified reputation

---

## 3.3 Human operator / developer

A human controls:
- budgets
- API keys
- agents
- disputes
- policies
- job inspection
- webhooks
- billing
- deployment

The web product is primarily the operator console.

---

## 3.4 Validator / verifier

A verifier can be:
- deterministic test runner
- schema validator
- policy engine
- AI judge on 0G Compute
- multiple independent verifier models
- human reviewer
- external oracle or service

A verifier produces signed/anchored evidence.

---

# 4. Canonical task agreement

Every job must have a structured agreement.

Do not rely only on free-form text.

Example:

```json
{
  "jobId": "job_01J...",
  "buyerAgentId": "erc8004:16661:123",
  "providerAgentId": "erc8004:16661:456",
  "title": "Implement transaction sorter",
  "description": "Implement the requested TypeScript function.",
  "budget": {
    "token": "configured-payment-token",
    "maxAmount": "2.00"
  },
  "deadline": "2026-08-23T16:00:00Z",
  "deliverable": {
    "type": "code",
    "format": "git_patch"
  },
  "verification": {
    "mode": "deterministic_plus_ai",
    "minimumScore": 0.90,
    "requirements": [
      "TypeScript",
      "No external dependencies",
      "All hidden tests must pass",
      "Execution under 100ms for supplied benchmark"
    ]
  },
  "refundPolicy": {
    "onExpiry": true,
    "onFinalFailure": true
  }
}
```

All machine interfaces must map to this canonical domain model.

---

# 5. Job state machine

Use an explicit enum/state machine.

Do not represent critical state using loose booleans.

```text
DRAFT
  ↓
QUOTED
  ↓
FUNDED
  ↓
OPEN
  ↓
ASSIGNED
  ↓
IN_PROGRESS
  ↓
SUBMITTED
  ↓
VERIFYING
  ↓
 ┌──────────┬───────────┬─────────────┐
 ↓          ↓           ↓
PASSED     FAILED      NEEDS_REVIEW
 ↓          ↓           ↓
SETTLING   RETRY       DISPUTED
 ↓          ↓           ↓
PAID      FAILED_FINAL  RESOLVED
              ↓
           REFUNDED
```

Other terminal states:
- CANCELLED
- EXPIRED
- REFUNDED

Every transition must have:
- actor
- timestamp
- reason
- optional transaction hash
- optional evidence reference
- audit event

---

# 6. Verification modes

Verification is the heart of the product.

## 6.1 Deterministic verification

Use whenever possible.

Examples:
- unit tests
- integration tests
- JSON Schema validation
- exact output constraints
- checksum validation
- executable test vectors
- expected database state
- signed external response
- latency threshold
- numerical tolerance

Deterministic checks should dominate the score where applicable.

---

## 6.2 Rubric verification

For outputs that are structured but not fully deterministic.

A rubric must be machine-readable.

Example:

```json
{
  "criteria": [
    {
      "id": "factuality",
      "weight": 0.40,
      "description": "Claims are supported by supplied sources."
    },
    {
      "id": "coverage",
      "weight": 0.30,
      "description": "All requested sections are addressed."
    },
    {
      "id": "format",
      "weight": 0.20,
      "description": "Output follows the requested schema."
    },
    {
      "id": "clarity",
      "weight": 0.10,
      "description": "Output is understandable and concise."
    }
  ]
}
```

---

## 6.3 AI judge

Use 0G Compute when AI judgment is needed.

Requirements:
- structured JSON output
- explicit rubric
- model/provider metadata
- prompt/version hash
- retry policy
- timeout
- confidence/score
- raw report stored as evidence
- no silent fallback to an unrelated centralized model in production/demo

If a fallback exists for local development, label it visibly in logs and UI.

---

## 6.4 Multi-verifier consensus

For higher-value jobs support:
- 2+ independent verifier runs
- deterministic + AI combination
- disagreement detection
- human escalation

Do not average scores blindly.

Example policy:

```text
deterministic hard failure → FAIL
security hard failure      → FAIL
deterministic pass +
AI score >= threshold      → PASS
verifier disagreement      → NEEDS_REVIEW
```

---

## 6.5 Human review

Required for:
- disputes
- ambiguous evidence
- suspicious verification behavior
- high-value jobs above configurable threshold
- destructive or irreversible external actions

Human review can be centralized for the buildathon product.

Do not pretend it is decentralized arbitration.

---

# 7. Untrusted-code sandbox

If the provider submits executable code, never execute it directly on the API host.

Minimum sandbox properties:
- isolated container/process
- no host filesystem access
- no secrets mounted
- no production credentials
- network disabled by default
- CPU limit
- memory limit
- execution timeout
- process count limit
- output size limit
- read-only base image where practical
- disposable workspace
- complete execution log

The verifier must return:
- exit code
- stdout/stderr summary
- test count
- passed/failed tests
- duration
- resource usage where available
- artifact hash

Mocks are acceptable in unit tests.
Mocks are not acceptable as the final buildathon integration path.

---

# 8. 0G architecture

0G is not a branding layer. Each component must have a real job.

## 8.1 0G Chain

Use 0G Chain for:
- escrow state
- job commitments
- settlement
- refunds
- dispute holds
- result/evidence hashes
- proof/receipt anchoring
- reputation-linked events
- ERC-8004 identity and reputation integration

Do not put full prompts, giant outputs, or raw evidence on-chain.

---

## 8.2 0G Storage

Use 0G Storage for:
- task spec snapshots
- provider deliverables
- execution logs
- verification reports
- rubric snapshots
- evidence manifests
- cryptographic receipt bundles

Store content-addressed references/hashes in the application DB and chain.

---

## 8.3 0G Compute

Use the current official 0G Compute TypeScript SDK.

At the time this file was authored, the current package is:

```bash
@0gfoundation/0g-compute-ts-sdk
```

The older:

```bash
@0glabs/0g-serving-broker
```

is deprecated/re-exporting and must not be chosen for new code unless current official docs explicitly require it.

Use Compute for:
- rubric evaluation
- semantic result comparison
- fraud/anomaly analysis
- verifier reasoning
- optional task normalization

---

## 8.4 ERC-8004

0G currently exposes canonical ERC-8004 IdentityRegistry and ReputationRegistry deployments.

Important:
- treat ERC-8004 as an evolving/draft standard
- verify addresses from current official 0G/ERC-8004 sources before deployment
- do not hardcode addresses in application logic
- load them from chain config
- support testnet/mainnet config separately

Use:
- IdentityRegistry for portable agent identity/discovery
- ReputationRegistry for transaction-backed feedback

**Do not assume an ERC-8004 ValidationRegistry is deployed on 0G unless current official sources confirm it.**

Until then, AgentClear owns its own verification/outcome registry and can later adapter-integrate a standard validation registry.

---

## 8.5 Agentic ID / ERC-7857

Optional but valuable.

Use only if it improves the product:
- provider-agent ownership
- secure agent deployment
- TEE-backed serve proofs
- identity/reputation linkage

Do not add Agentic ID only to increase integration count.

---

## 8.6 0G Pay

Use only if current official docs expose an integration suitable for this application.

Do not invent an SDK/API.

The core escrow contract must remain understandable without a proprietary hidden payment assumption.

---

# 9. Smart contracts

Prefer a small number of auditable contracts.

## 9.1 `JobEscrow.sol`

Responsibilities:
- create/fund escrow
- hold buyer funds
- authorize settlement
- refund on expiry/final failure
- freeze during dispute
- collect protocol fee
- prevent reentrancy
- enforce one-time settlement

Must support either:
- native asset, or
- configurable ERC-20 payment token

Do not hardcode a stablecoin address unless current deployment is verified.

Use `SafeERC20` for ERC-20 transfers.

---

## 9.2 `OutcomeRegistry.sol`

Responsibilities:
- anchor job agreement hash
- anchor submission hash
- anchor verification report hash
- store final outcome enum
- emit canonical lifecycle events
- associate outcome with buyer/provider identities

Avoid storing large strings.

---

## 9.3 `ReputationAdapter.sol`

Responsibilities:
- translate successful/failed outcomes into standardized ERC-8004 feedback
- ensure only valid finalized jobs can trigger reputation
- prevent duplicate feedback for the same job
- retain internal mapping from AgentClear job → reputation event

If the current ERC-8004 interface changes, update the adapter, not the whole application.

---

## 9.4 `DisputeController.sol`

Buildathon version may use an authorized resolver role.

Responsibilities:
- open dispute
- freeze settlement
- attach evidence hash
- record decision
- instruct escrow release/refund
- emit resolution event

Do not market centralized resolver logic as decentralized arbitration.

---

# 10. Contract security requirements

Every contract change requires tests.

Must consider:
- reentrancy
- access control
- replay
- double settlement
- double refund
- duplicate reputation
- expired jobs
- cancellation race
- malicious token behavior
- zero address
- fee precision
- denial of service
- front-running where relevant
- signature replay
- chain ID/domain separation
- upgradeability risk

Prefer non-upgradeable contracts for the buildathon unless there is a strong need.

Use Foundry.

Minimum:
- unit tests
- revert-path tests
- fuzz tests for monetary/state invariants
- mainnet/testnet fork tests when practical

---

# 11. Backend architecture

Recommended stack:

```text
TypeScript
Node.js >= 20
Fastify or NestJS
PostgreSQL
Redis
Drizzle or Prisma
Zod
BullMQ or equivalent for background jobs
viem for EVM access
```

Choose one framework and stay consistent.

Do not mix ORMs or web frameworks without a reason.

---

# 12. Service boundaries

Logical services may live in one deployable backend initially.

```text
Auth Service
Agent Service
Job Service
Escrow Service
Verification Service
Sandbox Service
0G Storage Adapter
0G Compute Adapter
Chain Adapter
ERC-8004 Adapter
Reputation Service
MCP Service
Webhook Service
Notification Service
Dispute Service
Risk Service
Audit Service
```

Do not create microservices merely for architecture theater.

A modular monolith is preferred for the buildathon.

---

# 13. Database model

At minimum:

```text
users
organizations
wallets

agents
agent_capabilities
agent_endpoints
agent_chain_identities

jobs
job_requirements
job_state_events
job_assignments

submissions
submission_artifacts

verification_runs
verification_checks
verification_reports

escrows
settlements
refunds

reputation_events

disputes
dispute_events

api_keys
oauth_clients
mcp_sessions
agent_permissions
spending_policies

webhooks
webhook_deliveries

notifications

risk_flags
audit_logs
```

All monetary values use integer base units or lossless decimal handling.
Never use floating-point math for token balances.

---

# 14. REST API

Version every public endpoint.

Core surface:

```text
POST   /v1/jobs
GET    /v1/jobs/:id
GET    /v1/jobs
POST   /v1/jobs/:id/quote
POST   /v1/jobs/:id/fund
POST   /v1/jobs/:id/assign
POST   /v1/jobs/:id/cancel

POST   /v1/jobs/:id/submissions
GET    /v1/jobs/:id/submissions

POST   /v1/jobs/:id/verify
GET    /v1/jobs/:id/verifications

POST   /v1/jobs/:id/disputes
GET    /v1/jobs/:id/disputes

GET    /v1/receipts/:id

POST   /v1/agents
GET    /v1/agents/:id
GET    /v1/agents
GET    /v1/agents/:id/reputation

POST   /v1/api-keys
DELETE /v1/api-keys/:id

POST   /v1/webhooks
GET    /v1/webhooks
DELETE /v1/webhooks/:id
```

Use:
- Zod validation
- idempotency keys for mutating payment/job endpoints
- pagination
- structured errors
- request IDs
- auth scopes
- rate limiting

---

# 15. MCP server — first-class product surface

The project must expose a real MCP server.

Use the current official MCP specification/SDK.

Prefer the official TypeScript SDK.

Do not hand-roll JSON-RPC unless necessary.

Remote deployment should use the current supported HTTP transport.

## 15.1 MCP tools

### `quote_job`

Input:
- task
- success criteria
- max budget
- deadline
- optional provider constraints

Output:
- normalized job
- estimated verification mode
- expected fees
- warnings

### `create_job`

Creates the agreement.

### `fund_job`

Funds the escrow if caller permissions allow.

This is a sensitive tool.
Enforce spending policy.

### `discover_agents`

Returns eligible provider agents using:
- capability
- reputation
- price
- recent success
- availability

### `assign_agent`

Assigns provider with explicit authorization.

### `get_job`

Returns current state.

### `submit_result`

Provider submits a deliverable reference/structured payload.

### `verify_result`

Requests or returns verification state.

Do not expose a tool that lets the provider arbitrarily mark itself passed.

### `cancel_job`

Only valid before the configured lifecycle cutoff.

### `get_agent_reputation`

Returns transaction-backed metrics.

### `get_receipt`

Returns final proof/settlement receipt.

### `list_jobs`

Supports filters.

---

# 16. MCP authorization and spending safety

Never expose raw user private keys to the MCP server.

Use:
- OAuth/token auth
- scoped API keys
- server-side wallet service with strict policy, or
- smart-account/session-key design if implemented correctly

Per-agent spending policy:

```json
{
  "maxPerJob": "5.00",
  "maxPerDay": "25.00",
  "maxPerMonth": "250.00",
  "allowedCapabilities": ["code", "research"],
  "requireHumanApprovalAbove": "10.00"
}
```

Sensitive tool rules:
- `fund_job` requires appropriate scope
- high-value operations require explicit approval
- provider cannot settle its own job
- buyer cannot forge verification result
- all tool calls are auditable

---

# 17. Webhooks

Support:

```text
job.created
job.funded
job.assigned
job.submitted
verification.started
verification.passed
verification.failed
verification.needs_review
settlement.completed
refund.completed
dispute.opened
dispute.resolved
reputation.updated
```

Webhook requirements:
- signed payloads
- retry with exponential backoff
- delivery log
- replay protection/idempotency
- manual retry in developer dashboard

---

# 18. Frontend stack

Recommended:

```text
Next.js
React
TypeScript
Tailwind CSS
shadcn/ui or a consistent accessible component system
TanStack Query
wagmi/viem for wallet connection
```

Priorities:
- responsive
- keyboard accessible
- clear loading/error/empty states
- no layout shift
- no dead controls
- copyable IDs/addresses
- explorer links
- transaction state feedback
- visually strong enough for demo recording

Do not build a generic crypto-dashboard aesthetic by default.

The product should feel like developer infrastructure:
- calm
- precise
- trust-oriented
- evidence-oriented

---

# 19. Full customer-facing page map

Build the complete product progressively.

## Public

### 1. Landing
Must communicate:
- what AgentClear does
- why outcome verification matters
- one strong live example
- “For Agents” CTA
- “For Developers” CTA

### 2. How It Works
Explain:
- agreement
- escrow
- execution
- verification
- settlement
- reputation

### 3. Developers
Overview of:
- REST API
- MCP
- SDK
- webhooks
- authentication

### 4. Docs
Real docs, not lorem ipsum.

---

## Authentication / onboarding

### 5. Sign In
Support practical login + wallet linking.

### 6. Onboarding
Choose:
- operator/developer
- buyer agent
- provider agent

Connect/register identity.

---

## Operator product

### 7. Dashboard
Show:
- active jobs
- verification queue
- settled volume
- success rate
- spend
- agent status
- recent events

### 8. Create Job
Natural-language input plus structured success criteria.

Must make success criteria visible/editable before funding.

### 9. Job Detail
Show:
- lifecycle timeline
- buyer/provider
- agreement
- escrow
- submission
- verifier activity
- chain/storage links
- audit events

### 10. Verification Result
Show:
- PASS / FAIL / REVIEW
- score
- deterministic checks
- AI rubric
- evidence
- report hash
- storage reference
- settlement transaction
- reputation update

This is the most important demo page.

### 11. Job History
Filter:
- active
- passed
- failed
- refunded
- disputed
- expired

### 12. Wallet / Budgets
Show:
- available balance
- committed funds
- spend limits
- agent allowances
- recent settlements/refunds

Do not expose private keys.

---

## Agent surfaces

### 13. Agents
Discovery/search:
- capability
- price
- verified success rate
- paid jobs
- latency
- last active

### 14. Agent Profile
Show:
- ERC-8004 identity
- endpoints
- capabilities
- verified jobs
- transaction-backed reputation
- paid volume
- failure rate
- category-specific metrics
- proof links

Avoid meaningless stars.

### 15. Register / Manage Agent
Configure:
- name
- description
- endpoint
- MCP/A2A endpoint if applicable
- capabilities
- pricing
- wallet/payment destination
- identity registration
- auth secret rotation

---

## Developer surfaces

### 16. Developer Dashboard
Show:
- API usage
- MCP calls
- jobs created
- spend
- errors
- webhook health

### 17. API Keys & MCP
Create/revoke:
- API keys
- OAuth clients
- agent tokens

Show:
- scopes
- spending limits
- last used
- copy-once secret handling

### 18. Webhooks
Create/test/retry webhooks.

### 19. Usage / Billing
Show:
- protocol fees
- verification compute
- chain fees
- job spend
- usage history

---

## Account

### 20. Settings
Tabs:
- profile
- organization
- security
- wallets
- notifications
- developer preferences

No need to make each tab a separate route unless architecture benefits.

---

# 20. Admin / operations pages

These can be protected internal routes.

### Admin 1. Operations
- jobs by state
- stuck jobs
- verification backlog
- chain failures
- storage failures
- compute failures

### Admin 2. Disputes
Evidence side-by-side.
Resolve and record reason.

### Admin 3. Risk
- suspicious agents
- repeated failures
- abuse
- duplicate submissions
- anomalous job creation

### Admin 4. Finance
- escrow totals
- unsettled
- refunds
- protocol fees
- failed transactions

### Admin 5. Integrations
Health:
- 0G RPC
- 0G Storage
- 0G Compute
- ERC-8004
- MCP server
- webhook queue

---

# 21. Reputation model

Never use only a 5-star score.

Track:

```text
completed_paid_jobs
passed_jobs
failed_jobs
disputed_jobs
buyer_dispute_rate
provider_dispute_rate
verified_revenue
average_job_value
success_rate
category_success_rate
p50_latency
p95_latency
deterministic_pass_rate
ai_judge_pass_rate
recent_success_rate
```

Reputation must distinguish:
- number of jobs
- monetary weight
- task category
- recency
- verification strength

Do not let a thousand $0.001 self-dealing jobs equal a legitimate paid history.

Add Sybil resistance heuristics later:
- buyer/provider relationship frequency
- repeated circular payments
- shared funding sources
- suspiciously tiny transactions
- repeated identical outputs

Do not claim full Sybil resistance unless proven.

---

# 22. Receipt / proof object

Every finalized job should produce a portable receipt.

Example:

```json
{
  "version": "1",
  "jobId": "job_...",
  "agreementHash": "0x...",
  "buyerAgent": "erc8004:16661:123",
  "providerAgent": "erc8004:16661:456",
  "submissionHash": "0x...",
  "verification": {
    "outcome": "PASS",
    "score": 0.97,
    "reportRoot": "0x...",
    "storageRef": "..."
  },
  "settlement": {
    "amount": "...",
    "token": "...",
    "txHash": "0x..."
  },
  "reputation": {
    "registry": "...",
    "txHash": "0x..."
  },
  "finalizedAt": "..."
}
```

The receipt should be:
- downloadable JSON
- shareable through a web URL
- queryable through API/MCP
- cryptographically tied to evidence

---

# 23. Authentication

Human/operator:
- email/social authentication is fine
- optional SIWE/wallet linking

Agents/developers:
- API keys
- OAuth where practical
- scoped tokens

Wallet signatures:
- use domain-separated typed data when applicable
- include nonce
- include chain ID
- expiration

Never put private keys in:
- browser localStorage
- logs
- analytics
- committed `.env`
- MCP tool arguments where avoidable

---

# 24. Secrets

Required rules:
- `.env` is ignored
- `.env.example` contains placeholders only
- never log secrets
- mask secrets in UI
- rotate compromised keys
- use separate dev/test/prod keys
- CI secrets stay in CI secret storage

If a private key appears in git history, treat it as compromised.

---

# 25. Observability

Every service should use structured logs.

Include:
- request ID
- job ID
- agent ID where safe
- state transition
- chain tx
- provider
- latency
- error code

Add health endpoints:

```text
/health
/ready
```

Integration health should include:
- DB
- Redis
- 0G RPC
- Storage
- Compute

Never leak credentials in health output.

---

# 26. Error model

Public API errors:

```json
{
  "error": {
    "code": "JOB_NOT_FUNDABLE",
    "message": "The job cannot be funded in its current state.",
    "requestId": "req_..."
  }
}
```

Define stable error codes.

Do not return raw stack traces.

Frontend must map common errors to user-readable messages.

---

# 27. Background jobs

Use a queue for:
- verification runs
- 0G Storage uploads
- webhook delivery
- chain receipt confirmation
- reputation writes
- retries

Jobs must be:
- idempotent
- retryable
- observable
- dead-lettered after configured attempts

Do not retry irreversible on-chain writes blindly.

Use transaction status reconciliation.

---

# 28. Developer SDK

If time permits after REST/MCP are stable, expose a lightweight TypeScript SDK.

Example target ergonomics:

```ts
const job = await agentClear.jobs.create({
  task: "Implement the sorter",
  budget: "2.00",
  successCriteria: {
    tests: "all",
    maxRuntimeMs: 100
  }
});

await agentClear.jobs.fund(job.id);

const result = await agentClear.jobs.waitForFinal(job.id);
```

SDK is a typed wrapper over the public API.

Do not maintain separate business logic in the SDK.

---

# 29. Repository structure

Preferred monorepo:

```text
/
├─ AGENTS.md
├─ README.md
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
│
├─ apps/
│  ├─ web/
│  ├─ api/
│  ├─ mcp/
│  └─ admin/
│
├─ packages/
│  ├─ contracts/
│  ├─ db/
│  ├─ domain/
│  ├─ sdk/
│  ├─ ui/
│  ├─ auth/
│  ├─ chain/
│  ├─ storage/
│  ├─ compute/
│  ├─ erc8004/
│  ├─ verifier/
│  ├─ sandbox/
│  └─ config/
│
├─ infra/
│  ├─ docker/
│  └─ scripts/
│
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ CONTRACTS.md
│  ├─ MCP.md
│  ├─ API.md
│  ├─ SECURITY.md
│  ├─ TESTING.md
│  ├─ DEPLOYMENT.md
│  └─ DEMO.md
│
└─ .0g-skills/
```

Do not create directories with no purpose.

---

# 30. Tooling the coding agent should have

## 30.1 Mandatory: Context7

Purpose:
- current library docs
- current framework APIs
- current SDK examples
- reduce hallucinated/deprecated APIs

Codex plugin path:

```bash
codex plugin marketplace add upstash/context7
codex plugin add context7@context7-marketplace
```

Alternative MCP:

```bash
codex mcp add context7 -- npx -y @upstash/context7-mcp --api-key "$CONTEXT7_API_KEY"
```

Rule for this repository:

> Always use Context7 for setup/configuration/code involving a third-party library whose API is not already proven by local types/tests.

---

## 30.2 Mandatory: Playwright MCP

Purpose:
- test the actual web app
- click through complete flows
- catch broken buttons/routes/forms
- verify responsive behavior
- take screenshots
- exercise wallet-independent UI paths
- validate accessibility tree

Suggested Codex MCP config:

```toml
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]
enabled = true
```

The coding agent must not declare a UI feature done only because `npm run build` passes.

For every primary flow, exercise it through browser automation.

---

## 30.3 Mandatory: 0G Agent Skills

Vendor:

```bash
git clone https://github.com/0gfoundation/0g-agent-skills .0g-skills
```

Use these for:
- 0G Storage patterns
- chain deployment/interactions
- Compute provider flow
- cross-layer examples
- security patterns
- testing patterns

But remember the authority order.

If a vendored skill references a deprecated package and current official docs/package source disagree, update the application according to current official sources.

Do not edit the vendored repository merely to hide a mismatch; document the local integration choice.

---

## 30.4 Optional: read-only 0G Chain MCP

A community 0G Chain MCP can be useful for:
- balances
- transaction lookup
- blocks
- network info
- gas estimation

Use it **read-only**.

Do not provide it with a production/private wallet key.

Do not make it a core application dependency.

Use official SDK/RPC/Explorer for critical deployment verification.

---

## 30.5 Optional: OpenAI Developer Docs MCP

Only needed if this repo uses OpenAI APIs/Codex APIs.

```bash
codex mcp add openaiDeveloperDocs --url https://developers.openai.com/mcp
```

If no OpenAI API is used, do not add unnecessary infrastructure.

---

# 31. Dependency policy

- Use `pnpm`.
- Pin major versions deliberately.
- Prefer actively maintained packages.
- Avoid multiple libraries solving the same problem.
- Do not install packages for trivial helpers.
- Run vulnerability checks.
- Review package install scripts for unfamiliar dependencies.
- Never paste random install commands from low-trust blog posts.

For 0G:
- prefer `0gfoundation` packages where the official package has moved there
- verify package names with current docs
- do not use deprecated packages just because an older example does

---

# 32. CI quality gates

A change is not complete until relevant gates pass.

Root scripts should provide:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

Contracts:

```text
forge fmt --check
forge test
```

Add coverage where useful.

CI should fail on:
- lint errors
- type errors
- unit test failures
- contract failures
- production build failures

Do not make required checks non-blocking just to get green CI.

---

# 33. Test matrix

## Unit
- state machine
- fee math
- score calculation
- permission checks
- schemas
- adapters

## Contract
- funding
- settlement
- refund
- dispute freeze
- duplicate settlement rejection
- access control
- ERC-20 failure modes
- fuzz monetary invariants

## Integration
- DB
- Redis/queue
- 0G RPC
- 0G Storage
- 0G Compute
- ERC-8004
- MCP server

## E2E
At minimum:

### Flow A — successful job
```text
create → fund → assign → submit → verify pass → settle → reputation
```

### Flow B — failed verification
```text
create → fund → assign → bad submission → verify fail → retry/final fail → refund
```

### Flow C — dispute
```text
submit → ambiguous result → dispute → resolver decision → settlement/refund
```

### Flow D — MCP buyer
```text
MCP create_job → fund_job → get_job → get_receipt
```

### Flow E — permission guard
```text
agent exceeds spend limit → rejected
```

---

# 34. Buildathon execution strategy

We intend to cover the full product, but build in **working layers**.

Never start by implementing 20 pages independently.

## Phase 0 — repo and tooling
- monorepo
- lint/typecheck/test
- env/config
- DB
- Context7
- Playwright
- vendored 0G skills

## Phase 1 — vertical proof
Build one real job end to end:

```text
create
→ escrow
→ provider submit
→ deterministic verify
→ 0G Storage evidence
→ 0G Compute verifier
→ settle
→ receipt
→ reputation
```

This is the non-negotiable core.

## Phase 2 — MCP
Expose the same domain flow through MCP.

## Phase 3 — operator UI
Dashboard, create, job detail, result.

## Phase 4 — agent identity/discovery
ERC-8004 + agent profiles.

## Phase 5 — permissions/budgets/webhooks
Developer-grade controls.

## Phase 6 — disputes/risk/admin
Operational completeness.

## Phase 7 — polish
Docs, responsive UI, demo, deployment, analytics.

Do not move to polish while the end-to-end settlement flow is fake/broken.

---

# 35. Buildathon submission constraints

Treat the buildathon requirements as release gates.

Before submission ensure:
- public or judge-accessible GitHub repository
- meaningful commits
- README setup instructions
- actual 0G integration
- 0G Chain deployment proof where required by the current wave
- explorer transaction links
- architecture documentation
- reproduction steps
- demo video no longer than the current program limit
- public project post if required
- no fake metrics
- no fake users presented as traction

The agent must check the current buildathon page before final submission because requirements can change.

---

# 36. Demo scenario

Use a task that is obvious in under 20 seconds.

Recommended:

> Buyer Agent needs a TypeScript function implemented for up to $2. Provider Agent submits code. AgentClear runs hidden tests plus an AI rubric. Payment releases only after the job passes.

Demo:

1. Show buyer agent identity.
2. Create task + success criteria.
3. Fund escrow.
4. Provider submits intentionally failing version.
5. Show verifier fail.
6. Provider submits fixed version.
7. Hidden tests pass.
8. 0G Compute report appears.
9. Evidence/report stored on 0G Storage.
10. Escrow settles on 0G Chain.
11. Show explorer transaction.
12. Show provider reputation changed.
13. Show final receipt.
14. Call `get_receipt` or `get_agent_reputation` from MCP.

The demo should prove the thesis, not just show screens.

---

# 37. UI states that must exist

Every page with remote data needs:

- loading
- empty
- error
- success
- pending transaction
- transaction confirmed
- transaction failed
- retry

Forms need:
- validation
- disabled submitting state
- field-level errors
- server errors
- unsaved state protection where appropriate

Never leave buttons wired to `console.log`.

---

# 38. Accessibility

Minimum:
- semantic HTML
- keyboard navigation
- focus states
- form labels
- dialog focus trapping
- accessible error messages
- sufficient contrast
- no essential information conveyed by color alone

Use Playwright accessibility snapshots for critical screens.

---

# 39. Performance

Avoid premature optimization, but:
- paginate job/agent lists
- avoid shipping secrets or server SDKs to browser
- cache safe reads
- lazy-load expensive client views
- compress large reports
- do not poll aggressively when webhooks/events can be used
- index DB columns used by job state/agent/reputation queries

---

# 40. Data integrity

Use:
- UUID/ULID-style IDs
- unique constraints
- foreign keys
- transaction boundaries
- optimistic/row locking where state transitions race
- idempotency records
- immutable audit events

A job state change and corresponding payment/reputation event must not drift silently.

---

# 41. Chain reconciliation

Blockchain writes can fail after backend state changes.

Implement reconciliation:
- pending tx table
- confirmations
- failed tx retry policy
- duplicate transaction protection
- reorg-safe confirmation threshold where appropriate
- operator visibility

Never display `PAID` only because a transaction was submitted.
Display paid only after configured confirmation.

---

# 42. Storage integrity

For every stored artifact:
- calculate hash/root
- record content type
- record byte size
- record uploader/job
- record storage reference
- verify retrievability
- tie report to hash

If 0G Storage upload fails:
- do not mark verification final unless policy explicitly permits it
- surface the failure
- retry safely

---

# 43. AI verification reproducibility

Store:
- model
- provider
- prompt template version
- rubric
- input hashes
- output
- parsed structured result
- timestamp
- compute request/receipt metadata when available

A future auditor should be able to understand why a verdict happened.

---

# 44. Security review checklist before release

- [ ] no secrets committed
- [ ] no raw keys in browser
- [ ] no arbitrary host code execution
- [ ] auth on all private routes
- [ ] scope checks on MCP/API tools
- [ ] spend limits enforced server-side
- [ ] rate limits
- [ ] input validation
- [ ] CSRF strategy where relevant
- [ ] CORS restricted
- [ ] SQL injection prevented through parameterized ORM/query
- [ ] XSS protections
- [ ] webhook signatures
- [ ] idempotent payment APIs
- [ ] smart contract tests
- [ ] access-control tests
- [ ] dependency audit
- [ ] logs inspected for secrets
- [ ] production debug routes disabled
- [ ] admin routes protected

---

# 45. Product anti-patterns

Reject these implementation shortcuts:

### “AI says PASS” with no rubric
Bad.

### Store all data on-chain
Bad.

### Save private key in frontend env
Critical failure.

### Fake transaction hash in UI
Critical failure.

### Hardcode “USDC” without verifying token deployment
Bad.

### Let provider trigger its own payout
Bad.

### One generic `status` string with arbitrary values
Bad.

### Reputation from unverified reviews
Against core product thesis.

### UI-only integration
Bad.

### `setTimeout()` pretending a blockchain/AI task completed
Bad except explicit visual development fixtures.

### Replace broken 0G integration with a centralized API without disclosure
Bad.

---

# 46. Coding style

TypeScript:
- strict mode
- no unnecessary `any`
- domain types in shared package
- Zod at trust boundaries
- discriminated unions for state/results
- async errors handled explicitly
- no swallowed promises

React:
- server components where appropriate
- client components only when needed
- no giant 1000-line page components
- extract domain components, not meaningless wrappers

Solidity:
- custom errors
- events for state transitions
- Checks-Effects-Interactions
- OpenZeppelin where appropriate
- NatSpec for public contract interfaces
- no magic addresses

---

# 47. Documentation that must exist by completion

Even though this AGENTS.md is the master instruction file, the finished repo should have:

- README.md
- docs/ARCHITECTURE.md
- docs/CONTRACTS.md
- docs/API.md
- docs/MCP.md
- docs/SECURITY.md
- docs/TESTING.md
- docs/DEPLOYMENT.md
- docs/DEMO.md

Documentation must match actual code.
Update docs when interfaces change.

---

# 48. README requirements

README must answer immediately:

1. What is AgentClear?
2. Why does it exist?
3. What does 0G do in the architecture?
4. How do I run it locally?
5. How do I configure env vars?
6. How do I run tests?
7. How do I deploy contracts?
8. How do I connect MCP?
9. Where are deployed contract addresses?
10. Where are explorer links?
11. What is real vs optional/fallback?

Include one architecture diagram.

---

# 49. Definition of done for the core product

The core product is not done until:

- [ ] Buyer can create a structured job.
- [ ] Job can be funded through real contract interaction.
- [ ] Provider can submit a deliverable.
- [ ] Deliverable/evidence can be persisted on 0G Storage.
- [ ] At least one deterministic verifier works.
- [ ] 0G Compute is used for a meaningful verification step.
- [ ] Verification produces a structured report.
- [ ] PASS can release escrow.
- [ ] FAIL can lead to retry or refund.
- [ ] Final outcome is anchored.
- [ ] Final receipt is generated.
- [ ] ERC-8004 identity is readable/linked.
- [ ] Reputation update is tied to finalized job.
- [ ] MCP can create/read a job and read the final receipt.
- [ ] Operator UI shows complete lifecycle.
- [ ] Critical flows pass E2E tests.
- [ ] Contracts pass tests.
- [ ] App builds without type/lint errors.
- [ ] Demo can be reproduced from README.

---

# 50. Definition of done for the full product

After core completion, continue until these are covered:

- [ ] full page map implemented
- [ ] agent registration/profile
- [ ] discovery
- [ ] API keys
- [ ] MCP auth/scopes
- [ ] spend policies
- [ ] webhooks
- [ ] disputes
- [ ] admin operations
- [ ] risk flags
- [ ] wallet/budget UI
- [ ] usage/billing visibility
- [ ] production deployment
- [ ] monitoring
- [ ] privacy/security review
- [ ] responsive/mobile checks
- [ ] accessibility checks
- [ ] public docs
- [ ] buildathon submission package

Do not confuse “full product” with “every imaginable future feature.”
Complete the defined product surfaces first.

---

# 51. When blocked

If an integration is blocked:

1. Verify the error.
2. Read current official docs.
3. Use Context7.
4. Inspect package source/types.
5. Inspect vendored 0G examples.
6. Write a minimal reproduction.
7. Search the relevant official GitHub issues if needed.
8. Implement a correct fix.

If the external service itself is unavailable:
- keep the real integration code
- expose health/degraded status
- use a clearly marked local fixture only for development
- never claim the fixture is the live integration

Do not silently remove the feature.

---

# 52. Decision rule for scope

When choosing between:

A. ten additional screens, or  
B. a real verified end-to-end job with explorer/storage/compute proof,

choose B first.

When the end-to-end loop is stable, build the remaining screens.

---

# 53. Final product narrative

Every architecture and UX decision should reinforce this sentence:

> **AgentClear turns AI-agent work into enforceable digital agreements: the buyer escrows payment, the provider performs the task, the outcome is verified, successful work is paid, failed work is refunded, and reputation is backed by real transactions rather than arbitrary ratings.**

If a feature does not strengthen:
- agreement
- verification
- settlement
- reputation
- agent interoperability

question whether it belongs in the buildathon product.

---

# 54. Final instruction to Codex / coding agents

Do not optimize for producing the largest amount of code.

Optimize for:
- correctness
- real integrations
- complete flows
- security
- verifiability
- understandable UX
- reproducible deployment
- strong tests
- clear 0G value

Continue iterating until the implemented behavior matches this specification and the relevant quality gates pass.

When uncertain about a current SDK/protocol detail, **look it up instead of guessing**.
