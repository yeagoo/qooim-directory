import type { Pool } from "pg";
import { keyId, seal, unseal } from "./crypto.js";

// Every column sealed with AUTH_ENCRYPTION_KEY, with its primary key.
const TARGETS = [
  { table: "auth_instance", column: "sealed_secret", key: ["id"] },
  { table: "auth_provider", column: "sealed_config", key: ["instance_id", "id"] },
  { table: "ai_config", column: "sealed_key", key: ["site_id"] },
  { table: "mail_queue", column: "payload", key: ["id"] },
] as const;

// Rewrites every sealed value with the current key, then audits every row.
// Resumable: values already on the current key are not rewritten, and each row is
// replaced only if unchanged (compare-and-set), so it can run while the application
// is up. The result per table: `resealed` rows rewritten now, `remaining` rows still
// not on the current key (a concurrent writer using the old key, or a row the known
// keys cannot open) and `unreadable` rows no known key opens. Remove
// AUTH_ENCRYPTION_KEY_PREVIOUS only after a run reports 0 remaining and 0 unreadable
// with every application process already on the new key.
export async function reseal(pool: Pool, key: string, batch = 200) {
  const prefix = `v1.${keyId(key)}.`;
  const result: Record<string, { resealed: number; remaining: number; unreadable: number }> = {};
  for (const target of TARGETS) {
    const counts = { resealed: 0, remaining: 0, unreadable: 0 };
    const keys = target.key.join(",");
    const scan = async (
      filter: string,
      visit: (row: Record<string, unknown>) => Promise<void>,
    ) => {
      let after: unknown[] | null = null;
      for (;;) {
        const placeholders = target.key.map((_, i) => `$${i + 2}`).join(",");
        const { rows }: { rows: Record<string, unknown>[] } = await pool.query(
          `SELECT ${keys},${target.column} AS value FROM ${target.table}
            WHERE ${target.column} IS NOT NULL ${filter}
              ${after ? `AND (${keys})>(${placeholders})` : ""}
            ORDER BY ${keys} LIMIT ${batch}`,
          after ? [prefix, ...after] : [prefix],
        );
        for (const row of rows) await visit(row);
        if (rows.length < batch) break;
        const last: Record<string, unknown> = rows[rows.length - 1];
        after = target.key.map((column): unknown => last[column]);
      }
    };
    await scan(`AND left(${target.column},length($1))<>$1`, async (row) => {
      const id = target.key.map((column) => row[column]);
      let fresh: string;
      try {
        fresh = seal(unseal(row.value as string, key), key);
      } catch {
        return; // Counted by the audit below.
      }
      const where = target.key.map((column, i) => `${column}=$${i + 3}`).join(" AND ");
      const updated = await pool.query(
        `UPDATE ${target.table} SET ${target.column}=$1 WHERE ${target.column}=$2 AND ${where}`,
        [fresh, row.value, ...id],
      );
      counts.resealed += updated.rowCount ?? 0;
    });
    // Audit every row, including ones already carrying the current key id.
    await scan(`AND $1::text IS NOT NULL`, async (row) => {
      const value = row.value as string;
      if (!value.startsWith(prefix)) counts.remaining++;
      try {
        unseal(value, key);
      } catch {
        counts.unreadable++;
      }
    });
    result[target.table] = counts;
  }
  return result;
}
