import { describe, expect, it, vi } from 'vitest';

import { AgentClearApiClient, AgentClearApiError } from '../src/backend.js';

const apiKey = 'mcp-test-api-key-that-is-at-least-32-characters';

describe('AgentClearApiClient', () => {
  it('forwards the scoped key and idempotency header and returns only API data', async () => {
    let capturedRequest: RequestInit | undefined;
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, request?: RequestInit) => {
      capturedRequest = request;
      return new Response(
        JSON.stringify({ data: { job: { id: 'job-1', state: 'QUOTED' } }, meta: { requestId: 'r' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new AgentClearApiClient({
      baseUrl: 'https://api.agentclear.example',
      apiKey,
      timeoutMs: 10_000,
      maxResponseBytes: 8_192,
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    });

    await expect(
      client.call({
        method: 'POST',
        path: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/quote',
        body: {},
        idempotencyKey: 'quote-test-001',
      }),
    ).resolves.toEqual({ job: { id: 'job-1', state: 'QUOTED' } });

    expect(capturedRequest?.headers).toMatchObject({
      authorization: `Bearer ${apiKey}`,
      'idempotency-key': 'quote-test-001',
    });
  });

  it('preserves stable upstream error codes without exposing response internals', async () => {
    const client = new AgentClearApiClient({
      baseUrl: 'https://api.agentclear.example',
      apiKey,
      timeoutMs: 10_000,
      maxResponseBytes: 8_192,
      fetchImplementation: (async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'SPENDING_POLICY_EXCEEDED',
              message: 'The job exceeds the configured spending policy.',
              requestId: 'req-secret-internal',
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });

    const error = await client
      .call({ method: 'POST', path: '/v1/jobs/0198d462-75c0-7000-8000-000000000001/fund' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentClearApiError);
    expect(error).toMatchObject({
      code: 'SPENDING_POLICY_EXCEEDED',
      statusCode: 403,
      message: 'The job exceeds the configured spending policy.',
    });
    expect(JSON.stringify(error)).not.toContain('req-secret-internal');
  });

  it('rejects oversized upstream responses before parsing them', async () => {
    const client = new AgentClearApiClient({
      baseUrl: 'https://api.agentclear.example',
      apiKey,
      timeoutMs: 10_000,
      maxResponseBytes: 1_024,
      fetchImplementation: (async () =>
        new Response('x'.repeat(2_048), {
          status: 200,
          headers: { 'content-length': '2048', 'content-type': 'application/json' },
        })) as typeof fetch,
    });

    await expect(
      client.call({ method: 'GET', path: '/v1/jobs/0198d462-75c0-7000-8000-000000000001' }),
    ).rejects.toMatchObject({ code: 'MCP_UPSTREAM_RESPONSE_TOO_LARGE' });
  });
});
