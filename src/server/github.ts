import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../domain/transaction.js";
import { repositoryName } from "../domain/project.js";
import { Conflict } from "../domain/config.js";
import { Content, identifier } from "./content.js";
import { Operators, HttpError, type Operator } from "./operators.js";
import { activeProjectSite } from "./module-gate.js";
import { GithubClient, GithubError } from "./github-client.js";
const statKeys = ["stars", "forks", "openIssues", "pushedAt"] as const;
function contentHash(data: {
  project: Record<string, unknown>;
  [key: string]: unknown;
}) {
  const copy = structuredClone(data);
  for (const key of statKeys) copy.project[key] = key === "pushedAt" ? null : 0;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}
const sourceInput = z.strictObject({
  siteId: identifier,
  resourceId: identifier,
  repository: repositoryName,
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().min(3600).max(604800).default(86400),
  expectedVersion: z.number().int().nonnegative(),
});
export class GithubSources {
  readonly operators: Operators;
  constructor(
    private pool: Pool,
    readonly content = new Content(pool),
  ) {
    this.operators = new Operators(pool);
  }
  async save(actor: Operator, input: unknown) {
    await this.operators.require(actor);
    const v = sourceInput.parse(input);
    return transaction(this.pool, async (c) => {
      if (v.enabled) await activeProjectSite(c, v.siteId);
      else if (
        !(await c.query("SELECT 1 FROM site WHERE id=$1 FOR SHARE", [v.siteId]))
          .rowCount
      )
        throw new HttpError(404, "站点不存在");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "github-source:" + v.resourceId,
      ]);
      const old = (
        await c.query(
          "SELECT * FROM github_source WHERE resource_id=$1 FOR UPDATE",
          [v.resourceId],
        )
      ).rows[0];
      await this.operators.require(actor, undefined, false, c);
      if (
        (old?.version ?? 0) !== v.expectedVersion ||
        (old && old.site_id !== v.siteId)
      )
        throw new Conflict("来源版本或所属站点已改变");
      const row = (
        await c.query(
          `INSERT INTO github_source(site_id,resource_id,repository,enabled,interval_seconds) VALUES($1,$2,$3,$4,$5) ON CONFLICT(resource_id) DO UPDATE SET repository=$3,enabled=$4,interval_seconds=$5,version=github_source.version+1,next_run_at=now(),etag=NULL,last_hash=NULL,remote_id=CASE WHEN github_source.repository=$3 THEN github_source.remote_id ELSE NULL END RETURNING *`,
          [
            v.siteId,
            v.resourceId,
            v.repository.toLowerCase(),
            v.enabled,
            v.intervalSeconds,
          ],
        )
      ).rows[0];
      if (old) {
        await c.query(
          "UPDATE github_task SET status='cancelled',error_code='source_changed',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE source_id=$1 AND status IN ('pending','processing')",
          [old.id],
        );
        await c.query(
          "UPDATE github_candidate SET status='superseded',version=version+1 WHERE source_id=$1 AND status='pending'",
          [old.id],
        );
      }
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'github.source.save',$3)",
        [actor.id, v.siteId, { sourceId: row.id, version: row.version }],
      );
      return row;
    });
  }
  async list(actor: Operator, page = 1) {
    await this.operators.require(actor);
    page = z.coerce.number().int().min(1).max(100000).parse(page);
    return (
      await this.pool.query(
        `SELECT s.*,site.active AS site_active,site.modules @> ARRAY['directory','opensource']::text[] AS module_enabled FROM github_source s JOIN site ON site.id=s.site_id ORDER BY s.created_at,s.id LIMIT 50 OFFSET $1`,
        [(page - 1) * 50],
      )
    ).rows;
  }
  async detail(actor: Operator, id: string) {
    await this.operators.require(actor);
    z.uuid().parse(id);
    const source = (
      await this.pool.query("SELECT * FROM github_source WHERE id=$1", [id])
    ).rows[0];
    if (!source) throw new HttpError(404, "来源不存在");
    return transaction(this.pool, async (c) => ({
      source,
      current: await this.content.sourceBase(c, source.resource_id),
      tasks: (
        await c.query(
          "SELECT * FROM github_task WHERE source_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30",
          [id],
        )
      ).rows,
      candidates: (
        await c.query(
          "SELECT * FROM github_candidate WHERE source_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30",
          [id],
        )
      ).rows,
    }));
  }
  async enqueue(actor: Operator, id: string, operationId: string) {
    await this.operators.require(actor);
    z.uuid().parse(id);
    z.uuid().parse(operationId);
    return transaction(this.pool, async (c) => {
      const initial = (
        await c.query("SELECT site_id FROM github_source WHERE id=$1", [id])
      ).rows[0];
      if (!initial) throw new HttpError(404, "来源不存在");
      await activeProjectSite(c, initial.site_id);
      const source = (
        await c.query("SELECT * FROM github_source WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      await this.operators.require(actor, undefined, false, c);
      if (!source.enabled) throw new HttpError(409, "来源已停用");
      const previous = (
        await c.query(
          "SELECT t.* FROM github_request r JOIN github_task t ON t.id=r.task_id WHERE r.id=$1",
          [operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.source_id !== id)
          throw new Conflict("操作标识已用于另一来源");
        return previous;
      }
      const open = (
        await c.query(
          "SELECT * FROM github_task WHERE source_id=$1 AND status IN ('pending','processing')",
          [id],
        )
      ).rows[0];
      if (open) {
        await c.query("INSERT INTO github_request VALUES($1,$2,$3)", [
          operationId,
          id,
          open.id,
        ]);
        return open;
      }
      const task = (
        await c.query(
          "INSERT INTO github_task(id,source_id,source_version) VALUES($1,$2,$3) RETURNING *",
          [operationId, id, source.version],
        )
      ).rows[0];
      await c.query("INSERT INTO github_request VALUES($1,$2,$3)", [
        operationId,
        id,
        task.id,
      ]);
      await c.query(
        "UPDATE github_source SET next_run_at=now()+interval_seconds*interval '1 second' WHERE id=$1",
        [id],
      );
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'github.sync.enqueue',$3)",
        [actor.id, source.site_id, { taskId: task.id }],
      );
      return task;
    });
  }
}
export type GithubDelivery = {
  id: string;
  source_id: string;
  source_version: number;
  lease_token: string;
  attempts: number;
  site_id: string;
  resource_id: string;
  repository: string;
  etag: string | null;
  remote_id: string | null;
};
type GithubResult = Awaited<ReturnType<GithubClient["repository"]>>;
export class GithubWorker {
  constructor(
    private pool: Pool,
    private client = new GithubClient(),
    private leaseMs = 60000,
  ) {
    z.number().int().min(1).max(3600000).parse(leaseMs);
  }
  async schedule() {
    await this.pool.query(
      `WITH due AS(SELECT s.* FROM github_source s JOIN site ON site.id=s.site_id WHERE s.enabled AND site.active AND site.modules @> ARRAY['directory','opensource']::text[] AND s.next_run_at<=now() ORDER BY s.next_run_at FOR UPDATE OF s SKIP LOCKED LIMIT 10), queued AS(INSERT INTO github_task(source_id,source_version) SELECT id,version FROM due ON CONFLICT DO NOTHING) UPDATE github_source s SET next_run_at=now()+s.interval_seconds*interval '1 second' FROM due WHERE s.id=due.id`,
    );
  }
  async claim(): Promise<GithubDelivery | undefined> {
    return transaction(this.pool, async (c) => {
      await c.query(
        "UPDATE github_task SET status='failed',lease_token=NULL,lease_until=NULL,error_code='attempts_exhausted',completed_at=now() WHERE attempts>=5 AND (status='pending' OR(status='processing' AND lease_until<=clock_timestamp()))",
      );
      await c.query(
        "UPDATE github_task t SET status='cancelled',lease_token=NULL,lease_until=NULL,error_code='source_changed',completed_at=now() FROM github_source s WHERE t.source_id=s.id AND t.source_version<>s.version AND t.status IN ('pending','processing')",
      );
      if (
        !(
          await c.query(
            "SELECT 1 FROM github_budget WHERE id=1 AND next_at<=clock_timestamp() FOR UPDATE SKIP LOCKED",
          )
        ).rowCount
      )
        return;
      const row = (
        await c.query<GithubDelivery>(
          `SELECT t.id,t.source_id,t.source_version,t.attempts,s.site_id,s.resource_id,s.repository,s.etag,s.remote_id FROM github_task t JOIN github_source s ON s.id=t.source_id JOIN site ON site.id=s.site_id WHERE s.enabled AND site.active AND site.modules @> ARRAY['directory','opensource']::text[] AND t.attempts<5 AND t.source_version=s.version AND ((t.status='pending' AND t.available_at<=clock_timestamp()) OR(t.status='processing' AND t.lease_until<=clock_timestamp())) ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
        )
      ).rows[0];
      if (!row) return;
      const token = randomUUID();
      await c.query(
        "UPDATE github_task SET status='processing',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+$3::int*interval '1 millisecond' WHERE id=$1",
        [row.id, token, this.leaseMs],
      );
      await c.query(
        "UPDATE github_budget SET next_at=clock_timestamp()+interval '1 second' WHERE id=1",
      );
      return { ...row, lease_token: token, attempts: row.attempts + 1 };
    });
  }
  async complete(job: GithubDelivery, result: GithubResult) {
    return transaction(this.pool, async (c) => {
      const site = (
        await c.query("SELECT active,modules FROM site WHERE id=$1 FOR SHARE", [
          job.site_id,
        ])
      ).rows[0];
      const source = (
        await c.query("SELECT * FROM github_source WHERE id=$1 FOR UPDATE", [
          job.source_id,
        ])
      ).rows[0];
      const task = (
        await c.query(
          "SELECT * FROM github_task WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rows[0];
      if (!task) return false;
      if (
        !source.enabled ||
        source.version !== job.source_version ||
        !site.active ||
        !["directory", "opensource"].every((m) => site.modules.includes(m))
      ) {
        await c.query(
          "UPDATE github_task SET status='cancelled',error_code='module_or_source_disabled',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1",
          [job.id],
        );
        return false;
      }
      let outcome = "not_modified";
      if (!result.unchanged) {
        if (source.remote_id && source.remote_id !== result.data.project.repoId)
          throw new GithubError("repository_replaced");
        const hash = contentHash(result.data);
        if (hash !== source.last_hash) {
          const base = await new Content(this.pool).sourceBase(
            c,
            source.resource_id,
          );
          await c.query(
            "UPDATE github_candidate SET status='superseded',version=version+1 WHERE source_id=$1 AND status='pending'",
            [source.id],
          );
          await c.query(
            "INSERT INTO github_candidate(source_id,task_id,source_version,base_version,data) VALUES($1,$2,$3,$4,$5)",
            [
              source.id,
              job.id,
              source.version,
              base?.version ?? 0,
              result.data,
            ],
          );
          outcome = "candidate_created";
        } else if (
          await new Content(this.pool).applySourceStats(
            c,
            source,
            result.data.project,
          )
        )
          outcome = "stats_updated";
        else outcome = "unchanged";
        await c.query(
          "UPDATE github_source SET etag=$2,remote_id=$3,last_hash=$4 WHERE id=$1",
          [source.id, result.etag, result.data.project.repoId, hash],
        );
      }
      await c.query(
        "UPDATE github_task SET status='done',result=$2,error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1",
        [job.id, outcome],
      );
      return true;
    });
  }
  async fail(job: GithubDelivery, error: GithubError) {
    return transaction(this.pool, async (c) => {
      const task = await c.query(
        "UPDATE github_task SET status=CASE WHEN attempts>=5 OR $3::int IS NULL THEN 'failed' ELSE 'pending' END,available_at=clock_timestamp()+COALESCE($3,30)*interval '1 second',error_code=$4,lease_token=NULL,lease_until=NULL,completed_at=CASE WHEN attempts>=5 OR $3::int IS NULL THEN now() ELSE NULL END WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()",
        [job.id, job.lease_token, error.retrySeconds, error.code],
      );
      if (task.rowCount && error.code === "rate_limited")
        await c.query(
          "UPDATE github_budget SET next_at=GREATEST(next_at,clock_timestamp()+$1::int*interval '1 second') WHERE id=1",
          [error.retrySeconds],
        );
      return task.rowCount === 1;
    });
  }
  async runOnce() {
    const job = await this.claim();
    if (!job) return "idle";
    try {
      const result = await this.client.repository(job.repository, job.etag);
      return (await this.complete(job, result)) ? "done" : "lease-lost";
    } catch (error) {
      return (await this.fail(
        job,
        error instanceof GithubError
          ? error
          : new GithubError("delivery_failed", 30),
      ))
        ? "failed"
        : "lease-lost";
    }
  }
}
