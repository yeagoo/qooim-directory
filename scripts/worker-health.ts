import { Pool } from "pg";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 2000,
  query_timeout: 2000,
});
try {
  const r = await pool.query(
    "SELECT 1 FROM maintenance_status WHERE name='worker' AND completed_at>now()-interval '2 minutes'",
  );
  process.exitCode = r.rowCount ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
