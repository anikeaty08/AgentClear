export const JOB_STATES = [
  'DRAFT',
  'QUOTED',
  'FUNDED',
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'SUBMITTED',
  'VERIFYING',
  'PASSED',
  'FAILED',
  'NEEDS_REVIEW',
  'SETTLING',
  'RETRY',
  'DISPUTED',
  'PAID',
  'FAILED_FINAL',
  'RESOLVED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type JobState = (typeof JOB_STATES)[number];

const allowedTransitions = {
  DRAFT: ['QUOTED', 'CANCELLED', 'EXPIRED'],
  QUOTED: ['FUNDED', 'CANCELLED', 'EXPIRED'],
  FUNDED: ['OPEN', 'CANCELLED', 'EXPIRED'],
  OPEN: ['ASSIGNED', 'CANCELLED', 'EXPIRED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED', 'EXPIRED'],
  IN_PROGRESS: ['SUBMITTED', 'EXPIRED'],
  SUBMITTED: ['VERIFYING', 'DISPUTED'],
  VERIFYING: ['PASSED', 'FAILED', 'NEEDS_REVIEW'],
  PASSED: ['SETTLING', 'DISPUTED'],
  FAILED: ['RETRY', 'FAILED_FINAL', 'NEEDS_REVIEW'],
  NEEDS_REVIEW: ['DISPUTED'],
  SETTLING: ['PAID', 'DISPUTED'],
  RETRY: ['IN_PROGRESS', 'FAILED_FINAL', 'EXPIRED'],
  DISPUTED: ['RESOLVED'],
  FAILED_FINAL: ['REFUNDED', 'DISPUTED'],
  RESOLVED: ['SETTLING', 'REFUNDED'],
  PAID: [],
  REFUNDED: [],
  CANCELLED: [],
  EXPIRED: ['REFUNDED'],
} satisfies Record<JobState, readonly JobState[]>;

export const TERMINAL_JOB_STATES = ['PAID', 'REFUNDED', 'CANCELLED'] as const satisfies readonly JobState[];

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return allowedTransitions[from].includes(to as never);
}

export function getAllowedJobTransitions(from: JobState): readonly JobState[] {
  return allowedTransitions[from];
}
