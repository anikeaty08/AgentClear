import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes } from 'viem';

import {
  ChainConfigurationError,
  agentIdentityToHash,
  deadlineToUnixSeconds,
  jobIdToEscrowKey,
} from '../src/index.js';

describe('job escrow chain normalization', () => {
  it('derives a stable bytes32 key from the external job ID', () => {
    const jobId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b80';
    expect(jobIdToEscrowKey(jobId)).toBe(keccak256(stringToBytes(jobId)));
  });

  it('converts an ISO deadline without floating point token math', () => {
    expect(deadlineToUnixSeconds('2030-01-01T00:00:00.000Z')).toBe(1_893_456_000n);
  });

  it('rejects empty identifiers and invalid deadlines', () => {
    expect(() => jobIdToEscrowKey('')).toThrow(ChainConfigurationError);
    expect(() => deadlineToUnixSeconds('not-a-date')).toThrow(ChainConfigurationError);
  });

  it('commits only canonical ERC-8004 identity strings', () => {
    expect(agentIdentityToHash('erc8004:16602:123')).toBe(
      keccak256(stringToBytes('erc8004:16602:123')),
    );
    expect(() => agentIdentityToHash('agent-123')).toThrow(ChainConfigurationError);
  });
});
