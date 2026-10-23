import type { Pool } from "pg";
import { pruneAiJobs } from "./ai.js";
import { pruneCollectors } from "./collectors.js";
import { Media } from "./media.js";
import { pruneMetadataFetches } from "./metadata.js";
import { DEFAULT_RETENTION, type RetentionPolicy } from "./retention.js";

export type MaintenanceResult = Record<string, Record<string, number>>;
// Claims the hourly slot atomically so several workers never prune concurrently.
export async function runMaintenance(
  pool: Pool,
  options: { mediaRoot?: string; policy?: RetentionPolicy; force?: boolean } = {},
): Promise<MaintenanceResult | null> {
  const policy = options.policy ?? DEFAULT_RETENTION;
  const claimed = (
    await pool.query(
      `INSERT INTO maintenance_status(name,completed_at,detail) VALUES('retention',now(),'{"state":"running"}')
       ON CONFLICT(name) DO UPDATE SET completed_at=now(),detail='{"state":"running"}'
       WHERE $1 OR maintenance_status.completed_at<now()-$2::int*interval '1 minute'
       RETURNING 1`,
      [options.force === true, policy.intervalMinutes],
    )
  ).rowCount;
  if (!claimed) return null;
  const result: MaintenanceResult = {};
  const errors: unknown[] = [];
  const step = async (
    name: string,
    task: () => Promise<Record<string, number>>,
  ) => {
    try {
      result[name] = await task();
    } catch (error) {
      errors.push(error);
      result[name] = { failed: 1 };
    }
  };
  await step("ai", () => pruneAiJobs(pool, policy));
  await step("collectors", () => pruneCollectors(pool, policy));
  await step("metadata", () => pruneMetadataFetches(pool));
  if (options.mediaRoot)
    await step("media", () =>
      new Media(pool, options.mediaRoot!).cleanupOrphans(policy),
    );
  await pool.query(
    "UPDATE maintenance_status SET completed_at=now(),detail=$1 WHERE name='retention'",
    [{ state: errors.length ? "failed" : "done", ...result }],
  );
  if (errors.length) throw new AggregateError(errors, "Retention failed");
  return result;
}
