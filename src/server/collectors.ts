import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../domain/transaction.js";
import { Conflict, InvalidReference } from "../domain/config.js";
import { NotFound } from "../domain/catalog.js";
import { Content, identifier, resourceData } from "./content.js";
import { HttpError, Operators, type Operator } from "./operators.js";
import { DEFAULT_LIMITS, siteLimits } from "./limits.js";
import { fetchPublicText, publicUrl } from "./outbound.js";
import type { RetentionPolicy } from "./retention.js";

const locale = z.enum(["zh", "en"]);
// Per-site advisory locks serialize quota checks with the insert they guard.
const sourceLock = "SELECT pg_advisory_xact_lock(hashtext('collector-source:'||$1))";
const runLock = "SELECT pg_advisory_xact_lock(hashtext('collector-run:'||$1))";
// Tasks created during the last hour for any source of the site (manual and scheduled).
const runsLastHour = `SELECT count(*)::int AS n FROM collector_task t JOIN collector_source s ON s.id=t.source_id
  WHERE s.site_id=$1 AND t.created_at>now()-interval '1 hour'`;
const siteParam = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const TASK_PAGE = 50;
const taskQuery = z.strictObject({
  site: siteParam,
  status: z
    .enum(["pending", "processing", "done", "failed", "cancelled"])
    .optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
const batchInput = z.strictObject({
  site: siteParam,
  decision: z.enum(["accept", "reject"]),
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        expectedVersion: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
      message: "候选 ID 不能重复",
    }),
});
const sourceLabel = (kind: string, config: Record<string, unknown> | null) =>
  kind === "npm" ? "npm: " + String(config?.query ?? "") : String(config?.url ?? "");
