import type { Pool } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { transaction } from "../domain/transaction.js";
export async function migrate(pool: Pool, directory = resolve("migrations")) {
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(724911)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migration(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = (await readdir(directory))
      .filter((n) => /^\d{3}-[a-z-]+\.sql$/.test(n))
      .sort();
    const applied = (
      await client.query(
        "SELECT name,checksum FROM schema_migration ORDER BY name",
      )
    ).rows;
    if (applied.some((row) => !files.includes(row.name)))
      throw new Error("Database migration is newer than application");
    for (const file of files) {
      const sql = await readFile(resolve(directory, file), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const existing = applied.find((row) => row.name === file);
      if (existing) {
        if (existing.checksum !== hash)
          throw new Error("Applied migration checksum mismatch: " + file);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migration(name,checksum) VALUES($1,$2)",
        [file, hash],
      );
    }
    return files;
  });
}
