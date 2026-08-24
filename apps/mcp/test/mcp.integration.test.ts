import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentClearApiError,
  type AgentClearBackend,
  type BackendCall,
} from '../src/backend.js';
import { createMcpHttpServer } from '../src/http.js';

const apiKey = 'mcp-integration-api-key-that-is-long-enough';
const jobId = '0198d462-75c0-7000-8000-000000000001';
const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map(async (close) => close()));
});

describe('AgentClear MCP Streamable HTTP', () => {
  it('lists and invokes real MCP tools through the official client', async () => {
    const calls: BackendCall[] = [];
    const tokens: string[] = [];
    const backend: AgentClearBackend = {
      async call(input) {
        calls.push(input);
        return { job: { id: jobId, state: 'FUNDED' } };
      },
    };
    const url = await startServer((token) => {
      tokens.push(token);
      return backend;
    });
    const client = new Client({ name: 'agentclear-integration-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    });
    // SDK 1.30's declarations do not model exactOptionalPropertyTypes consistently.
    await client.connect(transport as unknown as Transport);
    closeCallbacks.push(async () => client.close());

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([
      'create_job',
      'quote_job',
      'get_job',
      'list_jobs',
      'fund_job',
      'assign_agent',
      'submit_result',
      'verify_result',
      'settle_job',
      'get_receipt',
    ]);

    const result = await client.callTool({ name: 'get_job', arguments: { jobId } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ data: { job: { id: jobId, state: 'FUNDED' } } });
    expect(tokens.every((token) => token === apiKey)).toBe(true);
    expect(calls).toEqual([{ method: 'GET', path: `/v1/jobs/${jobId}` }]);
  });

  it('returns a stable MCP tool error for an upstream authorization failure', async () => {
    const url = await startServer(() => ({
      async call() {
        throw new AgentClearApiError(
          'INSUFFICIENT_SCOPE',
          'The jobs:fund scope is required.',
          403,
        );
      },
    }));
    const client = new Client({ name: 'agentclear-integration-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    });
    await client.connect(transport as unknown as Transport);
    closeCallbacks.push(async () => client.close());

    const result = await client.callTool({
      name: 'fund_job',
      arguments: { jobId, idempotencyKey: 'fund-mcp-test-001' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          error: { code: 'INSUFFICIENT_SCOPE', message: 'The jobs:fund scope is required.' },
        }),
      },
    ]);
  });

  it('rejects missing credentials and unapproved browser origins before MCP parsing', async () => {
    const url = await startServer(() => ({ async call() { return {}; } }));
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw-test', version: '1.0.0' },
      },
    };

    const unauthenticated = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');

    const unsupportedMedia = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'text/plain',
      },
      body: JSON.stringify(body),
    });
    expect(unsupportedMedia.status).toBe(415);

    const rejectedOrigin = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        origin: 'https://attacker.example',
      },
      body: JSON.stringify(body),
    });
    expect(rejectedOrigin.status).toBe(403);
    await expect(rejectedOrigin.json()).resolves.toMatchObject({
      error: { code: 'MCP_ORIGIN_REJECTED' },
    });
  });
});

async function startServer(
  backendFactory: (apiKey: string) => AgentClearBackend,
): Promise<URL> {
  const server = createMcpHttpServer({
    backendFactory,
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: [],
    maxBodyBytes: 1_048_576,
    rateLimitPerMinute: 100,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closeCallbacks.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  );
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}
