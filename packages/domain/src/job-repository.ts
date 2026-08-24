import type { Job, JobStateEvent } from './job.js';
import type { JobState } from './job-state.js';

export type IdempotencyClaim = {
  scope: string;
  key: string;
  requestHash: `0x${string}`;
  resourceId: string;
  expiresAt: string;
};

export type CreateJobPersistenceInput = {
  job: Job;
  initialEvent: JobStateEvent;
  idempotency: IdempotencyClaim;
};

export type CreateJobPersistenceResult = {
  job: Job;
  replayed: boolean;
};

export type TransitionJobPersistenceInput = {
  jobId: string;
  expectedState: JobState;
  nextState: JobState;
  event: JobStateEvent;
  idempotency: IdempotencyClaim;
};

export type TransitionJobPersistenceResult = {
  job: Job;
  replayed: boolean;
};

export type JobListCursor = {
  createdAt: string;
  id: string;
};

export type ListJobsPersistenceInput = {
  state?: JobState;
  buyerAgentId?: string;
  providerAgentId?: string;
  cursor?: JobListCursor;
  limit: number;
};

export type ListJobsPersistenceResult = {
  jobs: Job[];
  hasMore: boolean;
};

export interface JobListRepository {
  list(input: ListJobsPersistenceInput): Promise<ListJobsPersistenceResult>;
}

export interface JobRepository {
  create(input: CreateJobPersistenceInput): Promise<CreateJobPersistenceResult>;
  findById(jobId: string): Promise<Job | null>;
  transition(input: TransitionJobPersistenceInput): Promise<TransitionJobPersistenceResult>;
  ping(): Promise<void>;
}
