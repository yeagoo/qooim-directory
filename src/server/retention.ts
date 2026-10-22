import { z } from "zod";

export type RetentionPolicy = {
  aiJobDays: number;
  collectorTaskDays: number;
  collectorSupersededDays: number;
  collectorReviewedDays: number;
  mediaOrphanGraceMinutes: number;
  batchSize: number;
  maxBatches: number;
  intervalMinutes: number;
};
const days = (min: number, fallback: number) =>
  z.coerce.number().int().min(min).max(3650).default(fallback);
export function retentionPolicy(
  env: Record<string, string | undefined>,
): RetentionPolicy {
  const pick = (name: string) => (env[name] === "" ? undefined : env[name]);
  return {
    // AI jobs are kept for at least 35 days so the current month's budget stays exact.
    aiJobDays: days(35, 180).parse(pick("RETENTION_AI_DAYS")),
    collectorTaskDays: days(1, 30).parse(pick("RETENTION_COLLECTOR_TASK_DAYS")),
    collectorSupersededDays: days(1, 30).parse(
      pick("RETENTION_COLLECTOR_SUPERSEDED_DAYS"),
    ),
    collectorReviewedDays: days(1, 90).parse(
      pick("RETENTION_COLLECTOR_REVIEWED_DAYS"),
    ),
    mediaOrphanGraceMinutes: 60,
    batchSize: 1000,
    maxBatches: 100,
    intervalMinutes: 60,
  };
}
export const DEFAULT_RETENTION = retentionPolicy({});
