import { z } from 'zod';

import type { JobState } from './job-state.js';

const agentIdSchema = z.string().regex(/^erc8004:\d+:\d+$/, 'Expected erc8004:<chainId>:<tokenId>.');
const decimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, 'Expected a decimal string.');

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
    verification: z
      .object({
        mode: z.enum(['deterministic', 'rubric', 'ai', 'deterministic_plus_ai']),
        minimumScore: z.number().min(0).max(1),
        requirements: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
      })
      .strict(),
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