// Mirrors the status mapping in http.ts for errors a single review reports to
// the client; anything else is unexpected and must abort a batch.
const clientFailure = (error: unknown): { status: number; error: string } | null => {
  if (error instanceof HttpError)
    return { status: error.status, error: error.message };
  if (error instanceof NotFound) return { status: 404, error: "Not found" };
  if (error instanceof Conflict) return { status: 409, error: error.message };
  if (error instanceof InvalidReference) return { status: 400, error: error.message };
  if (error instanceof z.ZodError) return { status: 400, error: "配置格式或参数不正确" };
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
  if (code === "23505") return { status: 409, error: "记录已存在或版本冲突" };
  if (code === "23503") return { status: 400, error: "关联的对象不存在或已被删除" };
  if (code === "22P02") return { status: 400, error: "配置格式或参数不正确" };
  return null;
};
const rssConfig = z.strictObject({
  url: z.string().trim().max(500),
  locale: locale.default("zh"),
});
const npmConfig = z.strictObject({
  query: z.string().trim().min(1).max(100),
  locale: locale.default("zh"),
});
const jsonConfig = z.strictObject({
  url: z.string().trim().max(500),
  itemsPath: z.string().trim().max(120).default(""),
  idField: z.string().trim().min(1).max(80).default("id"),
  titleField: z.string().trim().min(1).max(80).default("title"),
  descriptionField: z.string().trim().min(1).max(80).default("description"),
  urlField: z.string().trim().min(1).max(80).default("url"),
  locale: locale.default("zh"),
});
const sourceInput = z.strictObject({
  id: z.uuid().optional(),
  siteId: identifier,
  kind: z.enum(["rss", "npm", "json"]),
  config: z.unknown(),
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().min(3600).max(604800).default(86400),
  expectedVersion: z.number().int().nonnegative(),
});
const configFor = (kind: "rss" | "npm" | "json", input: unknown) => {
  if (kind === "rss") {
    const config = rssConfig.parse(input);
    try { publicUrl(config.url); } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "URL 不合法");
    }
    return config;
  }
  if (kind === "npm") return npmConfig.parse(input);
  const config = jsonConfig.parse(input);
  try { publicUrl(config.url); } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "URL 不合法");
  }
  return config;
};
const decode = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, number) =>
      String.fromCodePoint(parseInt(number, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const plain = (value: string) =>
  decode(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tag = (block: string, name: string) =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block)?.[1] ??
  "";
const attr = (block: string, name: string, key = "href") =>
  new RegExp(`<${name}[^>]*\\s${key}=["']([^"']+)["'][^>]*>`, "i").exec(block)?.[1] ??
  "";
export type CollectedItem = {
  externalId: string;
  locale: "zh" | "en";
  data: z.infer<typeof resourceData>;
};
export function parseRss(xml: string, baseUrl: string, target: "zh" | "en") {
  if (/<!doctype|<!entity/i.test(xml)) throw new Error("unsafe_feed");
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024) throw new Error("feed_too_large");
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => match[2])
    .slice(0, 50);
  if (!blocks.length) throw new Error("empty_feed");
  const items: CollectedItem[] = [];
  for (const block of blocks) {
    const title = plain(tag(block, "title")).slice(0, 200);
    const link =
      plain(tag(block, "link")) ||
      attr(block, "link", "href") ||
      plain(tag(block, "guid"));
    let url: string;
    try {
      url = new URL(link, baseUrl).toString();
      if (!["http:", "https:"].includes(new URL(url).protocol)) continue;
    } catch {
      continue;
    }
    if (!title) continue;
    const description = plain(
      tag(block, "description") ||
        tag(block, "summary") ||
        tag(block, "content") ||
        title,
    ).slice(0, 2000);
    const externalId = (
      plain(tag(block, "guid")) ||
      plain(tag(block, "id")) ||
      url
    ).slice(0, 500);
    const data = resourceData.parse({
      url,
      kind: "website",
      source: "rss:" + new URL(baseUrl).hostname,
      translations: { [target]: { title, description } },
    });
    items.push({ externalId, locale: target, data });
  }
  if (!items.length) throw new Error("empty_feed");
  return items;
}
export function parseNpm(json: unknown, target: "zh" | "en") {
  const value = z
    .object({
      objects: z.array(
        z.object({
          package: z.object({
            name: z.string().min(1).max(214),
            description: z.string().max(2000).optional(),
            links: z
              .object({
                npm: z.string().url().optional(),
                homepage: z.string().url().optional(),
                repository: z.string().optional(),
              })
              .partial()
              .optional(),
          }),
        }),
      ),
    })
    .parse(json);
  return value.objects.slice(0, 50).map(({ package: pkg }) => {
    const candidates = [pkg.links?.homepage, pkg.links?.repository, pkg.links?.npm]
      .filter((item): item is string => !!item)
      .filter((item) => /^https?:\/\//.test(item));
    const url =
      candidates[0] ||
      `https://www.npmjs.com/package/${encodeURIComponent(pkg.name)}`;
    const title = pkg.name.slice(0, 200),
      description = (pkg.description || "npm package").slice(0, 2000);
    return {
      externalId: pkg.name,
      locale: target,
      data: resourceData.parse({
        url,
        kind: "website",
        source: "npm",
        translations: { [target]: { title, description } },
      }),
    };
  });
}
export function parseJsonFeed(
  json: unknown,
  config: z.infer<typeof jsonConfig>,
) {
  const pick = (value: unknown, path: string) => {
    if (!path) return value;
    let current: unknown = value;
    for (const key of path.split(".")) {
      if (!current || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };
  const rows = pick(json, config.itemsPath);
  if (!Array.isArray(rows)) throw new Error("items_not_array");
  return rows.slice(0, 50).flatMap((row, index) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const title = String(pick(record, config.titleField) ?? "").trim().slice(0, 200);
    const url = String(pick(record, config.urlField) ?? "").trim();
    if (!title || !url) return [];
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) return [];
    } catch {
      return [];
    }
    const description = String(
      pick(record, config.descriptionField) ?? title,
    )
      .trim()
      .slice(0, 2000);
    const externalId = String(
      pick(record, config.idField) ?? url ?? index,
    ).slice(0, 500);
    return [
      {
        externalId,
        locale: config.locale,
        data: resourceData.parse({
          url,
          kind: "website",
          source: "json:" + new URL(config.url).hostname,
          translations: {
            [config.locale]: { title, description: description || title },
          },
        }),
      },
    ];
  });
}
export class Collectors {
  readonly operators: Operators;
  constructor(
    private pool: Pool,
    readonly content = new Content(pool),
  ) {
    this.operators = new Operators(pool);
  }
  async save(actor: Operator, input: unknown) {
    await this.operators.require(actor);
    const value = sourceInput.parse(input);
    const config = configFor(value.kind, value.config);
    return transaction(this.pool, async (c) => {
      const site = (
        await c.query("SELECT active,modules FROM site WHERE id=$1 FOR SHARE", [
          value.siteId,
        ])
      ).rows[0];
      if (!site || !site.active || !site.modules.includes("directory"))
        throw new HttpError(409, "站点未启用目录模块");
      await this.operators.require(actor, value.siteId, true, c);
      let result;
      if (value.id) {
        const old = (
          await c.query(
            "SELECT * FROM collector_source WHERE id=$1 AND site_id=$2 FOR UPDATE",
            [value.id, value.siteId],
          )
        ).rows[0];
        if (!old) throw new HttpError(404, "来源不存在");
        if (old.version !== value.expectedVersion)
          throw new Conflict("来源版本已改变");
        result = (await c.query(
          "UPDATE collector_source SET kind=$2,config=$3,enabled=$4,interval_seconds=$5,version=version+1,etag=NULL,next_run_at=now() WHERE id=$1 RETURNING *",
          [value.id, value.kind, config, value.enabled, value.intervalSeconds],
        )).rows[0];
        await c.query(
          "UPDATE collector_task SET status='cancelled',error_code='source_changed',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE source_id=$1 AND status IN ('pending','processing')",
          [value.id],
        );
        await c.query(
          "UPDATE collector_candidate SET status='superseded',version=version+1,reviewed_at=now() WHERE source_id=$1 AND status='pending'",
          [value.id],
        );
      } else {
        if (value.expectedVersion !== 0)
          throw new Conflict("新来源版本必须为 0");
        await c.query(sourceLock, [value.siteId]);
        const limit = (await siteLimits(c, value.siteId)).collectorSources;
        const count = (
          await c.query(
            "SELECT count(*)::int AS n FROM collector_source WHERE site_id=$1",
            [value.siteId],
          )
        ).rows[0].n;
        if (count >= limit)
          throw new HttpError(
            409,
            limit === 0
              ? "该站点的采集来源配额为 0，不能新建来源；请联系全局管理员调整配额"
              : `该站点采集来源已达上限（${limit} 个），不能新建来源；可修改现有来源或联系全局管理员调整配额`,
          );
        result = (await c.query(
          "INSERT INTO collector_source(id,site_id,kind,config,enabled,interval_seconds) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            randomUUID(),
            value.siteId,
            value.kind,
            config,
            value.enabled,
            value.intervalSeconds,
          ],
        )).rows[0];
      }
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'collector.source.save',$3)",
        [actor.id, value.siteId, { sourceId: result.id, version: result.version }],
      );
      return result;
    });
  }
  async list(actor: Operator, site?: string) {
    await this.operators.require(actor, site);
    const params: string[] = [];
    let where = "";
    if (site) {
      params.push(site);
      where = "WHERE s.site_id=$1";
    }
    return (
      await this.pool.query(
        `SELECT s.*,site.active AS site_active FROM collector_source s JOIN site ON site.id=s.site_id ${where} ORDER BY s.created_at DESC,s.id LIMIT 100`,
        params,
      )
    ).rows;
  }
  // Current quota usage for the admin UI.
  async usage(actor: Operator, site: string) {
    siteParam.parse(site);
    await this.operators.require(actor, site, false);
    const limits = await siteLimits(this.pool, site);
    const sources = (
      await this.pool.query(
        "SELECT count(*)::int AS n FROM collector_source WHERE site_id=$1",
        [site],
      )
    ).rows[0].n;
    const runs = (await this.pool.query(runsLastHour, [site])).rows[0].n;
    return {
      site,
      sources,
      sourceLimit: limits.collectorSources,
      runsLastHour: runs,
      runsPerHour: limits.collectorRunsPerHour,
    };
  }
  async detail(actor: Operator, id: string) {
    await this.operators.require(actor);
    z.uuid().parse(id);
    const source = (
      await this.pool.query("SELECT * FROM collector_source WHERE id=$1", [id])
    ).rows[0];
    if (!source) throw new HttpError(404, "采集来源不存在");
    await this.operators.require(actor, source.site_id, false);
    return {
      source,
      candidates: (
        await this.pool.query(
          "SELECT id,external_id,locale,data,status,version,accepted_resource_id,created_at,reviewed_at,compacted_at FROM collector_candidate WHERE source_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [id],
        )
      ).rows,
    };
  }
  async candidates(actor: Operator, site: string) {
    await this.operators.require(actor, site, false);
    return (
      await this.pool.query(
        `SELECT cc.id,cc.external_id,cc.locale,cc.data,cc.status,cc.version,cc.accepted_resource_id,cs.kind FROM collector_candidate cc JOIN collector_source cs ON cs.id=cc.source_id WHERE cs.site_id=$1 AND cc.status='pending' ORDER BY cc.created_at DESC,cc.id DESC LIMIT 100`,
        [site],
      )
    ).rows;
  }
  async enqueue(actor: Operator, id: string, operationId: string) {
    await this.operators.require(actor);
    z.uuid().parse(id);
    z.uuid().parse(operationId);
    return transaction(this.pool, async (c) => {
      const source = (
        await c.query("SELECT * FROM collector_source WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!source) throw new HttpError(404, "采集来源不存在");
      await this.operators.require(actor, source.site_id, true, c);
      if (!source.enabled) throw new HttpError(409, "来源已停用");
      const existing = (
        await c.query("SELECT * FROM collector_task WHERE id=$1", [operationId])
      ).rows[0];
      if (existing) {
        if (existing.source_id !== id) throw new Conflict("操作标识已用于另一来源");
        return existing;
      }
      const task = await this.createTask(c, source, operationId, null);
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'collector.sync.enqueue',$3)",
        [actor.id, source.site_id, { taskId: task.id }],
      );
      return task;
    });
  }
  // Shared by manual sync and retry: applies the site's hourly run limit and
  // inserts the task. The caller must hold the source row lock (FOR UPDATE).
  private async createTask(
    c: PoolClient,
    source: { id: string; site_id: string; version: number },
    operationId: string,
    retryOf: string | null,
  ) {
    await c.query(runLock, [source.site_id]);
    const limit = (await siteLimits(c, source.site_id)).collectorRunsPerHour;
    if (limit === 0)
      throw new HttpError(429, "该站点已停用采集（每小时采集次数配额为 0）");
    const used = (await c.query(runsLastHour, [source.site_id])).rows[0].n;
    if (used >= limit)
      throw new HttpError(
        429,
        `该站点最近一小时已发起 ${used} 次采集，达到每小时 ${limit} 次的上限，请稍后再试`,
      );
    const task = (
      await c.query(
        "INSERT INTO collector_task(id,source_id,source_version,retry_of) VALUES($1,$2,$3,$4) RETURNING *",
        [operationId, source.id, source.version, retryOf],
      )
    ).rows[0];
    await c.query(
      "UPDATE collector_source SET next_run_at=now()+interval_seconds*interval '1 second' WHERE id=$1",
      [source.id],
    );
    return task;
  }
  // Task history for the operations UI, newest first, 50 per page.
  async tasks(actor: Operator, input: unknown) {
    const value = taskQuery.parse(input);
    await this.operators.require(actor, value.site, false);
    const params: unknown[] = [value.site, TASK_PAGE + 1, (value.page - 1) * TASK_PAGE];
    let filter = "";
    if (value.status) {
      params.push(value.status);
      filter = " AND t.status=$4";
    }
    const rows = (
      await this.pool.query(
        `SELECT t.id,t.source_id,s.kind,s.config,t.status,t.attempts,t.error_code,t.result,t.retry_of,t.created_at,t.completed_at
         FROM collector_task t JOIN collector_source s ON s.id=t.source_id
         WHERE s.site_id=$1${filter} ORDER BY t.created_at DESC,t.id DESC LIMIT $2 OFFSET $3`,
        params,
      )
    ).rows;
    return {
      items: rows.slice(0, TASK_PAGE).map((row) => ({
        id: row.id,
        sourceId: row.source_id,
        kind: row.kind,
        source: sourceLabel(row.kind, row.config),
        status: row.status,
        attempts: row.attempts,
        error: row.error_code,
        result: row.result,
        retryOf: row.retry_of,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      })),
      page: value.page,
      hasMore: rows.length > TASK_PAGE,
    };
  }
  // Retries a failed task by creating a new task (retry_of = original); the
  // original row is left untouched for audit. Cancelled tasks are not
  // retryable: cancellation means the source changed after they were queued.
  async retry(actor: Operator, taskId: string, input: unknown) {
    z.uuid().parse(taskId);
    const value = z
      .strictObject({ site: siteParam, operationId: z.uuid() })
      .parse(input);
    // Retrying triggers an outbound fetch, so it follows manual sync: global operators only.
    await this.operators.require(actor);
    await this.operators.require(actor, value.site, true);
    return transaction(this.pool, async (c) => {
      const found = (
        await c.query(
          "SELECT t.source_id FROM collector_task t JOIN collector_source s ON s.id=t.source_id WHERE t.id=$1 AND s.site_id=$2",
          [taskId, value.site],
        )
      ).rows[0];
      if (!found) throw new HttpError(404, "采集任务不存在");
      await this.operators.require(actor, value.site, true, c);
      // The source row lock serializes retries and manual syncs of one source,
      // so concurrent retries see each other's open task.
      const source = (
        await c.query(
          "SELECT * FROM collector_source WHERE id=$1 AND site_id=$2 FOR UPDATE",
          [found.source_id, value.site],
        )
      ).rows[0];
      if (!source) throw new HttpError(404, "采集来源不存在");
      const existing = (
        await c.query("SELECT * FROM collector_task WHERE id=$1", [
          value.operationId,
        ])
      ).rows[0];
      if (existing) {
        if (existing.retry_of !== taskId)
          throw new Conflict("操作标识已用于另一操作");
        return existing;
      }
      const original = (
        await c.query("SELECT status FROM collector_task WHERE id=$1", [taskId])
      ).rows[0];
      if (!original) throw new HttpError(404, "采集任务不存在");
      if (original.status !== "failed")
        throw new HttpError(
          409,
          original.status === "cancelled"
            ? "任务因来源配置改变而取消，不能重试；请对来源发起同步"
            : "只有失败的任务可以重试",
        );
      if (!source.enabled) throw new HttpError(409, "来源已停用");
      const open = (
        await c.query(
          "SELECT 1 FROM collector_task WHERE source_id=$1 AND status IN ('pending','processing') LIMIT 1",
          [source.id],
        )
      ).rowCount;
      if (open)
        throw new HttpError(409, "该来源已有排队或处理中的任务，请等待其完成");
      const task = await this.createTask(c, source, value.operationId, taskId);
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'collector.task.retry',$3)",
        [actor.id, value.site, { taskId: task.id, retryOf: taskId }],
      );
      return task;
    });
  }
  async review(
    actor: Operator,
    site: string,
    candidateId: string,
    input: unknown,
  ) {
    const value = z
      .strictObject({
        decision: z.enum(["accept", "reject"]),
        expectedVersion: z.number().int().positive(),
      })
      .parse(input);
    if (value.decision === "accept")
      return this.content.acceptCollected(
        actor,
        site,
        candidateId,
        value.expectedVersion,
      );
    await this.operators.require(actor, site, true);
    return transaction(this.pool, async (c) => {
      const row = (
        await c.query(
          "SELECT cc.* FROM collector_candidate cc JOIN collector_source cs ON cs.id=cc.source_id WHERE cc.id=$1 AND cs.site_id=$2 FOR UPDATE OF cc",
          [candidateId, site],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "采集候选不存在");
      await this.operators.require(actor, site, true, c);
      if (row.status !== "pending" || row.version !== value.expectedVersion)
        throw new Conflict("采集候选已审核或版本已改变");
      await c.query(
        "UPDATE collector_candidate SET status='rejected',version=version+1,reviewed_at=now() WHERE id=$1",
        [candidateId],
      );
      await c.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'collector.reject',$3)",
        [actor.id, site, { candidateId }],
      );
      return { resourceId: null };
    });
  }
  // Batch review is NOT atomic: items are processed one by one through the
  // single-item path, each in its own transaction. An item that fails with a
  // client error (403/404/409/400) is reported and the rest still run; any
  // other error aborts the batch, leaving earlier items committed.
  async batchReview(actor: Operator, input: unknown) {
    const value = batchInput.parse(input);
    await this.operators.require(actor, value.site, true);
    const results: Array<
      | { id: string; ok: true; resourceId: string | null }
      | { id: string; ok: false; status: number; error: string }
    > = [];
    for (const item of value.items) {
      try {
        const result = await this.review(actor, value.site, item.id, {
          decision: value.decision,
          expectedVersion: item.expectedVersion,
        });
        results.push({ id: item.id, ok: true, resourceId: result.resourceId });
      } catch (error) {
        const failure = clientFailure(error);
        if (!failure) throw error;
        results.push({ id: item.id, ok: false, ...failure });
      }
    }
    const succeeded = results.filter((result) => result.ok).length;
    return {
      results,
      accepted: value.decision === "accept" ? succeeded : 0,
      rejected: value.decision === "reject" ? succeeded : 0,
      failed: results.length - succeeded,
    };
  }
}
type Fetch = typeof fetchPublicText;
export class CollectorWorker {
  constructor(
    private pool: Pool,
    private fetcher: Fetch = fetchPublicText,
    private leaseMs = 60000,
  ) {}
  // Enqueues due sources within each site's hourly allowance. Due sources beyond
  // the allowance are deferred by 15 minutes instead of being retried every tick.
  async schedule() {
    return transaction(this.pool, async (c) => {
      // Non-blocking per-site locks: a site busy with a manual enqueue is simply
      // skipped this tick, so the scheduler can never deadlock with it.
      const sites = (
        await c.query(
          `SELECT site_id FROM (SELECT DISTINCT s.site_id FROM collector_source s JOIN site ON site.id=s.site_id
             WHERE s.enabled AND site.active AND site.modules @> ARRAY['directory']::text[] AND s.next_run_at<=now()
             ORDER BY s.site_id LIMIT 50) d
           WHERE pg_try_advisory_xact_lock(hashtext('collector-run:'||site_id))`,
        )
      ).rows.map((row) => row.site_id as string);
      if (!sites.length) return { queued: 0, deferred: 0 };
      // A new statement (READ COMMITTED) sees every task committed before the locks were taken.
      const rows = (
        await c.query(
          `WITH due AS(
             SELECT s.id,s.version,s.site_id,s.next_run_at FROM collector_source s JOIN site ON site.id=s.site_id
             WHERE s.site_id=ANY($1::text[]) AND s.enabled AND site.active AND site.modules @> ARRAY['directory']::text[] AND s.next_run_at<=now()
             ORDER BY s.next_run_at FOR UPDATE OF s SKIP LOCKED LIMIT 10),
           used AS(
             SELECT s.site_id,count(*)::int AS n FROM collector_task t JOIN collector_source s ON s.id=t.source_id
             WHERE s.site_id=ANY($1::text[]) AND t.created_at>now()-interval '1 hour' GROUP BY s.site_id),
           ranked AS(
             SELECT due.id,due.version,
               row_number() OVER(PARTITION BY due.site_id ORDER BY due.next_run_at,due.id)
                 <= greatest(coalesce(l.collector_runs_per_hour,$2::int)-coalesce(used.n,0),0) AS allowed
             FROM due LEFT JOIN site_limit l ON l.site_id=due.site_id LEFT JOIN used ON used.site_id=due.site_id),
           queued AS(INSERT INTO collector_task(source_id,source_version) SELECT id,version FROM ranked WHERE allowed ON CONFLICT DO NOTHING)
           UPDATE collector_source s SET next_run_at=CASE WHEN ranked.allowed
             THEN now()+s.interval_seconds*interval '1 second' ELSE now()+interval '15 minutes' END
           FROM ranked WHERE s.id=ranked.id RETURNING ranked.allowed`,
          [sites, DEFAULT_LIMITS.collectorRunsPerHour],
        )
      ).rows;
      const queued = rows.filter((row) => row.allowed).length;
      return { queued, deferred: rows.length - queued };
    });
  }
  async claim() {
    return transaction(this.pool, async (c) => {
      await c.query(
        "UPDATE collector_task SET status='failed',error_code='attempts_exhausted',lease_token=NULL,lease_until=NULL,completed_at=now() WHERE attempts>=5 AND (status='pending' OR (status='processing' AND lease_until<=clock_timestamp()))",
      );
      await c.query(
        "UPDATE collector_task t SET status='cancelled',error_code='source_changed',lease_token=NULL,lease_until=NULL,completed_at=now() FROM collector_source s WHERE t.source_id=s.id AND t.source_version<>s.version AND t.status IN ('pending','processing')",
      );
      const row = (
        await c.query(
          "SELECT t.id,t.source_id,t.source_version,t.attempts,s.site_id,s.kind,s.config,s.etag FROM collector_task t JOIN collector_source s ON s.id=t.source_id JOIN site ON site.id=s.site_id WHERE s.enabled AND site.active AND site.modules @> ARRAY['directory']::text[] AND t.attempts<5 AND t.source_version=s.version AND ((t.status='pending' AND t.available_at<=clock_timestamp()) OR (t.status='processing' AND t.lease_until<=clock_timestamp())) ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (!row) return;
      const token = randomUUID();
      await c.query(
        "UPDATE collector_task SET status='processing',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+$3::int*interval '1 millisecond' WHERE id=$1",
        [row.id, token, this.leaseMs],
      );
      return { ...row, lease_token: token, attempts: row.attempts + 1 };
    });
  }
  async runOnce() {
    const job = await this.claim();
    if (!job) return "idle";
    try {
      let items: CollectedItem[] = [];
      let etag: string | null = job.etag ?? null;
      if (job.kind === "rss") {
        const config = rssConfig.parse(job.config);
        const response = await this.fetcher(config.url, { etag });
        if (response.notModified) {
          await this.pool.query(
            "UPDATE collector_task SET status='done',result='not_modified',error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1 AND lease_token=$2",
            [job.id, job.lease_token],
          );
          return "not_modified";
        }
        etag = response.etag;
        items = parseRss(response.text, config.url, config.locale);
      } else if (job.kind === "npm") {
        const config = npmConfig.parse(job.config);
        const response = await this.fetcher(
          "https://registry.npmjs.org/-/v1/search?" +
            new URLSearchParams({
              text: "keywords:" + config.query,
              size: "50",
            }).toString(),
          { etag },
        );
        if (response.notModified) {
          await this.pool.query(
            "UPDATE collector_task SET status='done',result='not_modified',error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1 AND lease_token=$2",
            [job.id, job.lease_token],
          );
          return "not_modified";
        }
        etag = response.etag;
        items = parseNpm(JSON.parse(response.text), config.locale);
      } else {
        const config = jsonConfig.parse(job.config);
        const response = await this.fetcher(config.url, { etag });
        if (response.notModified) {
          await this.pool.query(
            "UPDATE collector_task SET status='done',result='not_modified',error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=now() WHERE id=$1 AND lease_token=$2",
            [job.id, job.lease_token],
          );
          return "not_modified";
        }
        etag = response.etag;
        items = parseJsonFeed(JSON.parse(response.text), config);
      }
      await transaction(this.pool, async (c) => {
        const task = (
          await c.query(
            "SELECT 1 FROM collector_task WHERE id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()",
            [job.id, job.lease_token],
          )
        ).rowCount;
        if (!task) return;
        for (const item of items) {
          const fingerprint = createHash("sha256")
            .update(JSON.stringify(item.data))
            .digest("hex");
          await c.query(
            `INSERT INTO collector_candidate(source_id,task_id,external_id,locale,data,fingerprint)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(source_id,external_id) DO UPDATE SET data=EXCLUDED.data,fingerprint=EXCLUDED.fingerprint,version=collector_candidate.version+1
             WHERE collector_candidate.status='pending' AND collector_candidate.fingerprint<>EXCLUDED.fingerprint`,
            [job.source_id, job.id, item.externalId, item.locale, item.data, fingerprint],
          );
        }
        await c.query(
          "UPDATE collector_source SET etag=$2 WHERE id=$1",
          [job.source_id, etag],
        );
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
}
// Retention for collector history. Each batch is one short autocommit statement
// that skips rows locked by reviewers or workers; pending candidates and
// pending/processing tasks are never selected.
export async function pruneCollectors(
  pool: Pool,
  policy: RetentionPolicy,
): Promise<Record<string, number>> {
  const batches = async (sql: string, days: number) => {
    let total = 0;
    for (let i = 0; i < policy.maxBatches; i++) {
      const count =
        (await pool.query(sql, [days, policy.batchSize])).rowCount ?? 0;
      total += count;
      if (count < policy.batchSize) break;
    }
    return total;
  };
  // Superseded rows go first so task deletion does not null their task_id needlessly.
  // Deleting them lets items still present in a feed be proposed again.
  const deletedSuperseded = await batches(
    `WITH doomed AS(SELECT id FROM collector_candidate
       WHERE status='superseded' AND status<>'pending' AND compacted_at IS NULL
         AND coalesce(reviewed_at,created_at)<now()-$1::int*interval '1 day'
       ORDER BY coalesce(reviewed_at,created_at) LIMIT $2 FOR UPDATE SKIP LOCKED)
     DELETE FROM collector_candidate c USING doomed WHERE c.id=doomed.id`,
    policy.collectorSupersededDays,
  );
  // Candidates survive with task_id NULL (ON DELETE SET NULL).
  const deletedTasks = await batches(
    `WITH doomed AS(SELECT id FROM collector_task
       WHERE status IN ('done','failed','cancelled') AND completed_at<now()-$1::int*interval '1 day'
       ORDER BY completed_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     DELETE FROM collector_task t USING doomed WHERE t.id=doomed.id`,
    policy.collectorTaskDays,
  );
  // Reviewed rows stay as dedupe records (source_id, external_id, fingerprint,
  // status, accepted_resource_id); only the payload is dropped.
  const compacted = await batches(
    `WITH doomed AS(SELECT id FROM collector_candidate
       WHERE status IN ('accepted','rejected') AND status<>'pending' AND compacted_at IS NULL
         AND coalesce(reviewed_at,created_at)<now()-$1::int*interval '1 day'
       ORDER BY coalesce(reviewed_at,created_at) LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE collector_candidate c SET data='{}'::jsonb,compacted_at=now() FROM doomed WHERE c.id=doomed.id`,
    policy.collectorReviewedDays,
  );
  return { deletedTasks, deletedSuperseded, compacted };
}
