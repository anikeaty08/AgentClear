import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../src/client.js';
import { PostgresExclusiveExecutor } from '../src/exclusive-executor.js';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined)('PostgresExclusiveExecutor', () => {
  const firstClient = createDatabaseClient(databaseUrl!);
  const secondClient = createDatabaseClient(databaseUrl!);

  afterAll(async () => {
    await Promise.all([firstClient.close(), secondClient.close()]);
  });

  it('serializes signer work across independent database pools', async () => {
    const first = new PostgresExclusiveExecutor(firstClient.pool);
    const second = new PostgresExclusiveExecutor(secondClient.pool);
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const run = async (label: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${label}:start`);
      await delay(25);
      order.push(`${label}:end`);
      active -= 1;
    };

    await Promise.all([
      first.runExclusive(async () => run('first')),
      second.runExclusive(async () => run('second')),
    ]);

    expect(maximumActive).toBe(1);
    expect(order).toHaveLength(4);
    expect(order[0]?.replace(':start', '')).toBe(order[1]?.replace(':end', ''));
    expect(order[2]?.replace(':start', '')).toBe(order[3]?.replace(':end', ''));
    expect(order[0]?.replace(':start', '')).not.toBe(order[2]?.replace(':start', ''));
  });
});
