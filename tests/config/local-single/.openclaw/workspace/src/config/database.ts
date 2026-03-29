import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/erp',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

export const db = {
  query: <T = unknown>(text: string, params?: unknown[]) =>
    pool.query<T>(text, params),
  getClient: () => pool.connect(),
};

export default pool;
