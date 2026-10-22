import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "../domain/transaction.js";
import { repositoryName } from "../domain/project.js";
import { Conflict } from "../domain/config.js";
import { Content, identifier } from "./content.js";
import { Operators, HttpError, type Operator } from "./operators.js";
import { activeProjectSite } from "./module-gate.js";
import { GithubClient, GithubError } from "./github-client.js";
import { adapters } from "./collector-adapters.js";
import { CollectorTaskWorker } from "./collector-worker.js";
import { assertSourceQuota, createCollectorTask } from "./collectors.js";

// GitHub is the binding adapter of the unified collector (collector_source
// kind 'github', collector_task). These classes keep the former GitHub API:
// same inputs, permissions (global operators), errors and response shapes.

// Former github_source / github_task row shapes, projected from the unified tables.
const sourceColumns =
  "s.id,s.site_id,s.resource_id,s.config->>'repository' AS repository,s.enabled,s.version,s.interval_seconds,s.next_run_at,s.etag,s.last_hash,s.remote_id,s.created_at";
const taskColumns =
  "t.id,t.source_id,t.source_version,t.status,t.attempts,t.available_at,t.lease_token,t.lease_until,t.error_code,t.result,t.created_at,t.completed_at";
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
    const config = adapters.github.validateConfig({ repository: v.repository });
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
          `SELECT ${sourceColumns} FROM collector_source s WHERE s.resource_id=$1 FOR UPDATE`,
          [v.resourceId],
        )
      ).rows[0];
      await this.operators.require(actor, undefined, false, c);
      if (
        (old?.version ?? 0) !== v.expectedVersion ||
        (old && old.site_id !== v.siteId)
      )
        throw new Conflict("来源版本或所属站点已改变");
      let row;
      if (old) {
        // Editing never counts toward the source quota. The stable repository ID
        // is kept only while the repository is unchanged.
        row = (
          await c.query(
            `UPDATE collector_source s SET config=$2,enabled=$3,interval_seconds=$4,version=s.version+1,next_run_at=now(),etag=NULL,last_hash=NULL,
               remote_id=CASE WHEN s.config->>'repository'=$5 THEN s.remote_id ELSE NULL END
             WHERE s.id=$1 RETURNING ${sourceColumns}`,
            [old.id, config, v.enabled, v.intervalSeconds, config.repository],
          )
        ).rows[0];
        await c.query(
          "UPDATE collector_task SET status='cancelled',error_code='source_changed',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE source_id=$1 AND status IN ('pending','processing')",
          [old.id],
        );
        await c.query(
          "UPDATE github_candidate SET status='superseded',version=version+1 WHERE source_id=$1 AND status='pending'",
          [old.id],
        );
      } else {
        // A new GitHub source uses the site's collector source quota.
        await assertSourceQuota(c, v.siteId);
        row = (
          await c.query(
            `INSERT INTO collector_source AS s(site_id,kind,config,enabled,interval_seconds,resource_id)
             VALUES($1,'github',$2,$3,$4,$5) RETURNING ${sourceColumns}`,
            [v.siteId, config, v.enabled, v.intervalSeconds, v.resourceId],
          )
        ).rows[0];
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
        `SELECT ${sourceColumns},site.active AS site_active,site.modules @> ARRAY['directory','opensource']::text[] AS module_enabled FROM collector_source s JOIN site ON site.id=s.site_id WHERE s.kind='github' ORDER BY s.created_at,s.id LIMIT 50 OFFSET $1`,
        [(page - 1) * 50],
      )
    ).rows;
  }
  async detail(actor: Operator, id: string) {
    await this.operators.require(actor);
    z.uuid().parse(id);
    const source = (
      await this.pool.query(
        `SELECT ${sourceColumns} FROM collector_source s WHERE s.id=$1 AND s.kind='github'`,
        [id],
      )
    ).rows[0];
    if (!source) throw new HttpError(404, "来源不存在");
    return transaction(this.pool, async (c) => ({
      source,
      current: await this.content.sourceBase(c, source.resource_id),
      tasks: (
        await c.query(
          `SELECT ${taskColumns} FROM collector_task t WHERE t.source_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 30`,
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
        await c.query(
          "SELECT site_id FROM collector_source WHERE id=$1 AND kind='github'",
          [id],
        )
      ).rows[0];
      if (!initial) throw new HttpError(404, "来源不存在");
      await activeProjectSite(c, initial.site_id);
      // The source row lock serializes manual syncs, retries and coalescing.
      const source = (
        await c.query(
          `SELECT ${sourceColumns} FROM collector_source s WHERE s.id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      await this.operators.require(actor, undefined, false, c);
      if (!source.enabled) throw new HttpError(409, "来源已停用");
      const previous = (
        await c.query(
          `SELECT ${taskColumns} FROM github_request r JOIN collector_task t ON t.id=r.task_id WHERE r.id=$1`,
          [operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.source_id !== id)
          throw new Conflict("操作标识已用于另一来源");
        return previous;
      }
      // Coalescing into the open task does not count toward the run limit.
      const open = (
        await c.query(
          `SELECT ${taskColumns} FROM collector_task t WHERE t.source_id=$1 AND t.status IN ('pending','processing')`,
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
      // A new task uses the site's hourly collection allowance (429 when exhausted).
      const { retry_of: _retryOf, ...task } = await createCollectorTask(
        c,
        source,
        operationId,
        null,
      );
      await c.query("INSERT INTO github_request VALUES($1,$2,$3)", [
        operationId,
        id,
        task.id,
      ]);
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
// Compatibility surface: the unified worker restricted to GitHub. Claims are
// paced by the global github_budget; other kinds are never blocked by it.
export class GithubWorker {
  private worker: CollectorTaskWorker;
  constructor(
    pool: Pool,
    client = new GithubClient(),
    leaseMs = 60000,
  ) {
    z.number().int().min(1).max(3600000).parse(leaseMs);
    this.worker = new CollectorTaskWorker(pool, {
      kinds: ["github"],
      github: client,
      leaseMs,
    });
  }
  async schedule() {
    await this.worker.schedule();
  }
  async claim(): Promise<GithubDelivery | undefined> {
    const job = await this.worker.claim();
    if (!job) return;
    return {
      id: job.id,
      source_id: job.source_id,
      source_version: job.source_version,
      lease_token: job.lease_token,
      attempts: job.attempts,
      site_id: job.site_id,
      resource_id: job.resource_id!,
      repository: String(job.config.repository),
      etag: job.etag,
      remote_id: job.remote_id,
    };
  }
  complete(job: GithubDelivery, result: GithubResult) {
    return this.worker.completeBinding(job, result);
  }
  fail(job: GithubDelivery, error: GithubError) {
    return this.worker.failBinding(job, error);
  }
  runOnce() {
    return this.worker.runOnce() as Promise<
      "idle" | "done" | "lease-lost" | "failed"
    >;
  }
}
