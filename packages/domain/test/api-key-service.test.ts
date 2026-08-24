import {
  ApiKeyPermissionDeniedError,
  ApiKeyScopeEscalationError,
  ApiKeyService,
  type ApiKeyCredentialRecord,
  type ApiKeyRecord,
  type ApiKeyRepository,
  type AuthPrincipal,
  type ListApiKeysPersistenceInput,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

class MemoryApiKeyRepository implements ApiKeyRepository {
  public readonly records = new Map<string, ApiKeyCredentialRecord>();

  public async create(record: ApiKeyCredentialRecord): Promise<ApiKeyCredentialRecord> {
    this.records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  public async findById(id: string): Promise<ApiKeyCredentialRecord | null> {
    const record = this.records.get(id);
    return record === undefined ? null : structuredClone(record);
  }

  public async list(
    input: ListApiKeysPersistenceInput,
  ): Promise<{ apiKeys: ApiKeyRecord[]; hasMore: boolean }> {
    const records = [...this.records.values()]
      .filter((record) => input.principalId === undefined || record.principalId === input.principalId)
      .filter(
        (record) => input.principalKind === undefined
          || record.principalKind === input.principalKind,
      )
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
    return {
      apiKeys: records.slice(0, input.limit).map(toPublic),
      hasMore: records.length > input.limit,
    };
  }

  public async markUsed(id: string, usedAt: string): Promise<void> {
    const record = this.records.get(id);
    if (record !== undefined) record.lastUsedAt = usedAt;
  }

  public async revoke(id: string, revokedAt: string): Promise<ApiKeyRecord | null> {
    const record = this.records.get(id);
    if (record === undefined) return null;
    record.revokedAt ??= revokedAt;
    return toPublic(record);
  }
}

const operator: AuthPrincipal = {
  id: 'operator_test',
  kind: 'operator',
  scopes: new Set([
    'jobs:read',
    'jobs:write',
    'jobs:fund',
    'jobs:assign',
    'jobs:submit',
    'jobs:verify',
    'jobs:settle',
    'jobs:reputation',
    'jobs:receipt',
    'api-keys:manage',
  ]),
};

function createService(repository: MemoryApiKeyRepository, clock = () => new Date('2026-08-24T12:00:00.000Z')) {
  return new ApiKeyService({
    repository,
    pepper: 'test-pepper-with-at-least-thirty-two-bytes',
    clock,
    idGenerator: () => '0198d462-75c0-7000-8000-000000000001',
    secretGenerator: () => 'A'.repeat(43),
  });
}

describe('ApiKeyService', () => {
  it('issues the secret once, stores only its digest, and authenticates its scopes', async () => {
    const repository = new MemoryApiKeyRepository();
    const service = createService(repository);
    const created = await service.createKey(
      {
        label: 'Provider runtime',
        principalId: 'erc8004:16602:456',
        principalKind: 'agent',
        scopes: ['jobs:read', 'jobs:submit'],
      },
      operator,
    );

    expect(created.secret).toBe(
      `ac_0198d462-75c0-7000-8000-000000000001.${'A'.repeat(43)}`,
    );
    expect(created.apiKey).not.toHaveProperty('secretDigest');
    const stored = repository.records.get(created.apiKey.id)!;
    expect(stored.secretDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(created.secret);

    await expect(service.authenticate(created.secret)).resolves.toEqual({
      id: 'erc8004:16602:456',
      kind: 'agent',
      scopes: new Set(['jobs:read', 'jobs:submit']),
    });
    expect(repository.records.get(created.apiKey.id)?.lastUsedAt).toBe(
      '2026-08-24T12:00:00.000Z',
    );
  });

  it('rejects malformed, incorrect, expired, and revoked credentials', async () => {
    let now = new Date('2026-08-24T12:00:00.000Z');
    const repository = new MemoryApiKeyRepository();
    const service = createService(repository, () => now);
    const created = await service.createKey(
      {
        label: 'Short lived',
        principalId: 'service_verifier',
        principalKind: 'service',
        scopes: ['jobs:verify'],
        expiresAt: '2026-08-24T13:00:00.000Z',
      },
      operator,
    );

    await expect(service.authenticate('not-an-agentclear-key')).resolves.toBeNull();
    await expect(service.authenticate(`${created.secret.slice(0, -1)}B`)).resolves.toBeNull();
    now = new Date('2026-08-24T13:00:00.000Z');
    await expect(service.authenticate(created.secret)).resolves.toBeNull();
    now = new Date('2026-08-24T12:30:00.000Z');
    await service.revokeKey(created.apiKey.id, operator);
    await expect(service.authenticate(created.secret)).resolves.toBeNull();
  });

  it('prevents scope escalation and cross-principal management', async () => {
    const repository = new MemoryApiKeyRepository();
    const service = createService(repository);
    const agent: AuthPrincipal = {
      id: 'erc8004:16602:456',
      kind: 'agent',
      scopes: new Set(['jobs:read', 'api-keys:manage']),
    };

    await expect(
      service.createKey(
        {
          label: 'Escalated',
          principalId: agent.id,
          principalKind: 'agent',
          scopes: ['jobs:fund'],
        },
        agent,
      ),
    ).rejects.toBeInstanceOf(ApiKeyScopeEscalationError);
    await expect(
      service.createKey(
        {
          label: 'Another agent',
          principalId: 'erc8004:16602:999',
          principalKind: 'agent',
          scopes: ['jobs:read'],
        },
        agent,
      ),
    ).rejects.toBeInstanceOf(ApiKeyPermissionDeniedError);
  });

  it('limits non-operators to listing and revoking their own keys', async () => {
    const repository = new MemoryApiKeyRepository();
    const service = createService(repository);
    const created = await service.createKey(
      {
        label: 'Provider runtime',
        principalId: 'erc8004:16602:456',
        principalKind: 'agent',
        scopes: ['jobs:read', 'api-keys:manage'],
      },
      operator,
    );
    const agent: AuthPrincipal = {
      id: 'erc8004:16602:456',
      kind: 'agent',
      scopes: new Set(['jobs:read', 'api-keys:manage']),
    };

    const listed = await service.listKeys({}, agent);
    expect(listed.apiKeys).toEqual([created.apiKey]);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    const revoked = await service.revokeKey(created.apiKey.id, agent);
    expect(revoked.revokedAt).toBe('2026-08-24T12:00:00.000Z');
  });
});

function toPublic(record: ApiKeyCredentialRecord): ApiKeyRecord {
  return {
    id: record.id,
    label: record.label,
    prefix: record.prefix,
    principalId: record.principalId,
    principalKind: record.principalKind,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
  };
}
