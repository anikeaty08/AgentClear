import {
  assignProviderInputSchema,
  closeJobInputSchema,
  createJobInputSchema,
  JOB_STATES,
  type JsonValue,
} from '@agentclear/domain';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AgentClearApiError, type AgentClearBackend } from './backend.js';

const jobIdSchema = z.uuid().describe('AgentClear job UUID');
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .describe('Stable caller-generated key for safe retries');

type ToolResult = {
  content: [{ type: 'text'; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function createAgentClearMcpServer(backend: AgentClearBackend): McpServer {
  const server = new McpServer(
    { name: 'agentclear', version: '0.1.0' },
    {
      instructions:
        'AgentClear tools operate on real REST/domain state. Mutating calls require stable idempotency keys. Funding and verification may spend configured chain or Compute funds and remain subject to upstream scopes and spending policy.',
    },
  );

  server.registerTool(
    'create_job',
    {
      title: 'Create AgentClear job',
      description: 'Persist a canonical structured task agreement in DRAFT state.',
      inputSchema: z
        .object({
          agreement: createJobInputSchema,
          idempotencyKey: idempotencyKeySchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agreement, idempotencyKey }) =>
      runTool(() =>
        backend.call({
          method: 'POST',
          path: '/v1/jobs',
          body: agreement,
          idempotencyKey,
        }),
      ),
  );

  server.registerTool(
    'quote_job',
    {
      title: 'Quote AgentClear job',
      description: 'Accept a persisted DRAFT agreement for its configured maximum budget.',
      inputSchema: z
        .object({ jobId: jobIdSchema, idempotencyKey: idempotencyKeySchema })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId, idempotencyKey }) =>
      runTool(() =>
        backend.call({
          method: 'POST',
          path: `/v1/jobs/${jobId}/quote`,
          body: {},
          idempotencyKey,
        }),
      ),
  );

  server.registerTool(
    'get_job',
    {
      title: 'Get AgentClear job',
      description: 'Return the current canonical job state and agreement.',
      inputSchema: z.object({ jobId: jobIdSchema }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId }) =>
      runTool(() => backend.call({ method: 'GET', path: `/v1/jobs/${jobId}` })),
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List AgentClear jobs',
      description: 'Return a cursor-paginated job page with optional lifecycle and agent filters.',
      inputSchema: z
        .object({
          state: z.enum(JOB_STATES).optional(),
          buyerAgentId: z.string().regex(/^erc8004:\d+:\d+$/).optional(),
          providerAgentId: z.string().regex(/^erc8004:\d+:\d+$/).optional(),
          cursor: z.string().min(1).max(512).optional(),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ state, buyerAgentId, providerAgentId, cursor, limit }) =>
      runTool(() =>
        backend.call({
          method: 'GET',
          path: '/v1/jobs',
          query: { state, buyerAgentId, providerAgentId, cursor, limit },
        }),
      ),
  );

  server.registerTool(
    'fund_job',
    {
      title: 'Fund AgentClear escrow',
      description:
        'Fund the quoted job through the configured chain signer. Requires upstream jobs:fund scope and spending-policy approval.',
      inputSchema: z
        .object({ jobId: jobIdSchema, idempotencyKey: idempotencyKeySchema })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId, idempotencyKey }) =>
      runTool(() =>
        backend.call({
          method: 'POST',
          path: `/v1/jobs/${jobId}/fund`,
          body: {},
          idempotencyKey,
        }),
      ),
  );

  server.registerTool(
    'assign_agent',
    {
      title: 'Assign provider agent',
      description: 'Assign the authorized ERC-8004 provider identity and payment address.',
      inputSchema: z
        .object({
          jobId: jobIdSchema,
          assignment: assignProviderInputSchema,
          idempotencyKey: idempotencyKeySchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId, assignment, idempotencyKey }) =>
      runTool(() =>
        backend.call({
          method: 'POST',
          path: `/v1/jobs/${jobId}/assign`,
          body: assignment,
          idempotencyKey,
        }),
      ),
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel AgentClear job',
      description:
        'Cancel before provider assignment. A funded job is refunded through the configured escrow contract.',
      inputSchema: z
        .object({
          jobId: jobIdSchema,
          cancellation: closeJobInputSchema.default({}),
          idempotencyKey: idempotencyKeySchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId, cancellation, idempotencyKey }) =>
      runTool(() =>
        backend.call({
          method: 'POST',
          path: `/v1/jobs/${jobId}/cancel`,
          body: cancellation,
          idempotencyKey,
        }),
      ),
  );

  server.registerTool(
    'submit_result',
    {
      title: 'Submit provider result',
      description:
        'Store the assigned provider result as verified 0G evidence. The caller must authenticate as the assigned provider.',
      inputSchema: z
        .object({
          jobId: jobIdSchema,
          result: z.json().describe('Structured deliverable or sandbox files object'),
          idempotencyKey: idempotencyKeySchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId, result, idempotencyKey }) =>
      runTool(() =>
        backend.call({
          method: 'POST',
          path: `/v1/jobs/${jobId}/submissions`,
          body: { result: result as JsonValue },
          idempotencyKey,
        }),
      ),
  );

  server.registerTool(
    'verify_result',
    {
      title: 'Verify submitted result',
      description:
        'Run the frozen deterministic, sandbox, and/or 0G Compute policy. The provider cannot mark itself passed.',
      inputSchema: z
        .object({ jobId: jobIdSchema, idempotencyKey: idempotencyKeySchema })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId, idempotencyKey }) =>
      runTool(() =>
        backend.call({
          method: 'POST',
          path: `/v1/jobs/${jobId}/verify`,
          body: {},
          idempotencyKey,
        }),
      ),
  );

  server.registerTool(
    'settle_job',
    {
      title: 'Settle verified job',
      description:
        'Anchor the verified outcome, release or refund escrow, update ERC-8004 reputation, and publish the receipt when configured.',
      inputSchema: z
        .object({ jobId: jobIdSchema, idempotencyKey: idempotencyKeySchema })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId, idempotencyKey }) =>
      runTool(() =>
        backend.call({
          method: 'POST',
          path: `/v1/jobs/${jobId}/settle`,
          body: {},
          idempotencyKey,
        }),
      ),
  );

  server.registerTool(
    'get_receipt',
    {
      title: 'Get portable job receipt',
      description: 'Return the finalized content-addressed verification and settlement receipt.',
      inputSchema: z.object({ jobId: jobIdSchema }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jobId }) =>
      runTool(() => backend.call({ method: 'GET', path: `/v1/jobs/${jobId}/receipt` })),
  );

  return server;
}

async function runTool(operation: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    const data = await operation();
    return {
      content: [{ type: 'text', text: JSON.stringify({ data }) }],
      structuredContent: { data },
    };
  } catch (error) {
    const publicError = error instanceof AgentClearApiError
      ? { code: error.code, message: error.message }
      : {
          code: 'MCP_INTERNAL_ERROR',
          message: 'The AgentClear MCP tool could not complete safely.',
        };
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: publicError }) }],
      isError: true,
    };
  }
}
