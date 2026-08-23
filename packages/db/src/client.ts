import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { databaseSchema } from './schema.js';

export type AgentClearDatabase = NodePgDatabase<typeof databaseSchema>;

export type DatabaseClient = {
  db: AgentClearDatabase;
  pool: Pool;
  close: () => Promise<void>;
};

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    db: drizzle(pool, { schema: databaseSchema }),
    pool,
    close: async () => pool.end(),
  };
}

