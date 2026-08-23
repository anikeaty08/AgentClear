import { describe, expect, it } from 'vitest';

import { canTransitionJob, getAllowedJobTransitions } from '../src/index.js';

describe('job state machine', () => {
  it('allows the successful settlement path', () => {
    const path = [
      'DRAFT',
      'QUOTED',
      'FUNDED',
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'SUBMITTED',
      'VERIFYING',
      'PASSED',
      'SETTLING',
      'PAID',
    ] as const;

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionJob(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it('does not let a provider-shaped flow skip verification and settle directly', () => {
    expect(canTransitionJob('SUBMITTED', 'PAID')).toBe(false);
    expect(canTransitionJob('IN_PROGRESS', 'PASSED')).toBe(false);
  });

  it('keeps paid jobs terminal', () => {
    expect(getAllowedJobTransitions('PAID')).toEqual([]);
  });
});

