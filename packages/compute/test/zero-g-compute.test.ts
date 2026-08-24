import { ComputeOperationFailedError, ComputeUnavailableError } from '@agentclear/domain';
import { describe, expect, it, vi } from 'vitest';

import { ZeroGComputeVerifier, type ZeroGComputeVerifierOptions } from '../src/index.js';

const providerAddress = `0x${'22'.repeat(20)}` as const;

function createBroker(overrides: Record<string, unknown> = {}) {
  return {
    inference: {
      listService: vi.fn(async () => [
        {
          provider: providerAddress,
          serviceType: 'chatbot',
          url: 'https://provider.example/v1',
          model: 'verified-model',
          teeSignerAddress: `0x${'33'.repeat(20)}`,
          teeSignerAcknowledged: true,
        },
      ]),
      getProviderModels: vi.fn(async () => ({
        defaultModel: 'verified-model',
        models: [{ id: 'verified-model' }],
      })),
      getAccount: vi.fn(async () => ({ balance: 1000n })),
      checkProviderSignerStatus: vi.fn(async () => ({
        isAcknowledged: true,
        teeSignerAddress: `0x${'33'.repeat(20)}`,
      })),
      getServiceMetadata: vi.fn(async () => ({
        endpoint: 'https://provider.example/v1',
        model: 'verified-model',
      })),
      getRequestHeaders: vi.fn(async () => ({ Authorization: 'Bearer paid-proof' })),
      processResponse: vi.fn(async () => true),
      ...overrides,
    },
  };
}

const request = {
  runId: '0198d462-75c0-7000-8000-000000000011',
  jobId: '0198d462-75c0-7000-8000-000000000010',
  promptVersion: 'agentclear-rubric-v1',
  canonicalPrompt: '{"task":"verify"}',
  promptHash: `0x${'11'.repeat(32)}`,
} as const;

function options(
  broker: ReturnType<typeof createBroker>,
  fetchImplementation: typeof fetch,
): ZeroGComputeVerifierOptions {
  return {
    providerAddress,
    model: 'verified-model',
    timeoutMs: 10_000,
    maxResponseBytes: 64 * 1024,
    requireTee: true,
    broker,
    fetchImplementation,
  };
}

describe('ZeroGComputeVerifier', () => {
  it('preflights an on-chain provider and processes a structured verifiable response', async () => {
    const broker = createBroker();
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer paid-proof' });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'verified-model',
        response_format: { type: 'json_object' },
      });
      return new Response(
        JSON.stringify({
          id: 'completion-1',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  scoreBps: 9500,
                  confidenceBps: 9000,
                  criteria: [
                    {
                      id: 'quality',
                      scoreBps: 9500,
                      confidenceBps: 9000,
                      explanation: 'The supplied evidence satisfies the criterion.',
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'ZG-Res-Key': 'chat-verified-1' } },
      );
    });
    const verifier = new ZeroGComputeVerifier(options(broker, fetchImplementation));

    await expect(verifier.preflight(request)).resolves.toBeUndefined();
    await expect(verifier.evaluate(request)).resolves.toMatchObject({
      providerAddress,
      model: 'verified-model',
      chatId: 'chat-verified-1',
      scoreBps: 9500,
      responseVerified: true,
    });
    expect(broker.inference.processResponse).toHaveBeenCalledWith(
      providerAddress,
      'chat-verified-1',
      JSON.stringify({ prompt_tokens: 10, completion_tokens: 20 }),
    );
  });

  it('rejects unacknowledged TEE providers before sending a paid request', async () => {
    const broker = createBroker({
      checkProviderSignerStatus: vi.fn(async () => ({
        isAcknowledged: false,
        teeSignerAddress: `0x${'33'.repeat(20)}`,
      })),
    });
    const fetchImplementation = vi.fn<typeof fetch>();
    const verifier = new ZeroGComputeVerifier(options(broker, fetchImplementation));

    await expect(verifier.preflight(request)).rejects.toBeInstanceOf(ComputeUnavailableError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('processes billing/verification metadata even when the judge JSON is invalid', async () => {
    const broker = createBroker();
    const verifier = new ZeroGComputeVerifier(
      options(
        broker,
        vi.fn<typeof fetch>(async () =>
          new Response(
            JSON.stringify({
              id: 'completion-2',
              choices: [{ message: { content: 'not-json' } }],
              usage: {},
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    await expect(verifier.evaluate(request)).rejects.toBeInstanceOf(ComputeOperationFailedError);
    expect(broker.inference.processResponse).toHaveBeenCalledWith(
      providerAddress,
      'completion-2',
      '{}',
    );
  });

  it('blocks private or non-TLS provider endpoints', async () => {
    const broker = createBroker({
      listService: vi.fn(async () => [
        {
          provider: providerAddress,
          serviceType: 'chatbot',
          url: 'http://127.0.0.1:8080/v1',
          model: 'verified-model',
          teeSignerAddress: `0x${'33'.repeat(20)}`,
          teeSignerAcknowledged: true,
        },
      ]),
    });
    const verifier = new ZeroGComputeVerifier(options(broker, vi.fn<typeof fetch>()));

    await expect(verifier.preflight(request)).rejects.toBeInstanceOf(ComputeUnavailableError);
  });
});
