import {
  ApiKeyPermissionDeniedError,
  SpendingPolicyService,
  type AuthPrincipal,
  type FundingAuthorizationDecision,
  type SpendingPolicy,
  type SpendingPolicyRepository,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

class MemorySpendingPolicyRepository implements SpendingPolicyRepository {
  public policy: SpendingPolicy | null = null;
  public approval: FundingAuthorizationDecision = { outcome: 'POLICY_NOT_FOUND' };

  public async upsertPolicy(policy: SpendingPolicy): Promise<SpendingPolicy> {
    this.policy = structuredClone(policy);
    return structuredClone(policy);
  }

  public async findPolicy(principalId: string): Promise<SpendingPolicy | null> {
    return this.policy?.principalId === principalId ? structuredClone(this.policy) : null;
  }

  public async authorizeFunding(): Promise<FundingAuthorizationDecision> {
    return { outcome: 'POLICY_NOT_FOUND' };
  }

  public async approveFunding(): Promise<FundingAuthorizationDecision> {
    return this.approval;
  }
}

const operator: AuthPrincipal = {
  id: 'operator_test',
  kind: 'operator',
  scopes: new Set(['spending-policies:manage']),
};

const validPolicy = {
  principalKind: 'agent',
  maxPerJobBaseUnits: '500',
  maxPerDayBaseUnits: '1000',
  maxPerMonthBaseUnits: '10000',
  allowedCapabilities: ['code', 'research'],
  requireHumanApprovalAboveBaseUnits: '300',
} as const;

describe('SpendingPolicyService', () => {
  it('creates and updates a lossless policy while preserving its creation audit fields', async () => {
    let now = new Date('2026-08-24T12:00:00.000Z');
    const repository = new MemorySpendingPolicyRepository();
    const service = new SpendingPolicyService({ repository, clock: () => now });

    const created = await service.putPolicy('erc8004:16602:123', validPolicy, operator);
    now = new Date('2026-08-24T13:00:00.000Z');
    const updated = await service.putPolicy(
      'erc8004:16602:123',
      { ...validPolicy, maxPerDayBaseUnits: '2000' },
      operator,
    );

    expect(created.createdAt).toBe('2026-08-24T12:00:00.000Z');
    expect(updated).toMatchObject({
      createdAt: created.createdAt,
      createdBy: operator.id,
      updatedAt: '2026-08-24T13:00:00.000Z',
      maxPerDayBaseUnits: '2000',
    });
    await expect(service.getPolicy('erc8004:16602:123', operator)).resolves.toEqual(updated);
  });

  it('rejects invalid limit ordering and non-operator policy mutation', async () => {
    const repository = new MemorySpendingPolicyRepository();
    const service = new SpendingPolicyService({ repository });
    await expect(
      service.putPolicy(
        'erc8004:16602:123',
        { ...validPolicy, maxPerDayBaseUnits: '100' },
        operator,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      service.putPolicy('erc8004:16602:123', validPolicy, {
        id: 'erc8004:16602:123',
        kind: 'agent',
        scopes: new Set(['spending-policies:manage']),
      }),
    ).rejects.toBeInstanceOf(ApiKeyPermissionDeniedError);
  });
});
