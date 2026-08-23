import { describe, expect, it } from 'vitest';

import {
  createJobInputSchema,
  createAiVerificationRequest,
  determinePolicyVerificationResult,
  determineVerificationOutcome,
  evaluateDeterministicChecks,
  validateAiVerificationResult,
  type DeterministicCheck,
  type AiVerificationResult,
  type Job,
} from '../src/index.js';

const checks: DeterministicCheck[] = [
  {
    id: 'answer',
    kind: 'json_path_equals',
    description: 'The answer is exact.',
    path: ['result', 'answer'],
    expected: 42,
    weightBps: 5000,
    hardFailure: true,
  },
  {
    id: 'citation',
    kind: 'json_path_exists',
    description: 'At least one citation exists.',
    path: ['result', 'citations', 0],
    weightBps: 3000,
    hardFailure: false,
  },
  {
    id: 'metadata-type',
    kind: 'json_type',
    description: 'Metadata is an object.',
    path: ['metadata'],
    expectedType: 'object',
    weightBps: 2000,
    hardFailure: true,
  },
];

describe('deterministic verification', () => {
  it('evaluates nested exact, existence, array, and type checks with integer weight math', () => {
    const result = evaluateDeterministicChecks(checks, {
      result: { answer: 42, citations: ['0g://evidence'] },
      metadata: {},
    });

    expect(result.scoreBps).toBe(10_000);
    expect(result.hardFailure).toBe(false);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it('distinguishes a weighted miss from a hard failure', () => {
    const result = evaluateDeterministicChecks(checks, {
      result: { answer: 42, citations: [] },
      metadata: {},
    });

    expect(result.scoreBps).toBe(7000);
    expect(result.hardFailure).toBe(false);
    expect(result.checks.find((check) => check.id === 'citation')?.message).toContain('missing');
  });

  it('marks an exact-value hard failure without coercing values', () => {
    const result = evaluateDeterministicChecks(checks, {
      result: { answer: '42', citations: ['0g://evidence'] },
      metadata: {},
    });

    expect(result.scoreBps).toBe(5000);
    expect(result.hardFailure).toBe(true);
  });

  it('applies safe defaults and rejects duplicate check IDs in an agreement', () => {
    const base = {
      buyerAgentId: 'erc8004:16602:123',
      title: 'Return an exact value',
      description: 'Return structured JSON.',
      budget: { token: 'native' as const, maxAmount: '1' },
      deadline: '2030-08-23T16:00:00.000Z',
      deliverable: { type: 'data' as const, format: 'json' },
      verification: {
        mode: 'deterministic' as const,
        minimumScore: 1,
        requirements: ['Answer must equal 42.'],
        deterministicChecks: [
          {
            id: 'answer',
            kind: 'json_path_equals' as const,
            description: 'Answer is exact.',
            path: ['answer'],
            expected: 42,
          },
        ],
      },
      refundPolicy: { onExpiry: true, onFinalFailure: true },
    };
    const parsed = createJobInputSchema.parse(base);
    expect(parsed.verification.deterministicChecks?.[0]).toMatchObject({
      weightBps: 10_000,
      hardFailure: true,
    });

    expect(() =>
      createJobInputSchema.parse({
        ...base,
        verification: {
          ...base.verification,
          deterministicChecks: [
            ...base.verification.deterministicChecks,
            { ...base.verification.deterministicChecks[0] },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      createJobInputSchema.parse({
        ...base,
        verification: {
          mode: 'deterministic',
          minimumScore: 1,
          requirements: ['Answer must equal 42.'],
        },
      }),
    ).toThrow();
  });

  it('does not turn prose requirements into invented executable checks', () => {
    expect(evaluateDeterministicChecks([], { answer: 42 })).toEqual({
      checks: [],
      scoreBps: 0,
      hardFailure: false,
    });
  });

  it('requires a complete machine-readable rubric for AI verification modes', () => {
    const base = {
      buyerAgentId: 'erc8004:16602:123',
      title: 'Review a research summary',
      description: 'Check the supplied research summary against the rubric.',
      budget: { token: 'native' as const, maxAmount: '1' },
      deadline: '2030-08-23T16:00:00.000Z',
      deliverable: { type: 'research' as const, format: 'json' },
      verification: {
        mode: 'ai' as const,
        minimumScore: 0.9,
        requirements: ['Claims must be supported by the supplied sources.'],
      },
      refundPolicy: { onExpiry: true, onFinalFailure: true },
    };

    expect(() => createJobInputSchema.parse(base)).toThrow();
    expect(
      createJobInputSchema.parse({
        ...base,
        verification: {
          ...base.verification,
          rubric: {
            criteria: [
              { id: 'factuality', description: 'Claims are supported.', weightBps: 7000 },
              { id: 'coverage', description: 'All sections are present.', weightBps: 3000 },
            ],
          },
        },
      }).verification.rubric?.criteria,
    ).toHaveLength(2);
    expect(() =>
      createJobInputSchema.parse({
        ...base,
        verification: {
          ...base.verification,
          rubric: {
            criteria: [
              { id: 'factuality', description: 'Claims are supported.', weightBps: 5000 },
            ],
          },
        },
      }),
    ).toThrow();
  });

  it('fails hard deterministic misses and escalates incomplete AI modes', () => {
    expect(determineVerificationOutcome('deterministic', 10_000, 9000, false)).toBe('PASS');
    expect(determineVerificationOutcome('deterministic', 8999, 9000, false)).toBe('FAIL');
    expect(determineVerificationOutcome('deterministic_plus_ai', 10_000, 9000, false)).toBe(
      'NEEDS_REVIEW',
    );
    expect(determineVerificationOutcome('deterministic_plus_ai', 10_000, 9000, true)).toBe(
      'FAIL',
    );
  });

  it('builds a stable prompt commitment and validates rubric-weighted AI output', () => {
    const job = {
      id: '0198d462-75c0-7000-8000-000000000010',
      agreement: {
        jobId: '0198d462-75c0-7000-8000-000000000010',
        buyerAgentId: 'erc8004:16602:123',
        title: 'Review research',
        description: 'Review the structured result.',
        budget: { token: 'native', maxAmount: '1' },
        deadline: '2030-08-23T16:00:00.000Z',
        deliverable: { type: 'research', format: 'json' },
        verification: {
          mode: 'ai',
          minimumScore: 0.9,
          requirements: ['Be factual.'],
          rubric: {
            criteria: [
              { id: 'factuality', description: 'Claims are supported.', weightBps: 7000 },
              { id: 'coverage', description: 'All sections are present.', weightBps: 3000 },
            ],
          },
        },
        refundPolicy: { onExpiry: true, onFinalFailure: true },
      },
      providerAgentId: 'erc8004:16602:456',
      agreementHash: `0x${'11'.repeat(32)}`,
      budgetAmountBaseUnits: '1000000000000000000',
      minimumScoreBps: 9000,
      state: 'VERIFYING',
      version: 7,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:05:00.000Z',
    } satisfies Job;
    const first = createAiVerificationRequest({
      runId: '0198d462-75c0-7000-8000-000000000011',
      job,
      result: { summary: 'Evidence-backed result.' },
      rubric: job.agreement.verification.rubric!,
    });
    const second = createAiVerificationRequest({
      runId: first.runId,
      job,
      result: { summary: 'Evidence-backed result.' },
      rubric: job.agreement.verification.rubric!,
    });
    expect(first.promptHash).toBe(second.promptHash);
    expect(first.canonicalPrompt).toContain('factuality');

    const validated = validateAiVerificationResult(
      {
        providerAddress: `0x${'22'.repeat(20)}`,
        model: 'verified-model',
        chatId: 'chat-1',
        scoreBps: 9300,
        confidenceBps: 8600,
        criteria: [
          {
            id: 'factuality',
            scoreBps: 9000,
            confidenceBps: 8000,
            explanation: 'Claims map to evidence.',
          },
          {
            id: 'coverage',
            scoreBps: 10_000,
            confidenceBps: 10_000,
            explanation: 'All sections are present.',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        rawResponse: '{"scoreBps":9300}',
        responseVerified: true,
      },
      job.agreement.verification.rubric!,
    );
    expect(validated.scoreBps).toBe(9300);
    expect(() =>
      validateAiVerificationResult({ ...validated, scoreBps: 9999 }, job.agreement.verification.rubric!),
    ).toThrow();
  });

  it('uses hard gates instead of averaging deterministic and AI signals', () => {
    const ai: AiVerificationResult = {
      providerAddress: `0x${'22'.repeat(20)}`,
      model: 'verified-model',
      chatId: 'chat-1',
      scoreBps: 9500,
      confidenceBps: 9000,
      criteria: [
        { id: 'quality', scoreBps: 9500, confidenceBps: 9000, explanation: 'Good.' },
      ],
      usage: {},
      rawResponse: '{}',
      responseVerified: true,
    };
    expect(
      determinePolicyVerificationResult({
        mode: 'deterministic_plus_ai',
        deterministicScoreBps: 8999,
        deterministicHardFailure: false,
        ai,
        minimumScoreBps: 9000,
        requireVerifiedAiResponse: true,
      }),
    ).toEqual({ outcome: 'FAIL', scoreBps: 8999 });
    expect(
      determinePolicyVerificationResult({
        mode: 'ai',
        deterministicScoreBps: 0,
        deterministicHardFailure: false,
        ai: { ...ai, responseVerified: null },
        minimumScoreBps: 9000,
        requireVerifiedAiResponse: true,
      }).outcome,
    ).toBe('NEEDS_REVIEW');
  });
});
