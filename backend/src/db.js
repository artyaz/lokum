import 'dotenv/config';

// FAKE_DB=1 swaps the real Neon/Postgres pool for an in-memory fake that
// implements the same query/one/many API and is seeded with sample data.
// Everything else in the app keeps using db.js exactly as before.
const USE_FAKE = process.env.FAKE_DB === '1' || (process.env.DATABASE_URL || '').startsWith('fake:');

let pool, query;

if (USE_FAKE) {
  const fake = await import('./fakedb/index.js');
  pool = fake.pool;
  query = fake.query;
  console.log('[db] FAKE_DB mode — in-memory sample data');
} else {
  const pg = (await import('pg')).default;
  const { Pool } = pg;

  // DATABASE_URL is required (see backend/.env.example). There is deliberately
  // no hardcoded fallback: a committed connection string would leak database
  // credentials to anyone with read access to this repo.
  const connectionString = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')
    ? process.env.DATABASE_URL
    : null;
  if (!connectionString) {
    throw new Error('[db] DATABASE_URL is not set (or is not a postgres URL). Copy backend/.env.example to backend/.env and fill in real values.');
  }

  // Pool tuning (Task A3): the previous values (max:8, idle:30s, conn:15s)
  // left 8 sockets pinned open between cron ticks — and the always-on server
  // sits mostly idle between user requests, so 8 persistent connections waste
  // RAM both in Node and on the Neon pooler. max:5 fits the actual concurrency
  // (a single cron run is sequential per (source, city); the always-on server
  // handles a handful of concurrent API requests). idleTimeoutMillis:5000
  // lets the pool shrink to 0 between fetch cycles so the idle load is
  // genuinely ~0. connectionTimeoutMillis:5000 fails fast on a stuck Neon
  // pooler instead of holding a request for 15s.
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false }
  });

  query = (text, params) => pool.query(text, params);

  pool.on('error', (err) => {
    console.error('[db] pool error:', err.message);
  });
}

export { pool, query };

export const one = async (text, params) => {
  const r = await query(text, params);
  return r.rows[0];
};

export const many = async (text, params) => {
  const r = await query(text, params);
  return r.rows;
};
