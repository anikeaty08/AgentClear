import {
  createZGComputeNetworkBroker,
  type ZGComputeNetworkBroker,
} from '@0gfoundation/0g-compute-ts-sdk';
import {
  aiCriterionResultSchema,
  ComputeOperationFailedError,
  ComputeUnavailableError,
  type AiVerificationRequest,
  type AiVerificationResult,
  type AiVerifier,
} from '@agentclear/domain';
import { JsonRpcProvider, Wallet } from 'ethers';
import { z } from 'zod';

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const maximumProviderPages = 20;
const providerPageSize = 50;

type ProviderService = {
  provider: string;
  serviceType: string;
  url: string;
  model: string;
  teeSignerAddress: string;
  teeSignerAcknowledged: boolean;
};

type ComputeBroker = {
  inference: {
    listService(
      offset?: number,
      limit?: number,
      includeUnacknowledged?: boolean,
    ): Promise<ProviderService[]>;
    getProviderModels(providerAddress: string): Promise<{
      defaultModel: string;
      models: Array<{ id: string }>;
    }>;
    getAccount(providerAddress: string): Promise<{ balance: bigint }>;
    checkProviderSignerStatus(providerAddress: string): Promise<{
      isAcknowledged: boolean;
      teeSignerAddress: string;
    }>;
    getServiceMetadata(
      providerAddress: string,
      model?: string,
    ): Promise<{ endpoint: string; model: string }>;
    getRequestHeaders(
      providerAddress: string,
      content?: string,
    ): Promise<{ Authorization: string }>;
    processResponse(
      providerAddress: string,
      chatId?: string,
      content?: string,
    ): Promise<boolean | null>;
  };
};

const judgeOutputSchema = z
  .object({
    scoreBps: z.number().int().min(0).max(10_000),
    confidenceBps: z.number().int().min(0).max(10_000),
    criteria: z.array(aiCriterionResultSchema).min(1).max(20),
  })
  .strict();

const completionSchema = z
  .object({
    id: z.string().min(1).max(500),
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().min(1),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
    usage: z.json().optional(),
  })
  .passthrough();

const billingMetadataSchema = z
  .object({
    id: z.string().min(1).max(500).optional(),
    usage: z.json().optional(),
  })
  .passthrough();

export type ZeroGComputeVerifierOptions = {
  providerAddress: `0x${string}`;
  model?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  requireTee: boolean;
  broker: ComputeBroker;
  fetchImplementation?: typeof fetch;
};

export type ZeroGComputeHealth = {
  providerAddress: `0x${string}`;
  model: string;
  teeAcknowledged: boolean;
  accountBalanceBaseUnits: string;
};

function assertSafeProviderEndpoint(rawEndpoint: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new ComputeUnavailableError();
  }
  const hostname = endpoint.hostname.toLowerCase();
  const forbiddenHost =
    hostname === 'localhost'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost')
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^169\.254\./.test(hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname);
  if (endpoint.protocol !== 'https:' || forbiddenHost || endpoint.username !== '' || endpoint.password !== '') {
    throw new ComputeUnavailableError();
  }
  return endpoint;
}

async function readLimitedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) throw new ComputeOperationFailedError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new ComputeOperationFailedError();
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ComputeOperationFailedError();
  }
}

export class ZeroGComputeVerifier implements AiVerifier {
  readonly #providerAddress: `0x${string}`;
  readonly #model: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #requireTee: boolean;
  readonly #broker: ComputeBroker;
  readonly #fetch: typeof fetch;

