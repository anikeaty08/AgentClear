import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { AgentClearBackend } from './backend.js';
import { createAgentClearMcpServer } from './mcp.js';

export type McpHttpServerOptions = {
  backendFactory: (apiKey: string) => AgentClearBackend;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  clock?: () => number;
};

type RateWindow = { startedAt: number; count: number };

class HttpRequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

export function createMcpHttpServer(options: McpHttpServerOptions): Server {
  if (options.allowedHosts.length === 0) throw new TypeError('At least one MCP host is required.');
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1_024) {
    throw new TypeError('MCP body limit must be at least 1024 bytes.');
  }
  if (!Number.isSafeInteger(options.rateLimitPerMinute) || options.rateLimitPerMinute < 1) {
    throw new TypeError('MCP rate limit must be a positive integer.');
  }
  const allowedHosts = new Set(options.allowedHosts.map(normalizeConfiguredHost));
  const allowedOrigins = new Set(options.allowedOrigins.map(normalizeOrigin));
  const rateWindows = new Map<string, RateWindow>();
  const clock = options.clock ?? Date.now;

  return createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const publicError = error instanceof HttpRequestError
        ? error
        : new HttpRequestError(500, 'MCP_INTERNAL_ERROR', 'The MCP request could not complete safely.');
      writeJson(response, publicError.statusCode, {
        error: { code: publicError.code, message: publicError.message },
      });
    });
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://agentclear.invalid');
    if (requestUrl.pathname === '/health' && request.method === 'GET') {
      writeJson(response, 200, { status: 'ok' });
      return;
    }
    if (requestUrl.pathname !== '/mcp') {
      throw new HttpRequestError(404, 'MCP_ROUTE_NOT_FOUND', 'The requested MCP route does not exist.');
    }

    validateHost(request.headers.host, allowedHosts);
    const allowedOrigin = validateOrigin(request.headers.origin, allowedOrigins);
    if (allowedOrigin !== null) applyCors(response, allowedOrigin);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        allow: 'POST, OPTIONS',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers':
          'authorization, content-type, mcp-protocol-version, mcp-session-id',
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST, OPTIONS');
      throw new HttpRequestError(405, 'MCP_METHOD_NOT_ALLOWED', 'Only MCP POST requests are supported.');
    }
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new HttpRequestError(
        415,
        'MCP_UNSUPPORTED_MEDIA_TYPE',
        'MCP POST requests must use application/json.',
      );
    }

    const apiKey = readBearerToken(request.headers.authorization);
    enforceRateLimit(request.socket.remoteAddress ?? 'unknown', rateWindows, clock(), options);
    const body = await readJsonBody(request, options.maxBodyBytes);
    const backend = options.backendFactory(apiKey);
    const mcpServer = createAgentClearMcpServer(backend);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      // SDK 1.30's declarations do not model exactOptionalPropertyTypes consistently.
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await mcpServer.close();
    }
  }
}

function validateHost(value: string | undefined, allowedHosts: ReadonlySet<string>): void {
  if (value === undefined) {
    throw new HttpRequestError(400, 'MCP_HOST_REJECTED', 'A valid Host header is required.');
  }
  if (/[\s,@/\\]/u.test(value)) {
    throw new HttpRequestError(400, 'MCP_HOST_REJECTED', 'The Host header is invalid.');
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${value}`).hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  } catch {
    throw new HttpRequestError(400, 'MCP_HOST_REJECTED', 'The Host header is invalid.');
  }
  if (!allowedHosts.has(hostname)) {
    throw new HttpRequestError(403, 'MCP_HOST_REJECTED', 'The Host header is not allowed.');
  }
}

function normalizeConfiguredHost(value: string): string {
  const normalized = value.trim().replace(/^\[|\]$/gu, '').toLowerCase();
  if (
    normalized.length === 0
    || (isIP(normalized) === 0 && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized))
  ) {
    throw new TypeError('MCP allowed hosts must be hostnames or IP addresses.');
  }
  return normalized;
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.origin !== value.replace(/\/$/u, '')
  ) {
    throw new TypeError('MCP allowed origins must be exact HTTP(S) origins.');
  }
  return parsed.origin;
}

function validateOrigin(
  value: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  if (value === undefined) return null;
  let origin: string;
  try {
    const parsed = new URL(value);
    origin = parsed.origin;
    if (origin !== value.replace(/\/$/u, '')) throw new TypeError();
  } catch {
    throw new HttpRequestError(403, 'MCP_ORIGIN_REJECTED', 'The request Origin is invalid.');
  }
  if (!allowedOrigins.has(origin)) {
    throw new HttpRequestError(403, 'MCP_ORIGIN_REJECTED', 'The request Origin is not allowed.');
  }
  return origin;
}

function applyCors(response: ServerResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
}

function readBearerToken(value: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/u.exec(value ?? '');
  const token = match?.[1];
  if (token === undefined || token.length < 32 || token.length > 512) {
    throw new HttpRequestError(401, 'MCP_AUTHENTICATION_REQUIRED', 'A valid Bearer API key is required.');
  }
  return token;
}

function enforceRateLimit(
  key: string,
  windows: Map<string, RateWindow>,
  now: number,
  options: Pick<McpHttpServerOptions, 'rateLimitPerMinute'>,
): void {
  const minute = 60_000;
  const existing = windows.get(key);
  if (existing === undefined || now - existing.startedAt >= minute) {
    if (windows.size >= 10_000) {
      for (const [candidate, window] of windows) {
        if (now - window.startedAt >= minute) windows.delete(candidate);
      }
    }
    if (windows.size >= 10_000 && !windows.has(key)) {
      throw new HttpRequestError(429, 'MCP_RATE_LIMITED', 'The MCP request limit was exceeded.');
    }
    windows.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (existing.count >= options.rateLimitPerMinute) {
    throw new HttpRequestError(429, 'MCP_RATE_LIMITED', 'The MCP request limit was exceeded.');
  }
  existing.count += 1;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declaredLength = request.headers['content-length'];
  if (
    declaredLength !== undefined
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new HttpRequestError(413, 'MCP_REQUEST_TOO_LARGE', 'The MCP request body is too large.');
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += bytes.byteLength;
    if (receivedBytes > maxBytes) {
      throw new HttpRequestError(413, 'MCP_REQUEST_TOO_LARGE', 'The MCP request body is too large.');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpRequestError(400, 'MCP_INVALID_JSON', 'The MCP request body is not valid JSON.');
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(statusCode === 401 ? { 'www-authenticate': 'Bearer' } : {}),
  });
  response.end(JSON.stringify(payload));
}
