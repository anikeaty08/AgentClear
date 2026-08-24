import { z } from 'zod';

const apiSuccessSchema = z
  .object({
    data: z.record(z.string(), z.json()),
    meta: z.record(z.string(), z.json()).optional(),
  })
  .passthrough();

const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(1_000),
        requestId: z.string().min(1).max(200).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type BackendCall = {
  method: 'GET' | 'POST';
  path: string;
  query?: Readonly<Record<string, number | string | undefined>>;
  body?: unknown;
  idempotencyKey?: string;
};

export interface AgentClearBackend {
  call(input: BackendCall): Promise<Record<string, unknown>>;
}

export class AgentClearApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AgentClearApiError';
  }
}

export type AgentClearApiClientOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImplementation?: typeof fetch;
};

export class AgentClearApiClient implements AgentClearBackend {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  public constructor(options: AgentClearApiClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new TypeError('AgentClear API URL must use HTTP(S).');
    }
    if (baseUrl.pathname !== '/' || baseUrl.search !== '' || baseUrl.hash !== '') {
      throw new TypeError('AgentClear API URL must not include a path, query, or fragment.');
    }
    if (options.apiKey.length < 32 || options.apiKey.length > 512 || /\s/u.test(options.apiKey)) {
      throw new TypeError('A valid scoped AgentClear API key is required.');
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
      throw new TypeError('Upstream timeout must be at least one second.');
    }
    if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1_024) {
      throw new TypeError('Upstream response limit must be at least 1024 bytes.');
    }
    this.#baseUrl = baseUrl.toString().replace(/\/$/u, '');
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  public async call(input: BackendCall): Promise<Record<string, unknown>> {
    if (!/^\/v1\/[A-Za-z0-9_./:-]+$/u.test(input.path) || input.path.includes('..')) {
      throw new TypeError('Unsafe AgentClear API path.');
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.#apiKey}`,
    };
    if (input.idempotencyKey !== undefined) {
      headers['idempotency-key'] = input.idempotencyKey;
    }
    const requestBody = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (requestBody !== undefined) headers['content-type'] = 'application/json';

    const requestUrl = new URL(`${this.#baseUrl}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (value !== undefined) requestUrl.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.#fetch(requestUrl, {
        method: input.method,
        headers,
        ...(requestBody === undefined ? {} : { body: requestBody }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new AgentClearApiError(
        'MCP_UPSTREAM_UNAVAILABLE',
        'The AgentClear API could not be reached safely.',
        502,
      );
    }

    const payload = await readBoundedJson(response, this.#maxResponseBytes);
    if (!response.ok) {
      const parsedError = apiErrorSchema.safeParse(payload);
      if (parsedError.success) {
        throw new AgentClearApiError(
          parsedError.data.error.code,
          parsedError.data.error.message,
          response.status,
        );
      }
      throw new AgentClearApiError(
        'MCP_UPSTREAM_ERROR',
        'The AgentClear API returned an invalid error response.',
        502,
      );
    }
    const parsed = apiSuccessSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AgentClearApiError(
        'MCP_UPSTREAM_INVALID_RESPONSE',
        'The AgentClear API returned an invalid success response.',
        502,
      );
    }
    return parsed.data.data;
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    await response.body?.cancel();
    throw new AgentClearApiError(
      'MCP_UPSTREAM_INVALID_RESPONSE',
      'The AgentClear API returned a non-JSON response.',
      502,
    );
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await response.body?.cancel();
    throw new AgentClearApiError(
      'MCP_UPSTREAM_RESPONSE_TOO_LARGE',
      'The AgentClear API response exceeded the configured safety limit.',
      502,
    );
  }
  if (response.body === null) {
    throw new AgentClearApiError(
      'MCP_UPSTREAM_INVALID_RESPONSE',
      'The AgentClear API returned an empty response.',
      502,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    receivedBytes += next.value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      throw new AgentClearApiError(
        'MCP_UPSTREAM_RESPONSE_TOO_LARGE',
        'The AgentClear API response exceeded the configured safety limit.',
        502,
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AgentClearApiError(
      'MCP_UPSTREAM_INVALID_RESPONSE',
      'The AgentClear API returned malformed JSON.',
      502,
    );
  }
}
