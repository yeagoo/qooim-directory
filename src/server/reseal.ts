import type { Pool } from "pg";
import { keyId, seal, unseal } from "./crypto.js";

// Every column sealed with AUTH_ENCRYPTION_KEY, with its primary key.
const TARGETS = [
  { table: "auth_instance", column: "sealed_secret", key: ["id"] },
  { table: "auth_provider", column: "sealed_config", key: ["instance_id", "id"] },
  { table: "ai_config", column: "sealed_key", key: ["site_id"] },
  { table: "mail_queue", column: "payload", key: ["id"] },
] as const;

// Rewrites every sealed value with the current key. Resumable: values already
// sealed with it are skipped, and each row is replaced only if it is unchanged
// (compare-and-set), so it can run while the application is up.
export async function reseal(pool: Pool, key: string, batch = 200) {
  const prefix = `v1.${keyId(key)}.`;
  const result: Record<string, { resealed: number; failed: number }> = {};
  for (const target of TARGETS) {
    const counts = { resealed: 0, failed: 0 };
    const keys = target.key.join(",");
    let after: unknown[] | null = null;
    for (;;) {
      const placeholders = target.key.map((_, i) => `$${i + 2}`).join(",");
      const { rows }: { rows: Record<string, unknown>[] } = await pool.query(
        `SELECT ${keys},${target.column} AS value FROM ${target.table}
          WHERE ${target.column} IS NOT NULL AND left(${target.column},${prefix.length})<>$1
            ${after ? `AND (${keys})>(${placeholders})` : ""}
          ORDER BY ${keys} LIMIT ${batch}`,
        after ? [prefix, ...after] : [prefix],
      );
      for (const row of rows) {
        const id = target.key.map((column) => row[column]);
        try {
          const fresh = seal(unseal(row.value as string, key), key);
          const where = target.key.map((column, i) => `${column}=$${i + 3}`).join(" AND ");
          const updated = await pool.query(
            `UPDATE ${target.table} SET ${target.column}=$1 WHERE ${target.column}=$2 AND ${where}`,
            [fresh, row.value, ...id],
          );
          counts.resealed += updated.rowCount ?? 0;
        } catch {
          // Unknown key (not listed in AUTH_ENCRYPTION_KEY_PREVIOUS): left as is.
          counts.failed++;
        }
      }
      if (rows.length < batch) break;
      const last: Record<string, unknown> = rows[rows.length - 1];
      after = target.key.map((column): unknown => last[column]);
    }
    result[target.table] = counts;
  }
  return result;
}
