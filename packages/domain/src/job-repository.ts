import type { Job, JobStateEvent } from './job.js';

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

export interface JobRepository {
  create(input: CreateJobPersistenceInput): Promise<CreateJobPersistenceResult>;
  findById(jobId: string): Promise<Job | null>;
  ping(): Promise<void>;
}

