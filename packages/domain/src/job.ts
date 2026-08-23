import { z } from 'zod';

import type { JobState } from './job-state.js';

const agentIdSchema = z.string().regex(/^erc8004:\d+:\d+$/, 'Expected erc8004:<chainId>:<tokenId>.');
const decimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, 'Expected a decimal string.');
const checkPathSchema = z
  .array(z.union([z.string().min(1).max(100), z.number().int().min(0).max(1_000_000)]))
  .min(1)
  .max(32);
const checkBaseSchema = {
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  description: z.string().trim().min(1).max(500),
  path: checkPathSchema,
  weightBps: z.number().int().min(1).max(10_000).default(10_000),
  hardFailure: z.boolean().default(true),
};

export const deterministicCheckSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...checkBaseSchema,
      kind: z.literal('json_path_exists'),
    })
    .strict(),
  z
    .object({
      ...checkBaseSchema,
      kind: z.literal('json_path_equals'),
      expected: z.json(),
    })
    .strict(),
  z
    .object({
      ...checkBaseSchema,
      kind: z.literal('json_type'),
      expectedType: z.enum(['null', 'boolean', 'number', 'string', 'array', 'object']),
    })
    .strict(),
]);

export type DeterministicCheck = z.infer<typeof deterministicCheckSchema>;
const verificationSchema = z
  .object({
    mode: z.enum(['deterministic', 'rubric', 'ai', 'deterministic_plus_ai']),
    minimumScore: z.number().min(0).max(1),
    requirements: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
    deterministicChecks: z.array(deterministicCheckSchema).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((verification, context) => {
    const deterministicMode =
      verification.mode === 'deterministic' || verification.mode === 'deterministic_plus_ai';
    if (deterministicMode && verification.deterministicChecks === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['deterministicChecks'],
        message: 'Deterministic verification modes require executable checks.',
      });
    }
    if (!deterministicMode && verification.deterministicChecks !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['deterministicChecks'],
        message: 'Deterministic checks require a deterministic verification mode.',
      });
    }
    const seen = new Set<string>();
    for (const [index, check] of (verification.deterministicChecks ?? []).entries()) {
      if (seen.has(check.id)) {
        context.addIssue({
          code: 'custom',
          path: ['deterministicChecks', index, 'id'],
          message: 'Deterministic check IDs must be unique.',
        });
      }
      seen.add(check.id);
    }
  });

export const createJobInputSchema = z
  .object({
    buyerAgentId: agentIdSchema,
    providerAgentId: agentIdSchema.optional(),
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(1).max(20_000),
    budget: z
      .object({
        token: z.literal('native'),
        maxAmount: decimalAmountSchema,
      })
      .strict(),
    deadline: z.iso.datetime({ offset: true }),
    deliverable: z
      .object({
        type: z.enum(['code', 'data', 'research', 'content', 'other']),
        format: z.string().trim().min(1).max(100),
      })
      .strict(),
    verification: verificationSchema,
    refundPolicy: z
      .object({
        onExpiry: z.boolean(),
        onFinalFailure: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type CreateJobInput = z.infer<typeof createJobInputSchema>;

export type JobAgreement = CreateJobInput & {
  jobId: string;
};

export type Job = {
  id: string;
  agreement: JobAgreement;
  providerAgentId: string | null;
  agreementHash: `0x${string}`;
  budgetAmountBaseUnits: string;
  minimumScoreBps: number;
  state: JobState;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type JobStateEvent = {
  id: string;
  jobId: string;
  fromState: JobState | null;
  toState: JobState;
  actorType: 'agent' | 'operator' | 'service' | 'verifier' | 'resolver';
  actorId: string;
  reason: string;
  transactionHash?: `0x${string}`;
  evidenceReference?: string;
  occurredAt: string;
};

export type JobActor = {
  type: JobStateEvent['actorType'];
  id: string;
};
