import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { HttpError, Operators, type Operator } from "./operators.js";

// Defaults apply while a site has no override row (or the column is NULL).
export const DEFAULT_LIMITS = {
  mediaBytes: 1024 * 1024 * 1024,
  mediaFiles: 5000,
  collectorSources: 20,
  collectorRunsPerHour: 60,
} as const;
export type SiteLimits = { [K in keyof typeof DEFAULT_LIMITS]: number };
const site = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const limitInput = z.strictObject({
  site,
  mediaBytes: z.number().int().min(0).max(1099511627776).nullable().optional(),
  mediaFiles: z.number().int().min(0).max(1000000).nullable().optional(),
  collectorSources: z.number().int().min(0).max(1000).nullable().optional(),
  collectorRunsPerHour: z.number().int().min(0).max(10000).nullable().optional(),
});
export async function siteLimits(
  executor: Pool | PoolClient,
  siteId: string,
): Promise<SiteLimits> {
  const row = (
    await executor.query("SELECT * FROM site_limit WHERE site_id=$1", [siteId])
  ).rows[0];
  return {
    mediaBytes: Number(row?.media_bytes ?? DEFAULT_LIMITS.mediaBytes),
    mediaFiles: Number(row?.media_files ?? DEFAULT_LIMITS.mediaFiles),
    collectorSources: Number(
      row?.collector_sources ?? DEFAULT_LIMITS.collectorSources,
    ),
    collectorRunsPerHour: Number(
      row?.collector_runs_per_hour ?? DEFAULT_LIMITS.collectorRunsPerHour,
    ),
  };
}
export class Limits {
  private operators: Operators;
  constructor(private pool: Pool) {
    this.operators = new Operators(pool);
  }
  async get(actor: Operator, siteId: string) {
    site.parse(siteId);
    await this.operators.require(actor, siteId, false);
    return { site: siteId, ...(await siteLimits(this.pool, siteId)) };
  }
  // Quotas constrain site editors, so only global administrators may change them.
  async save(actor: Operator, input: unknown) {
    const value = limitInput.parse(input);
    await this.operators.require(actor);
    const exists = (
      await this.pool.query("SELECT 1 FROM site WHERE id=$1", [value.site])
    ).rowCount;
    if (!exists) throw new HttpError(404, "站点不存在");
    await this.pool.query(
      `INSERT INTO site_limit(site_id,media_bytes,media_files,collector_sources,collector_runs_per_hour,updated_at)
       VALUES($1,$2,$3,$4,$5,now())
       ON CONFLICT(site_id) DO UPDATE SET
         media_bytes=CASE WHEN $6 THEN EXCLUDED.media_bytes ELSE site_limit.media_bytes END,
         media_files=CASE WHEN $7 THEN EXCLUDED.media_files ELSE site_limit.media_files END,
         collector_sources=CASE WHEN $8 THEN EXCLUDED.collector_sources ELSE site_limit.collector_sources END,
         collector_runs_per_hour=CASE WHEN $9 THEN EXCLUDED.collector_runs_per_hour ELSE site_limit.collector_runs_per_hour END,
         updated_at=now()`,
      [
        value.site,
        value.mediaBytes ?? null,
        value.mediaFiles ?? null,
        value.collectorSources ?? null,
        value.collectorRunsPerHour ?? null,
        value.mediaBytes !== undefined,
        value.mediaFiles !== undefined,
        value.collectorSources !== undefined,
        value.collectorRunsPerHour !== undefined,
      ],
    );
    const result = await this.get(actor, value.site);
    await this.pool.query(
      "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'site.limit.save',$3)",
      [actor.id, value.site, result],
    );
    return result;
  }
}
export async function limitsHttp(
  limits: Limits,
  actor: Operator,
  action: string,
  request: Request,
  body: () => Promise<unknown>,
) {
  if (action !== "/limits") return null;
  if (request.method === "GET")
    return Response.json(
      await limits.get(actor, site.parse(new URL(request.url).searchParams.get("site"))),
    );
  if (request.method === "POST")
    return Response.json(await limits.save(actor, await body()));
  throw new HttpError(405, "Method not allowed");
}
