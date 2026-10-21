import { Pool } from "pg";
import { readFile } from "node:fs/promises";
export async function database() {
  const url = new URL(process.env.P0_DATABASE_URL ?? "invalid:");
  if (
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/navigation_p0" ||
    url.search ||
    !process.env.P0_RUN_ID?.startsWith("navigation-p0-")
  )
    throw new Error("Only isolated runner database accepted");
  const pool = new Pool({
    connectionString: url.toString(),
    max: 8,
    connectionTimeoutMillis: 2000,
  });
  pool.on("error", () => {}); // Fault-injection fixtures intentionally disconnect idle clients.
  try {
    const marker = await pool.query(
      "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
    );
    if (marker.rows[0]?.marker !== process.env.P0_RUN_ID)
      throw new Error("Database ownership marker mismatch");
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  } catch (error) {
    await pool.end();
    throw error;
  }
  await pool.query(
    await readFile(new URL("../internal/schema.sql", import.meta.url), "utf8"),
  );
  await pool.query(
    await readFile(
      new URL("../../migrations/003-content.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../../migrations/005-github-module.sql", import.meta.url),
      "utf8",
    ),
  );
  return pool;
}
export const basic = {
  name: "Demo",
  catalogPath: "tools",
  template: "basic",
  locales: ["en"],
  navigation: [],
  tagline: "",
};
export async function seed(pool: Pool, id = "alpha", host = "alpha.test") {
  await pool.query("INSERT INTO site(id,host,config) VALUES($1,$2,$3)", [
    id,
    host,
    basic,
  ]);
  await pool.query("INSERT INTO config_revision VALUES($1,0,$2)", [id, basic]);
}
