import { describe, expect, it } from 'vitest';

import {
  createJobInputSchema,
  determineVerificationOutcome,
  evaluateDeterministicChecks,
  type DeterministicCheck,
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
});
