import { randomUUID } from 'node:crypto';

import type { ApiKeyCredentialRecord } from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresApiKeyRepository } from '../src/api-key-repository.js';
import { createDatabaseClient } from '../src/client.js';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined)('PostgresApiKeyRepository', () => {
  const client = createDatabaseClient(databaseUrl!);
  const repository = new PostgresApiKeyRepository(client.db);

  beforeEach(async () => {
    await client.db.execute(sql`truncate table api_keys`);
  });

  afterAll(async () => {
    await client.close();
  });

  it('persists only digests and supports stable listing, usage, and idempotent revocation', async () => {
    const older = keyRecord({
      id: randomUUID(),
      createdAt: '2026-08-24T10:00:00.000Z',
      secretDigest: 'a'.repeat(64),
    });
    const newer = keyRecord({
      id: randomUUID(),
      createdAt: '2026-08-24T11:00:00.000Z',
      secretDigest: 'b'.repeat(64),
    });
    await repository.create(older);
    await repository.create(newer);

    const first = await repository.list({ limit: 1 });
    expect(first.apiKeys).toHaveLength(1);
    expect(first.apiKeys[0]?.id).toBe(newer.id);
    expect(first.apiKeys[0]).not.toHaveProperty('secretDigest');
    expect(first.hasMore).toBe(true);
    const second = await repository.list({
      limit: 1,
      cursor: { id: newer.id, createdAt: newer.createdAt },
    });
    expect(second.apiKeys.map(({ id }) => id)).toEqual([older.id]);
    expect(second.hasMore).toBe(false);

    await repository.markUsed(newer.id, '2026-08-24T12:00:00.000Z');
    expect((await repository.findById(newer.id))?.lastUsedAt).toBe(
      '2026-08-24T12:00:00.000Z',
    );

    const firstRevocation = await repository.revoke(newer.id, '2026-08-24T13:00:00.000Z');
    const replayedRevocation = await repository.revoke(newer.id, '2026-08-24T14:00:00.000Z');
    expect(firstRevocation?.revokedAt).toBe('2026-08-24T13:00:00.000Z');
    expect(replayedRevocation?.revokedAt).toBe(firstRevocation?.revokedAt);
  });
});

function keyRecord(
  overrides: Pick<ApiKeyCredentialRecord, 'id' | 'createdAt' | 'secretDigest'>,
): ApiKeyCredentialRecord {
  return {
    id: overrides.id,
    label: 'Provider runtime',
    prefix: `ac_${overrides.id.slice(0, 8)}`,
    secretDigest: overrides.secretDigest,
    principalId: 'erc8004:16602:456',
    principalKind: 'agent',
    scopes: ['jobs:read', 'jobs:submit'],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdBy: 'operator_test',
    createdAt: overrides.createdAt,
  };
}
