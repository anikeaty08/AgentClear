import { z } from 'zod';

import type { JsonValue } from './canonical.js';
import type { SandboxTestVector } from './job.js';

const sandboxFileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.mjs$/);

export const sandboxSubmissionSchema = z
  .object({
    files: z.record(sandboxFileNameSchema, z.string()),
  })
  .passthrough()
  .superRefine((submission, context) => {
    const names = Object.keys(submission.files);
    if (names.length === 0 || names.length > 32) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Code submissions must contain between 1 and 32 module files.',
      });
    }
  });

export type SandboxExecutionRequest = {
  runtime: 'node24';
  files: Readonly<Record<string, string>>;
  entryFile: string;
  exportName: string;
  testVectors: readonly SandboxTestVector[];
};

export type SandboxExecutionResult = {
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
  testCount: number;
  passedTests: number;
  failedTests: number;
  timedOut: boolean;
  outputTruncated: boolean;
  outOfMemory: boolean;
  artifactHash: `0x${string}`;
};

export interface SandboxVerifier {
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}

export function parseSandboxSubmission(result: JsonValue): Readonly<Record<string, string>> | null {
  const parsed = sandboxSubmissionSchema.safeParse(result);
  return parsed.success ? parsed.data.files : null;
}
