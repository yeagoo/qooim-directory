import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { transaction } from "../domain/transaction.js";
import { Content } from "./content.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { fetchPublicText } from "./outbound.js";
import { GithubClient, GithubError } from "./github-client.js";
import {
  adapter,
  kinds as allKinds,
  requiredModulesJson,
  type AdapterContext,
  type BindingAdapter,
  type BindingFetch,
  type DiscoveryAdapter,
  type Fetch,
  type Kind,
} from "./collector-adapters.js";

// One task worker for every collector kind (collector_source/collector_task).
// Scheduling, claiming, leases, attempts and source-version checks are shared;
// completion and failure follow the adapter's review model.

// The GitHub API budget (github_budget) paces only this kind across processes.
const PACED: Kind = "github";
// A site must enable all modules an adapter requires; $n is requiredModulesJson().
const modulesMatch = (param: string) =>
  `site.modules @> ARRAY(SELECT jsonb_array_elements_text(${param}::jsonb->s.kind))`;

export type WorkerOptions = {
  kinds?: readonly Kind[];
  fetcher?: Fetch;
  github?: GithubClient;
  leaseMs?: number;
};
export type Delivery = {
  id: string;
  source_id: string;
  source_version: number;
  lease_token: string;
  attempts: number;
  site_id: string;
  kind: Kind;
  config: Record<string, unknown>;
  etag: string | null;
  resource_id: string | null;
  remote_id: string | null;
};
export type LeasedJob = Pick<Delivery, "id" | "lease_token">;
export type BindingJob = LeasedJob &
  Pick<Delivery, "source_id" | "source_version" | "site_id">;
export type RunResult = "idle" | "done" | "not_modified" | "failed" | "lease-lost";

