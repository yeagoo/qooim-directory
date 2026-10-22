import { database } from "./server/database.js";
import { settings } from "./server/settings.js";
import { AuthRegistry } from "./server/auth.js";
import { runJobs } from "./server/jobs.js";
const config = settings(),
  pool = database(),
  auth = new AuthRegistry(pool, config.key, config.databaseUrl);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
try {
  while (!stopping) {
    try {
      await runJobs(pool, auth, config.key, {
        mediaRoot: config.mediaRoot,
        retention: config.retention,
      });
    } catch {
      console.error("Worker iteration failed; durable tasks will retry");
    }
    if (!stopping) await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await auth.close();
  await pool.end();
}
