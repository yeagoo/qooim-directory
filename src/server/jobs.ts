import type { Pool } from "pg";
import { OutboxWorker } from "../domain/outbox.js";
import { GithubWorker } from "./github.js";
import { AuthRegistry } from "./auth.js";
export async function runJobs(pool: Pool, auth: AuthRegistry) {
  const errors: unknown[] = [];
  const attempt = async (task: () => Promise<unknown>) => {
    try {
      await task();
    } catch (error) {
      errors.push(error);
    }
  };
  await attempt(async () => {
    const pending = (
      await pool.query(
        "SELECT site_id FROM auth_instance WHERE state!='ready' AND (attempts<5 OR state='provisioning') AND retry_at<=now() ORDER BY center_site NULLS FIRST,id LIMIT 10",
      )
    ).rows;
    for (const row of pending) await attempt(() => auth.provision(row.site_id));
  });
  let completed = 0;
  await attempt(async () => {
    const outbox = new OutboxWorker(pool);
    for (let i = 0; i < 50; i++) {
      const result = await outbox.runOnce();
      if (result === "idle") break;
      if (result === "done") completed++;
    }
  });
  await attempt(async () => {
    const github = new GithubWorker(pool);
    await github.schedule();
    await github.runOnce();
  });
  // Bound SMTP work per iteration so a failing transport cannot starve maintenance.
  await attempt(() => auth.mail.runOnce());
  await attempt(() => auth.maintain());
  // Keep the last successful heartbeat: partial progress must not hide a failure.
  if (errors.length)
    throw new AggregateError(errors, "Worker iteration failed");
  await pool.query(
    "INSERT INTO maintenance_status VALUES('worker',now(),$1) ON CONFLICT(name) DO UPDATE SET completed_at=now(),detail=$1",
    [{ events: completed }],
  );
  return completed;
}
