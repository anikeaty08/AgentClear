import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson } from './canonical.js';
import {
  ApiKeyExpiryInvalidError,
  ApiKeyNotFoundError,
  ApiKeyPermissionDeniedError,
  ApiKeyScopeEscalationError,
} from './errors.js';

export const AUTH_SCOPES = [
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
  'spending-policies:manage',
] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

export const AUTH_PRINCIPAL_KINDS = ['operator', 'agent', 'service'] as const;
export type AuthPrincipalKind = (typeof AUTH_PRINCIPAL_KINDS)[number];

export type AuthPrincipal = {
  id: string;
  kind: AuthPrincipalKind;
  scopes: ReadonlySet<AuthScope>;
};

const principalIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const apiKeyIdSchema = z.uuid();
const apiKeyScopeSchema = z.enum(AUTH_SCOPES);

export const createApiKeyInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    principalId: principalIdSchema,
    principalKind: z.enum(AUTH_PRINCIPAL_KINDS),
    scopes: z
      .array(apiKeyScopeSchema)
      .min(1)
      .max(AUTH_SCOPES.length)
      .refine((scopes) => new Set(scopes).size === scopes.length, 'Scopes must be unique.'),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.principalKind === 'agent' && !/^erc8004:\d+:\d+$/u.test(input.principalId)) {
      context.addIssue({
        code: 'custom',
        path: ['principalId'],
        message: 'Agent principals must use an ERC-8004 identity.',
      });
    }
  });

export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;