  public constructor(options: ZeroGComputeVerifierOptions) {
    if (!addressPattern.test(options.providerAddress)) throw new TypeError('Invalid Compute provider address.');
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 300_000) {
      throw new TypeError('Compute timeout must be between 1000 and 300000 milliseconds.');
    }
    const maximumBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1_024 || maximumBytes > 4_194_304) {
      throw new TypeError('Compute response limit must be between 1024 and 4194304 bytes.');
    }
    this.#providerAddress = options.providerAddress;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = maximumBytes;
    this.#requireTee = options.requireTee;
    this.#broker = options.broker;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  public async preflight(request: AiVerificationRequest): Promise<void> {
    void request;
    await this.health();
  }

  public async health(): Promise<ZeroGComputeHealth> {
    try {
      const service = await this.#findProvider();
      if (service.serviceType.toLowerCase() !== 'chatbot') throw new ComputeUnavailableError();
      assertSafeProviderEndpoint(service.url);
      const signer = await this.#broker.inference.checkProviderSignerStatus(this.#providerAddress);
      const teeAcknowledged = service.teeSignerAcknowledged && signer.isAcknowledged;
      if (this.#requireTee && !teeAcknowledged) throw new ComputeUnavailableError();
      const models = await this.#broker.inference.getProviderModels(this.#providerAddress);
      const model = this.#model ?? models.defaultModel;
      if (!models.models.some((candidate) => candidate.id === model)) {
        throw new ComputeUnavailableError();
      }
      const account = await this.#broker.inference.getAccount(this.#providerAddress);
      if (account.balance <= 0n) throw new ComputeUnavailableError();
      return {
        providerAddress: this.#providerAddress,
        model,
        teeAcknowledged,
        accountBalanceBaseUnits: account.balance.toString(),
      };
    } catch (error) {
      if (error instanceof ComputeUnavailableError) throw error;
      throw new ComputeUnavailableError();
    }
  }

  public async evaluate(request: AiVerificationRequest): Promise<AiVerificationResult> {
    try {
      const metadata = await this.#broker.inference.getServiceMetadata(
        this.#providerAddress,
        this.#model,
      );
      const endpoint = assertSafeProviderEndpoint(metadata.endpoint);
      const headers = await this.#broker.inference.getRequestHeaders(
        this.#providerAddress,
        request.canonicalPrompt,
      );
      const response = await this.#fetch(
        new URL('chat/completions', `${endpoint.toString().replace(/\/$/, '')}/`),
        {
          method: 'POST',
          headers: {
            ...Object.fromEntries(
              Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
            ),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: metadata.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content:
                  'You are an evidence verifier. Return only strict JSON matching the response contract. Never include markdown fences.',
              },
              { role: 'user', content: request.canonicalPrompt },
            ],
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
      if (!response.ok) throw new ComputeOperationFailedError();
      const responseText = await readLimitedResponse(response, this.#maxResponseBytes);
      let rawCompletion: unknown;
      try {
        rawCompletion = JSON.parse(responseText);
      } catch {
        await this.#broker.inference.processResponse(
          this.#providerAddress,
          response.headers.get('ZG-Res-Key') ?? undefined,
          '{}',
        );
        throw new ComputeOperationFailedError();
      }
      const billingMetadata = billingMetadataSchema.safeParse(rawCompletion);
      const usage = billingMetadata.success ? (billingMetadata.data.usage ?? {}) : {};
      const billedChatId = response.headers.get('ZG-Res-Key')
        ?? (billingMetadata.success ? billingMetadata.data.id : undefined);
      const responseVerified = await this.#broker.inference.processResponse(
        this.#providerAddress,
        billedChatId,
        JSON.stringify(usage),
      );
      const completion = completionSchema.safeParse(rawCompletion);
      if (!completion.success) throw new ComputeOperationFailedError();
      const chatId = response.headers.get('ZG-Res-Key') ?? completion.data.id;
      const rawResponse = completion.data.choices[0]!.message.content;
      let rawJudgeOutput: unknown;
      try {
        rawJudgeOutput = JSON.parse(rawResponse);
      } catch {
        throw new ComputeOperationFailedError();
      }
      const judgeOutput = judgeOutputSchema.safeParse(rawJudgeOutput);
      if (!judgeOutput.success) throw new ComputeOperationFailedError();
      return {
        providerAddress: this.#providerAddress,
        model: metadata.model,
        chatId,
        ...judgeOutput.data,
        usage,
        rawResponse,
        responseVerified,
      };
    } catch (error) {
      if (error instanceof ComputeOperationFailedError) throw error;
      throw new ComputeOperationFailedError();
    }
  }

  async #findProvider(): Promise<ProviderService> {
    for (let page = 0; page < maximumProviderPages; page += 1) {
      const services = await this.#broker.inference.listService(
        page * providerPageSize,
        providerPageSize,
        true,
      );
      const selected = services.find(
        (service) => service.provider.toLowerCase() === this.#providerAddress.toLowerCase(),
      );
      if (selected !== undefined) return selected;
      if (services.length < providerPageSize) break;
    }
    throw new ComputeUnavailableError();
  }
}

export async function createZeroGComputeVerifier(input: {
  rpcUrl: string;
  signerPrivateKey: `0x${string}`;
  providerAddress: `0x${string}`;
  model?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  requireTee: boolean;
}): Promise<ZeroGComputeVerifier> {
  const provider = new JsonRpcProvider(input.rpcUrl);
  const signer = new Wallet(input.signerPrivateKey, provider);
  // SDK 0.9.0 publishes conditional ESM/CJS ethers declarations whose private Wallet
  // fields are nominally incompatible even though both resolve to ethers 6.13.1 at runtime.
  const broker: ZGComputeNetworkBroker = await createZGComputeNetworkBroker(
    signer as unknown as Parameters<typeof createZGComputeNetworkBroker>[0],
  );
  return new ZeroGComputeVerifier({
    providerAddress: input.providerAddress,
    ...(input.model === undefined ? {} : { model: input.model }),
    timeoutMs: input.timeoutMs,
    ...(input.maxResponseBytes === undefined ? {} : { maxResponseBytes: input.maxResponseBytes }),
    requireTee: input.requireTee,
    broker,
  });
}
