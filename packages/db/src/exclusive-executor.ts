import type { ExclusiveExecutor } from '@agentclear/domain';
import type { Pool } from 'pg';

const executorLockName = 'agentclear:chain-signer-executor';

/// Serializes all signer-backed work across API instances that share PostgreSQL.
export class PostgresExclusiveExecutor implements ExclusiveExecutor {
  public constructor(private readonly pool: Pool) {}

  public async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('select pg_advisory_lock(hashtext($1))', [executorLockName]);
      try {
        return await work();
      } finally {
        await client.query('select pg_advisory_unlock(hashtext($1))', [executorLockName]);
      }
    } finally {
      client.release();
    }
  }
}