export const listApiKeysInputSchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const apiKeyCursorSchema = z
  .object({ createdAt: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();

export type ApiKeyRecord = {
  id: string;
  label: string;
  prefix: string;
  principalId: string;
  principalKind: AuthPrincipalKind;
  scopes: AuthScope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
};

export type ApiKeyCredentialRecord = ApiKeyRecord & {
  secretDigest: string;
};

export type ApiKeyListCursor = {
  createdAt: string;
  id: string;
};

export type ListApiKeysPersistenceInput = {
  principalId?: string;
  principalKind?: AuthPrincipalKind;
  cursor?: ApiKeyListCursor;
  limit: number;
};

export interface ApiKeyRepository {
  create(record: ApiKeyCredentialRecord): Promise<ApiKeyCredentialRecord>;
  findById(id: string): Promise<ApiKeyCredentialRecord | null>;
  list(input: ListApiKeysPersistenceInput): Promise<{
    apiKeys: ApiKeyRecord[];
    hasMore: boolean;
  }>;
  markUsed(id: string, usedAt: string): Promise<void>;
  revoke(id: string, revokedAt: string): Promise<ApiKeyRecord | null>;
}

export type ApiKeyServiceDependencies = {
  repository: ApiKeyRepository;
  pepper: string;
  clock?: () => Date;
  idGenerator?: () => string;
  secretGenerator?: () => string;
};

export class ApiKeyService {
  readonly #repository: ApiKeyRepository;
  readonly #pepper: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #secretGenerator: () => string;

  public constructor(dependencies: ApiKeyServiceDependencies) {
    if (Buffer.byteLength(dependencies.pepper, 'utf8') < 32) {
      throw new TypeError('The API key pepper must contain at least 32 bytes.');
    }
    this.#repository = dependencies.repository;
    this.#pepper = dependencies.pepper;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
    this.#secretGenerator = dependencies.secretGenerator ?? (() => randomBytes(32).toString('base64url'));
  }

  public async createKey(
    rawInput: unknown,
    actor: AuthPrincipal,
  ): Promise<{ apiKey: ApiKeyRecord; secret: string }> {
    this.#requireManager(actor);
    const input = createApiKeyInputSchema.parse(rawInput);
    this.#requirePrincipalAccess(actor, input.principalId, input.principalKind);
    if (input.scopes.some((scope) => !actor.scopes.has(scope))) {
      throw new ApiKeyScopeEscalationError();
    }
    const now = this.#clock();
    if (input.expiresAt !== undefined && new Date(input.expiresAt).getTime() <= now.getTime()) {
      throw new ApiKeyExpiryInvalidError();
    }
    const id = apiKeyIdSchema.parse(this.#idGenerator());
    const randomSecret = this.#secretGenerator();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(randomSecret)) {
      throw new TypeError('The API key secret generator returned an invalid 256-bit secret.');
    }
    const secret = `ac_${id}.${randomSecret}`;
    const record = await this.#repository.create({
      id,
      label: input.label,
      prefix: `ac_${id.slice(0, 8)}`,
      principalId: input.principalId,
      principalKind: input.principalKind,
      scopes: [...input.scopes],
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      lastUsedAt: null,
      createdBy: actor.id,
      createdAt: now.toISOString(),
      secretDigest: digestApiKey(secret, this.#pepper),
    });
    return { apiKey: publicApiKey(record), secret };
  }

  public async authenticate(secret: string): Promise<AuthPrincipal | null> {
    const parsed = parseApiKey(secret);
    if (parsed === null) return null;
    const record = await this.#repository.findById(parsed.id);
    if (record === null || record.revokedAt !== null) return null;
    const now = this.#clock();
    if (record.expiresAt !== null && new Date(record.expiresAt).getTime() <= now.getTime()) {
      return null;
    }
    if (!constantTimeDigestEqual(digestApiKey(secret, this.#pepper), record.secretDigest)) {
      return null;
    }
    const scopes = z.array(apiKeyScopeSchema).min(1).safeParse(record.scopes);
    if (!scopes.success) return null;
    await this.#repository.markUsed(record.id, now.toISOString());
    return {
      id: record.principalId,
      kind: record.principalKind,
      scopes: new Set(scopes.data),
    };
  }

  public async listKeys(
    rawInput: unknown,
    actor: AuthPrincipal,
  ): Promise<{ apiKeys: ApiKeyRecord[]; nextCursor: string | null }> {
    this.#requireManager(actor);
    const input = listApiKeysInputSchema.parse(rawInput);
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const page = await this.#repository.list({
      ...(actor.kind === 'operator'
        ? {}
        : { principalId: actor.id, principalKind: actor.kind }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: input.limit,
    });
    const last = page.apiKeys.at(-1);
    return {
      apiKeys: page.apiKeys,
      nextCursor: page.hasMore && last !== undefined
        ? Buffer.from(canonicalJson({ createdAt: last.createdAt, id: last.id })).toString('base64url')
        : null,
    };
  }

  public async revokeKey(id: string, actor: AuthPrincipal): Promise<ApiKeyRecord> {
    this.#requireManager(actor);
    const keyId = apiKeyIdSchema.parse(id);
    const existing = await this.#repository.findById(keyId);
    if (existing === null) throw new ApiKeyNotFoundError(keyId);
    this.#requirePrincipalAccess(actor, existing.principalId, existing.principalKind);
    const revoked = await this.#repository.revoke(keyId, this.#clock().toISOString());
    if (revoked === null) throw new ApiKeyNotFoundError(keyId);
    return revoked;
  }

  #requireManager(actor: AuthPrincipal): void {
    if (!actor.scopes.has('api-keys:manage')) throw new ApiKeyPermissionDeniedError();
  }

  #requirePrincipalAccess(
    actor: AuthPrincipal,
    principalId: string,
    principalKind: AuthPrincipalKind,
  ): void {
    if (actor.kind !== 'operator' && (actor.id !== principalId || actor.kind !== principalKind)) {
      throw new ApiKeyPermissionDeniedError();
    }
  }
}

function digestApiKey(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret, 'utf8').digest('hex');
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function parseApiKey(secret: string): { id: string } | null {
  const match = /^ac_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/iu.exec(secret);
  const id = match?.[1];
  if (id === undefined) return null;
  const parsed = apiKeyIdSchema.safeParse(id);
  return parsed.success ? { id: parsed.data } : null;
}

function decodeCursor(value: string): ApiKeyListCursor {
  try {
    return apiKeyCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    return apiKeyCursorSchema.parse(null);
  }
}

function publicApiKey(record: ApiKeyCredentialRecord): ApiKeyRecord {
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
