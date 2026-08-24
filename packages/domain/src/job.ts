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
  weightBps: z.number().int().min(1).max(10_000).default(10_000),
  hardFailure: z.boolean().default(true),
};

const jsonCheckBaseSchema = {
  ...checkBaseSchema,
  path: checkPathSchema,
};

export const sandboxTestVectorSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
    input: z.json(),
    expected: z.json(),
  })
  .strict();

export type SandboxTestVector = z.infer<typeof sandboxTestVectorSchema>;

const sandboxCheckSchema = z
  .object({
    ...checkBaseSchema,
    kind: z.literal('sandbox_tests'),
    runtime: z.literal('node24'),
    entryFile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,98}\.mjs$/),
    exportName: z.string().regex(/^(?:default|[A-Za-z_$][A-Za-z0-9_$]{0,99})$/),
    testVectors: z.array(sandboxTestVectorSchema).min(1).max(100),
  })
  .strict()
  .superRefine((check, context) => {
    const ids = new Set<string>();
    for (const [index, test] of check.testVectors.entries()) {
      if (ids.has(test.id)) {
        context.addIssue({
          code: 'custom',
          path: ['testVectors', index, 'id'],
          message: 'Sandbox test vector IDs must be unique.',
        });
      }
      ids.add(test.id);
    }
  });

export const deterministicCheckSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...jsonCheckBaseSchema,
      kind: z.literal('json_path_exists'),
    })
    .strict(),
  z
    .object({
      ...jsonCheckBaseSchema,
      kind: z.literal('json_path_equals'),
      expected: z.json(),
    })
    .strict(),
  z
    .object({
      ...jsonCheckBaseSchema,
      kind: z.literal('json_type'),
      expectedType: z.enum(['null', 'boolean', 'number', 'string', 'array', 'object']),
    })
    .strict(),
  sandboxCheckSchema,
]);

export type DeterministicCheck = z.infer<typeof deterministicCheckSchema>;
export const rubricCriterionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
    description: z.string().trim().min(1).max(1_000),
    weightBps: z.number().int().min(1).max(10_000),
  })
  .strict();

export const verificationRubricSchema = z
  .object({
    criteria: z.array(rubricCriterionSchema).min(1).max(20),
  })
  .strict()
  .superRefine((rubric, context) => {
    const ids = new Set<string>();
    let totalWeightBps = 0;
    for (const [index, criterion] of rubric.criteria.entries()) {
      if (ids.has(criterion.id)) {
        context.addIssue({
          code: 'custom',
          path: ['criteria', index, 'id'],
          message: 'Rubric criterion IDs must be unique.',
        });
      }
      ids.add(criterion.id);
      totalWeightBps += criterion.weightBps;
    }
    if (totalWeightBps !== 10_000) {
      context.addIssue({
        code: 'custom',
        path: ['criteria'],
        message: 'Rubric criterion weights must total exactly 10000 basis points.',
      });
    }
  });

export type VerificationRubric = z.infer<typeof verificationRubricSchema>;
const verificationSchema = z
  .object({
    mode: z.enum(['deterministic', 'rubric', 'ai', 'deterministic_plus_ai']),
    minimumScore: z.number().min(0).max(1),
    requirements: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
    deterministicChecks: z.array(deterministicCheckSchema).min(1).max(50).optional(),
    rubric: verificationRubricSchema.optional(),
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
    const aiMode = verification.mode !== 'deterministic';
    if (aiMode && verification.rubric === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['rubric'],
        message: 'AI verification modes require a machine-readable rubric.',
      });
    }
    if (!aiMode && verification.rubric !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['rubric'],
        message: 'A rubric requires an AI verification mode.',
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

export const DELIVERABLE_TYPES = ['code', 'data', 'research', 'content', 'other'] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

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
        type: z.enum(DELIVERABLE_TYPES),
        format: z.string().trim().min(1).max(100),
      })
      .strict(),
    verification: verificationSchema,
    refundPolicy: z
      .object({
        onExpiry: z.literal(true),
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
