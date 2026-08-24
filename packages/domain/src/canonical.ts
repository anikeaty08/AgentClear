import { createHash } from 'node:crypto';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

function normalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Canonical JSON cannot contain a non-finite number.');
  }

  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalizeJson(value));
}

export function sha256Commitment(value: JsonValue): `0x${string}` {
  return `0x${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function sha256Bytes(value: Uint8Array): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}
