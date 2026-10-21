import { Pool } from "pg";
import { settings } from "./settings.js";
let instance: Pool | undefined;
export function database() {
  if (!instance) {
    instance = new Pool({
      connectionString: settings().databaseUrl,
      max: 12,
      connectionTimeoutMillis: 3000,
      query_timeout: 15000,
    });
    instance.on("error", () =>
      console.error("Database idle connection failed"),
    );
  }
  return instance;
}