export class CollectorTaskWorker {
  private readonly kinds: readonly Kind[];
  private readonly modules: string;
  private readonly fetcher: Fetch;
  private readonly leaseMs: number;
  private client?: GithubClient;
  private readonly context: AdapterContext;
  constructor(
    private pool: Pool,
    options: WorkerOptions = {},
  ) {
    this.kinds = options.kinds ?? allKinds;
    this.modules = requiredModulesJson(this.kinds);
    this.fetcher = options.fetcher ?? fetchPublicText;
    this.leaseMs = options.leaseMs ?? 60000;
    this.client = options.github;
    // Constructed eagerly (as before) so an invalid GITHUB_SYNC_TOKEN fails fast.
    if (!this.client && this.kinds.includes("github"))
      this.client = new GithubClient();
    this.context = {
      fetcher: this.fetcher,
      github: () => (this.client ??= new GithubClient()),
    };
  }
  // Enqueues due sources within each site's hourly allowance. Due sources beyond
  // the allowance are deferred by 15 minutes instead of being retried every tick.
  // Binding sources never get a second open task: a due source that still has
  // one only advances its next run (and does not use the allowance).
  async schedule() {
    const single = this.kinds.filter((kind) => adapter(kind).mode === "binding");
    return transaction(this.pool, async (c) => {
      // Non-blocking per-site locks: a site busy with a manual enqueue is simply
      // skipped this tick, so the scheduler can never deadlock with it.
      const sites = (
        await c.query(
          `SELECT site_id FROM (SELECT DISTINCT s.site_id FROM collector_source s JOIN site ON site.id=s.site_id
             WHERE s.kind=ANY($1::text[]) AND s.enabled AND site.active AND ${modulesMatch("$2")} AND s.next_run_at<=now()
             ORDER BY s.site_id LIMIT 50) d
           WHERE pg_try_advisory_xact_lock(hashtext('collector-run:'||site_id))`,
          [this.kinds, this.modules],
        )
      ).rows.map((row) => row.site_id as string);
      if (!sites.length) return { queued: 0, deferred: 0 };
      // A new statement (READ COMMITTED) sees every task committed before the locks were taken.
      const rows = (
        await c.query(
          `WITH due AS(
             SELECT s.id,s.version,s.site_id,s.next_run_at,s.kind FROM collector_source s JOIN site ON site.id=s.site_id
             WHERE s.site_id=ANY($1::text[]) AND s.kind=ANY($3::text[]) AND s.enabled AND site.active AND ${modulesMatch("$4")} AND s.next_run_at<=now()
             ORDER BY s.next_run_at FOR UPDATE OF s SKIP LOCKED LIMIT 10),
           open AS(
             SELECT DISTINCT t.source_id FROM collector_task t
             WHERE t.source_id IN (SELECT id FROM due WHERE kind=ANY($5::text[])) AND t.status IN ('pending','processing')),
           used AS(
             SELECT s.site_id,count(*)::int AS n FROM collector_task t JOIN collector_source s ON s.id=t.source_id
             WHERE s.site_id=ANY($1::text[]) AND t.created_at>now()-interval '1 hour' GROUP BY s.site_id),
           ranked AS(
             SELECT due.id,due.version,open.source_id IS NOT NULL AS coalesced,
               open.source_id IS NULL AND
               row_number() OVER(PARTITION BY due.site_id,open.source_id IS NULL ORDER BY due.next_run_at,due.id)
                 <= greatest(coalesce(l.collector_runs_per_hour,$2::int)-coalesce(used.n,0),0) AS allowed
             FROM due LEFT JOIN open ON open.source_id=due.id
               LEFT JOIN site_limit l ON l.site_id=due.site_id LEFT JOIN used ON used.site_id=due.site_id),
           queued AS(INSERT INTO collector_task(source_id,source_version) SELECT id,version FROM ranked WHERE allowed)
           UPDATE collector_source s SET next_run_at=CASE WHEN ranked.allowed OR ranked.coalesced
             THEN now()+s.interval_seconds*interval '1 second' ELSE now()+interval '15 minutes' END
           FROM ranked WHERE s.id=ranked.id RETURNING ranked.allowed,ranked.coalesced`,
          [
            sites,
            DEFAULT_LIMITS.collectorRunsPerHour,
            this.kinds,
            this.modules,
            single,
          ],
        )
      ).rows;
      const queued = rows.filter((row) => row.allowed).length;
      return {
        queued,
        deferred: rows.filter((row) => !row.allowed && !row.coalesced).length,
      };
    });
  }
  async claim(): Promise<Delivery | undefined> {
    return transaction(this.pool, async (c) => {
      await c.query(
        `UPDATE collector_task t SET status='failed',error_code='attempts_exhausted',lease_token=NULL,lease_until=NULL,completed_at=now()
         FROM collector_source s WHERE s.id=t.source_id AND s.kind=ANY($1::text[])
           AND t.attempts>=5 AND (t.status='pending' OR (t.status='processing' AND t.lease_until<=clock_timestamp()))`,
        [this.kinds],
      );
      await c.query(
        `UPDATE collector_task t SET status='cancelled',error_code='source_changed',lease_token=NULL,lease_until=NULL,completed_at=now()
         FROM collector_source s WHERE t.source_id=s.id AND s.kind=ANY($1::text[])
           AND t.source_version<>s.version AND t.status IN ('pending','processing')`,
        [this.kinds],
      );
      let claimable = this.kinds;
      // The budget row lock serializes paced claims across processes; while it is
      // busy or cooling down only the other kinds can be claimed.
      if (
        claimable.includes(PACED) &&
        !(
          await c.query(
            "SELECT 1 FROM github_budget WHERE id=1 AND next_at<=clock_timestamp() FOR UPDATE SKIP LOCKED",
          )
        ).rowCount
      )
        claimable = claimable.filter((kind) => kind !== PACED);
      if (!claimable.length) return;
      const row = (
        await c.query(
          `SELECT t.id,t.source_id,t.source_version,t.attempts,s.site_id,s.kind,s.config,s.etag,s.resource_id,s.remote_id
           FROM collector_task t JOIN collector_source s ON s.id=t.source_id JOIN site ON site.id=s.site_id
           WHERE s.kind=ANY($1::text[]) AND s.enabled AND site.active AND ${modulesMatch("$2")}
             AND t.attempts<5 AND t.source_version=s.version
             AND ((t.status='pending' AND t.available_at<=clock_timestamp()) OR (t.status='processing' AND t.lease_until<=clock_timestamp()))
           ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
          [claimable, this.modules],
        )
      ).rows[0];
      if (!row) return;
      const token = randomUUID();
      await c.query(
        "UPDATE collector_task SET status='processing',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+$3::int*interval '1 millisecond' WHERE id=$1",
        [row.id, token, this.leaseMs],
      );
      if (row.kind === PACED)
        await c.query(
          "UPDATE github_budget SET next_at=clock_timestamp()+interval '1 second' WHERE id=1",
        );
      return { ...row, lease_token: token, attempts: row.attempts + 1 } as Delivery;
    });
  }
  async runOnce(): Promise<RunResult> {
    const job = await this.claim();
    if (!job) return "idle";
    const selected = adapter(job.kind);
    return selected.mode === "binding"
      ? this.runBinding(job, selected)
      : this.runDiscovery(job, selected);
  }

  // Discovery: upsert candidates by external id; pending ones only change when
  // their fingerprint changes. Errors retry after 30 s up to 5 attempts.
  private async runDiscovery(job: Delivery, selected: DiscoveryAdapter) {
    try {
      const fetched = await selected.fetch(job.config, job.etag ?? null, this.context);
      if (fetched.notModified) {
        await this.pool.query(
          "UPDATE collector_task SET status='done',result='not_modified',error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1 AND lease_token=$2",
          [job.id, job.lease_token],
        );
        return "not_modified";
      }
      const { items, etag } = fetched;
      await transaction(this.pool, async (c) => {
        const task = (
          await c.query(
            "SELECT 1 FROM collector_task WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()",
            [job.id, job.lease_token],
          )
        ).rowCount;
        if (!task) return;
        for (const item of items) {
          await c.query(
            `INSERT INTO collector_candidate(source_id,task_id,external_id,locale,data,fingerprint)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(source_id,external_id) DO UPDATE SET data=EXCLUDED.data,fingerprint=EXCLUDED.fingerprint,version=collector_candidate.version+1
             WHERE collector_candidate.status='pending' AND collector_candidate.fingerprint<>EXCLUDED.fingerprint`,
            [
              job.source_id,
              job.id,
              item.externalId,
              item.locale,
              item.data,
              selected.contentHash(item),
            ],
          );
        }
        await c.query("UPDATE collector_source SET etag=$2 WHERE id=$1", [
          job.source_id,
          etag,
        ]);
        await c.query(
          "UPDATE collector_task SET status='done',result=$2,error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1",
          [job.id, `items:${items.length}`],
        );
      });
      return "done";
    } catch (error) {
      const raw = error instanceof Error ? error.message : "fetch_failed";
      const code = /^[a-z0-9_]{1,64}$/.test(raw) ? raw : "fetch_failed";
      await this.pool.query(
        "UPDATE collector_task SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,available_at=clock_timestamp()+interval '30 seconds',error_code=$3,completed_at=CASE WHEN attempts>=5 THEN now() ELSE NULL END,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
        [job.id, job.lease_token, code],
      );
      return "failed";
    }
  }

  private async runBinding(job: Delivery, selected: BindingAdapter) {
    try {
      const result = await selected.fetch(job.config, job.etag, this.context);
      return (await this.completeBinding(job, result)) ? "done" : "lease-lost";
    } catch (error) {
      return (await this.failBinding(
        job,
        error instanceof GithubError
          ? error
          : new GithubError("delivery_failed", 30),
      ))
        ? "failed"
        : "lease-lost";
    }
  }
  // Binding: statistics update the bound resource directly; any other content
  // change supersedes pending candidates and creates one field-review candidate.
  // Candidate, cursor and acknowledgement commit together.
  async completeBinding(job: BindingJob, result: BindingFetch) {
    return transaction(this.pool, async (c) => {
      const site = (
        await c.query("SELECT active,modules FROM site WHERE id=$1 FOR SHARE", [
          job.site_id,
        ])
      ).rows[0];
      const source = (
        await c.query("SELECT * FROM collector_source WHERE id=$1 FOR UPDATE", [
          job.source_id,
        ])
      ).rows[0];
      const task = (
        await c.query(
          "SELECT * FROM collector_task WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp() FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rows[0];
      if (!task) return false;
      const selected = adapter(source.kind);
      if (
        selected.mode !== "binding" ||
        !source.enabled ||
        source.version !== job.source_version ||
        !site.active ||
        !selected.requiredModules.every((m) => site.modules.includes(m))
      ) {
        await c.query(
          "UPDATE collector_task SET status='cancelled',error_code='module_or_source_disabled',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1",
          [job.id],
        );
        return false;
      }
      let outcome = "not_modified";
      if (!result.unchanged) {
        if (source.remote_id && source.remote_id !== result.data.project.repoId)
          throw new GithubError("repository_replaced");
        const hash = selected.contentHash(result.data);
        const content = new Content(this.pool);
        if (hash !== source.last_hash) {
          const base = await content.sourceBase(c, source.resource_id);
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
          await content.applySourceStats(c, source, result.data.project)
        )
          outcome = "stats_updated";
        else outcome = "unchanged";
        await c.query(
          "UPDATE collector_source SET etag=$2,remote_id=$3,last_hash=$4 WHERE id=$1",
          [source.id, result.etag, result.data.project.repoId, hash],
        );
      }
      await c.query(
        "UPDATE collector_task SET status='done',result=$2,error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1",
        [job.id, outcome],
      );
      return true;
    });
  }
  // retrySeconds null is terminal; a rate limit also pushes the shared budget.
  async failBinding(job: LeasedJob, error: GithubError) {
    return transaction(this.pool, async (c) => {
      const task = await c.query(
        "UPDATE collector_task SET status=CASE WHEN attempts>=5 OR $3::int IS NULL THEN 'failed' ELSE 'pending' END,available_at=clock_timestamp()+COALESCE($3,30)*interval '1 second',error_code=$4,lease_token=NULL,lease_until=NULL,completed_at=CASE WHEN attempts>=5 OR $3::int IS NULL THEN now() ELSE NULL END WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()",
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
}
