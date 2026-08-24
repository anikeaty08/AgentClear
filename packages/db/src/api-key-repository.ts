import type {
  ApiKeyCredentialRecord,
  ApiKeyRecord,
  ApiKeyRepository,
  ListApiKeysPersistenceInput,
} from '@agentclear/domain';
import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import { apiKeys } from './schema.js';

function rowToCredential(row: typeof apiKeys.$inferSelect): ApiKeyCredentialRecord {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    secretDigest: row.secretDigest,
    principalId: row.principalId,
    principalKind: row.principalKind,
    scopes: row.scopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToPublic(row: typeof apiKeys.$inferSelect): ApiKeyRecord {
  const credential = rowToCredential(row);
  return {
    id: credential.id,
    label: credential.label,
    prefix: credential.prefix,
    principalId: credential.principalId,
    principalKind: credential.principalKind,
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    lastUsedAt: credential.lastUsedAt,
    createdBy: credential.createdBy,
    createdAt: credential.createdAt,
  };
}

export class PostgresApiKeyRepository implements ApiKeyRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async create(record: ApiKeyCredentialRecord): Promise<ApiKeyCredentialRecord> {
    const [created] = await this.database
      .insert(apiKeys)
      .values({
        id: record.id,
        label: record.label,
        prefix: record.prefix,
        secretDigest: record.secretDigest,
        principalId: record.principalId,
        principalKind: record.principalKind,
        scopes: record.scopes,
        expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt),
        revokedAt: null,
        lastUsedAt: null,
        createdBy: record.createdBy,
        createdAt: new Date(record.createdAt),
      })
      .returning();
    if (created === undefined) throw new Error('API key insert returned no row.');
    return rowToCredential(created);
  }

  public async findById(id: string): Promise<ApiKeyCredentialRecord | null> {
    const [row] = await this.database.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return row === undefined ? null : rowToCredential(row);
  }

  public async list(
    input: ListApiKeysPersistenceInput,
  ): Promise<{ apiKeys: ApiKeyRecord[]; hasMore: boolean }> {
    const conditions: SQL[] = [];
    if (input.principalId !== undefined) {
      conditions.push(eq(apiKeys.principalId, input.principalId));
    }
    if (input.principalKind !== undefined) {
      conditions.push(eq(apiKeys.principalKind, input.principalKind));
    }
    if (input.cursor !== undefined) {
      const createdAt = new Date(input.cursor.createdAt);
      conditions.push(
        or(
          lt(apiKeys.createdAt, createdAt),
          and(eq(apiKeys.createdAt, createdAt), lt(apiKeys.id, input.cursor.id)),
        )!,
      );
    }
    const rows = await this.database
      .select()
      .from(apiKeys)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
      .limit(input.limit + 1);
    return {
      apiKeys: rows.slice(0, input.limit).map(rowToPublic),
      hasMore: rows.length > input.limit,
    };
  }

  public async markUsed(id: string, usedAt: string): Promise<void> {
    await this.database
      .update(apiKeys)
      .set({ lastUsedAt: new Date(usedAt) })
      .where(eq(apiKeys.id, id));
  }

  public async revoke(id: string, revokedAt: string): Promise<ApiKeyRecord | null> {
    const [row] = await this.database
      .update(apiKeys)
      .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, ${new Date(revokedAt)})` })
      .where(eq(apiKeys.id, id))
      .returning();
    return row === undefined ? null : rowToPublic(row);
  }
}
