# MCP server

`apps/mcp` is a thin, stateless Streamable HTTP adapter built with the official `@modelcontextprotocol/sdk` 1.30.0. It does not reimplement agreement, escrow, verification, or settlement rules. Each tool forwards to the versioned REST boundary, which invokes the same domain/application services used by the operator API.

## Endpoint and authentication

The local endpoint is `http://127.0.0.1:3002/mcp`.

Every MCP request requires the caller's scoped AgentClear API key:

```http
Authorization: Bearer <agentclear-api-key>
```

The key remains in an HTTP header and is never accepted as a tool argument, returned in content, or written to logs. Issue distinct durable buyer/operator and provider keys through the REST API; expiry and revocation take effect because every MCP operation re-authenticates upstream. REST scopes and the caller's durable capability/per-job/day/month funding policy remain authoritative. High-value jobs return `SPENDING_APPROVAL_REQUIRED` until an operator approves the reservation through REST; the MCP process never receives a wallet private key or approval capability.

The transport is stateless and JSON-response based. It validates the `Host` header, rejects browser `Origin` values unless explicitly allowed, limits request and upstream response bytes, applies a per-source in-memory request cap, and times out upstream requests. Deploy it behind TLS. A public bind requires explicit `MCP_ALLOWED_HOSTS`; configure exact browser origins only when browser MCP access is intended.

## Implemented tools

| Tool | REST operation | Safety |
| --- | --- | --- |
| `create_job` | `POST /v1/jobs` | Structured agreement plus required idempotency key |
| `quote_job` | `POST /v1/jobs/:id/quote` | Accepts an existing DRAFT agreement; no invented fee quote |
| `get_job` | `GET /v1/jobs/:id` | Read-only |
| `list_jobs` | `GET /v1/jobs` | Read-only cursor pagination and filters |
| `fund_job` | `POST /v1/jobs/:id/fund` | Sensitive; `jobs:fund`, idempotency, and spending policy required |
| `assign_agent` | `POST /v1/jobs/:id/assign` | Scoped, idempotent chain write |
| `submit_result` | `POST /v1/jobs/:id/submissions` | Assigned provider credential required |
| `verify_result` | `POST /v1/jobs/:id/verify` | May incur configured 0G Compute cost; provider cannot self-pass |
| `settle_job` | `POST /v1/jobs/:id/settle` | Anchors outcome, pays/refunds, writes reputation, and publishes receipt when configured |
| `get_receipt` | `GET /v1/jobs/:id/receipt` | Read-only portable proof lookup |

`settle_job` is intentionally exposed in addition to the minimum product tool list because the complete agreement-to-receipt workflow would otherwise be impossible through MCP.

`discover_agents`, `cancel_job`, and `get_agent_reputation` are not registered yet. Their real domain models and REST operations are still pending; the MCP server does not advertise fake tools or duplicate business logic.

## Configuration

```text
MCP_HOST=127.0.0.1
MCP_PORT=3002
AGENTCLEAR_API_BASE_URL=http://127.0.0.1:3001
MCP_ALLOWED_HOSTS=127.0.0.1,localhost,::1
MCP_ALLOWED_ORIGINS=
MCP_MAX_BODY_BYTES=1048576
MCP_MAX_RESPONSE_BYTES=4194304
MCP_UPSTREAM_TIMEOUT_MS=180000
MCP_RATE_LIMIT_PER_MINUTE=60
```

Start the API and MCP workspaces with `pnpm dev`, or run `pnpm --filter @agentclear/mcp dev` after the API is available.

## Verification

`apps/mcp/test/mcp.integration.test.ts` starts the real Node HTTP transport and uses the official SDK `Client` with `StreamableHTTPClientTransport` to initialize, list tools, and invoke a tool. It also proves stable upstream scope errors, missing-auth rejection, and Origin rejection. The controlled backend in that protocol test is explicitly a fixture; REST/domain end-to-end behavior remains covered by the API/PostgreSQL/Anvil integration suite.
