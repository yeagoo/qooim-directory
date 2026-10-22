import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "../domain/transaction.js";
import { unseal } from "./crypto.js";
import { HttpError, Operators, type Operator } from "./operators.js";
import { privateAddress, publicUrl } from "./outbound.js";

// M9: provider usage reconciliation and optional balance checks.
//
// Reconciliation is informational only: provider reports live in ai_usage_report and
// are compared against the app's own count (live ai_job + ai_usage_month, the same
// definition as AiService.usage). Saving or importing a report never changes budgets,
// ai_config, ai_job or ai_usage_month.

const MAX_TOKENS = 1e12,
  MAX_CSV_BYTES = 64 * 1024,
  MAX_CSV_ROWS = 120,
  BALANCE_TIMEOUT = 10000,
  BALANCE_MAX_RESPONSE = 64 * 1024,
  RECHECK_COOLDOWN_SECONDS = 60;
const siteSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthSchema = z
  .string()
  .regex(MONTH, "月份格式应为 YYYY-MM")
  .refine((value) => Number(value.slice(0, 4)) >= 2000, "月份不能早于 2000-01");
const tokenSchema = z.number().int().min(0).max(MAX_TOKENS);
const reportInput = z.strictObject({
  site: siteSchema,
  month: monthSchema,
  tokensIn: tokenSchema,
  tokensOut: tokenSchema,
  note: z.string().trim().max(500).optional(),
});
const importInput = z.strictObject({ site: siteSchema, csv: z.string() });
export const FIELD_PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$/;
const balanceInput = z.strictObject({
  site: siteSchema,
  url: z
    .string()
    .trim()
    .max(500)
    .refine((value) => {
      try {
        publicUrl(value);
        return true;
      } catch {
        return false;
      }
    }, "余额端点必须是公开 HTTPS 地址"),
  field: z.string().trim().regex(FIELD_PATH, "字段路径格式不正确"),
  enabled: z.boolean(),
});
const checkInput = z.strictObject({ site: siteSchema });

export type CsvRowError = { row: number; message: string };
// A rejected import: nothing was written. `row` is the 1-based line number (header = 1).
export class CsvImportError extends HttpError {
  constructor(public errors: CsvRowError[]) {
    super(
      400,
      `CSV 有 ${errors.length} 处错误，未导入任何数据：` +
        errors
          .slice(0, 5)
          .map((e) => (e.row ? `第 ${e.row} 行：` : "") + e.message)
          .join("；") +
        (errors.length > 5 ? "；……" : ""),
    );
  }
}
// Minimal CSV line split: comma separated, optional double-quoted fields with "" escapes.
function splitCsvLine(line: string): string[] | null {
  const fields: string[] = [];
  let i = 0;
  for (;;) {
    if (line[i] === '"') {
      let value = "";
      i++;
      for (;;) {
        if (i >= line.length) return null;
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += line[i++];
      }
      fields.push(value);
      if (i === line.length) return fields;
      if (line[i] !== ",") return null;
      i++;
    } else {
      const end = line.indexOf(",", i);
      if (end < 0) {
        fields.push(line.slice(i));
        return fields;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
}
type ParsedRow = { month: string; tokensIn: number; tokensOut: number; note: string };
// Validates every row against `currentMonth` (YYYY-MM); throws CsvImportError listing all problems.
export function parseUsageCsv(csv: string, currentMonth: string): ParsedRow[] {
  if (Buffer.byteLength(csv) > MAX_CSV_BYTES)
    throw new CsvImportError([{ row: 0, message: "CSV 超过 64 KiB" }]);
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const header = (lines[0] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .join(",");
  if (header !== "month,tokens_in,tokens_out" && header !== "month,tokens_in,tokens_out,note")
    throw new CsvImportError([
      { row: 1, message: "表头必须是 month,tokens_in,tokens_out[,note]" },
    ]);
  const withNote = header.endsWith(",note");
  if (lines.length < 2) throw new CsvImportError([{ row: 0, message: "CSV 没有数据行" }]);
  if (lines.length - 1 > MAX_CSV_ROWS)
    throw new CsvImportError([{ row: 0, message: `最多 ${MAX_CSV_ROWS} 行数据` }]);
  const errors: CsvRowError[] = [],
    rows: ParsedRow[] = [],
    seen = new Map<string, number>();
  lines.slice(1).forEach((line, index) => {
    const row = index + 2;
    const fail = (message: string) => errors.push({ row, message });
    const fields = splitCsvLine(line);
    if (!fields) return fail("引号不匹配");
    if (fields.length !== (withNote ? 4 : 3))
      return fail(`应有 ${withNote ? 4 : 3} 列，实际 ${fields.length} 列`);
    const [month, rawIn, rawOut, rawNote = ""] = fields.map((value, i) =>
      i < 3 ? value.trim() : value,
    ) as [string, string, string, string?];
    const problems: string[] = [];
    if (!MONTH.test(month) || Number(month.slice(0, 4)) < 2000)
      problems.push("月份格式应为 YYYY-MM");
    else if (month > currentMonth) problems.push("不能登记未来月份");
    else if (seen.has(month)) problems.push(`月份与第 ${seen.get(month)} 行重复`);
    const number = (value: string, label: string) => {
      if (!/^\d{1,13}$/.test(value) || Number(value) > MAX_TOKENS) {
        problems.push(`${label}必须是 0 到 1000000000000 之间的整数`);
        return 0;
      }
      return Number(value);
    };
    const tokensIn = number(rawIn, "tokens_in "),
      tokensOut = number(rawOut, "tokens_out ");
    const note = rawNote.trim();
    if (note.length > 500) problems.push("备注不能超过 500 字");
    if (problems.length) return fail(problems.join("，"));
    seen.set(month, row);
    rows.push({ month, tokensIn, tokensOut, note });
  });
  if (errors.length) throw new CsvImportError(errors);
  return rows;
}

// Reads a dot path ("data.balance", "balance_infos.0.total_balance") as a finite number.
// Numeric segments index arrays. Numeric strings ("110.00") are accepted because some
// providers return balances as decimal strings.
export function readBalanceField(document: unknown, path: string): number {
  let current: unknown = document;
  for (const segment of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      Object.prototype.hasOwnProperty.call(current, segment)
    )
      current = (current as Record<string, unknown>)[segment];
    else throw new Error("field_missing");
  }
  if (current === undefined || current === null) throw new Error("field_missing");
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (typeof current === "string" && /^-?\d{1,30}(\.\d{1,30})?$/.test(current.trim())) {
    const value = Number(current.trim());
    if (Number.isFinite(value)) return value;
  }
  throw new Error("not_a_number");
}

export type BalanceTransport = (input: {
  url: string;
  key: string;
}) => Promise<{ status: number; body: string }>;

// Throws unless every resolved address is public; returns the address to pin.
export function pickPublicAddress(addresses: { address: string; family: number }[]) {
  if (!addresses.length || addresses.some((item) => privateAddress(item.address)))
    throw new Error("unsafe_address");
  return addresses[0]!;
}
function deadline<T>(work: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
// Real outbound GET, mirroring providerRequest in ai.ts: public HTTPS only, DNS resolved
// once and every address checked, connection pinned to that address, no redirects
// (a 3xx is reported as http_3xx), 10 s total deadline, 64 KiB body limit. Errors are
// stable codes only; the key and body are never logged.
export const balanceRequest: BalanceTransport = async (input) => {
  const started = Date.now();
  let url: URL;
  try {
    url = publicUrl(input.url);
  } catch {
    throw new Error("unsafe_address");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await deadline(lookup(host, { all: true, verbatim: true }), BALANCE_TIMEOUT);
  } catch (error) {
    throw new Error(error instanceof Error && error.message === "timeout" ? "timeout" : "dns_failed");
  }
  const selected = pickPublicAddress(addresses);
  const remaining = Math.max(1, BALANCE_TIMEOUT - (Date.now() - started));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = httpsRequest(
      {
        hostname: host,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        servername: isIP(host) ? undefined : host,
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
        headers: {
          host,
          accept: "application/json",
          authorization: "Bearer " + input.key,
          "user-agent": "QooIM-Directory-Balance/1",
        },
        timeout: remaining,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > BALANCE_MAX_RESPONSE) {
            req.destroy();
            finish(new Error("response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(null, {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", () => finish(new Error("request_failed")));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error("timeout"));
    }, remaining);
    req.on("timeout", () => {
      req.destroy();
      finish(new Error("timeout"));
    });
    req.on("error", () => finish(new Error("request_failed")));
    req.end();
  });
};

const monthOf = (row: { month: string }) => row.month;
export class AiBilling {
  private operators: Operators;
  constructor(private pool: Pool) {
    this.operators = new Operators(pool);
  }
  private async siteExists(site: string) {
    const exists = (await this.pool.query("SELECT 1 FROM site WHERE id=$1", [site])).rowCount;
    if (!exists) throw new HttpError(404, "站点不存在");
  }
  private async currentMonth(db: Pick<Pool, "query">) {
    return (
      await db.query("SELECT to_char(date_trunc('month',now()),'YYYY-MM') AS month")
    ).rows[0].month as string;
  }
  // Last 12 months newest first. App usage uses the same definition as AiService.usage:
  // live ai_job rows (any status) plus rolled-up ai_usage_month. diff = provider - app.
  async reconcile(actor: Operator, site: string) {
    siteSchema.parse(site);
    await this.operators.require(actor, site, false);
    await this.siteExists(site);
    const { rows } = await this.pool.query(
      `WITH months AS (
         SELECT generate_series(date_trunc('month',now())-interval '11 months',date_trunc('month',now()),interval '1 month')::date AS month
       ), live AS (
         SELECT date_trunc('month',created_at)::date AS month,count(*) AS jobs,sum(tokens_in) AS tokens_in,sum(tokens_out) AS tokens_out
         FROM ai_job WHERE site_id=$1 AND created_at>=date_trunc('month',now())-interval '11 months'
         GROUP BY 1
       )
       SELECT to_char(m.month,'YYYY-MM') AS month,
         (coalesce(l.jobs,0)+coalesce(u.jobs,0))::float8 AS jobs,
         (coalesce(l.tokens_in,0)+coalesce(u.tokens_in,0))::float8 AS tokens_in,
         (coalesce(l.tokens_out,0)+coalesce(u.tokens_out,0))::float8 AS tokens_out,
         r.tokens_in::float8 AS report_in, r.tokens_out::float8 AS report_out,
         r.note, r.reported_at, o.email AS reported_by
       FROM months m
       LEFT JOIN live l ON l.month=m.month
       LEFT JOIN ai_usage_month u ON u.site_id=$1 AND u.month=m.month
       LEFT JOIN ai_usage_report r ON r.site_id=$1 AND r.month=m.month
       LEFT JOIN operator_user o ON o.id=r.reported_by
       ORDER BY m.month DESC`,
      [site],
    );
    return {
      site,
      months: rows.map((row) => {
        const app = {
          jobs: Number(row.jobs),
          tokensIn: Number(row.tokens_in),
          tokensOut: Number(row.tokens_out),
          total: Number(row.tokens_in) + Number(row.tokens_out),
        };
        const provider =
          row.report_in === null
            ? null
            : {
                tokensIn: Number(row.report_in),
                tokensOut: Number(row.report_out),
                total: Number(row.report_in) + Number(row.report_out),
                note: row.note as string,
                reportedBy: (row.reported_by as string | null) ?? null,
                reportedAt: row.reported_at as Date,
              };
        return {
          month: row.month as string,
          app,
          provider,
          diff: provider
            ? {
                tokensIn: provider.tokensIn - app.tokensIn,
                tokensOut: provider.tokensOut - app.tokensOut,
                total: provider.total - app.total,
              }
            : null,
          diffPercent:
            provider && app.total > 0
              ? Math.round(((provider.total - app.total) / app.total) * 10000) / 100
              : null,
        };
      }),
    };
  }
  async saveReport(actor: Operator, input: unknown) {
    const value = reportInput.parse(input);
    await transaction(this.pool, async (client) => {
      await this.operators.require(actor, value.site, true, client);
      if (value.month > (await this.currentMonth(client)))
        throw new HttpError(400, "不能登记未来月份的用量");
      await this.upsert(client, actor, value.site, [
        { month: value.month, tokensIn: value.tokensIn, tokensOut: value.tokensOut, note: value.note ?? "" },
      ]);
      await client.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'ai.reconcile.save',$3)",
        [actor.id, value.site, { month: value.month, tokensIn: value.tokensIn, tokensOut: value.tokensOut }],
      );
    });
    return this.reconcile(actor, value.site);
  }
  // All-or-nothing: every row is validated before anything is written, then all rows
  // are upserted in one transaction with a single audit event.
  async importCsv(actor: Operator, input: unknown) {
    const value = importInput.parse(input);
    await this.operators.require(actor, value.site, true);
    const rows = parseUsageCsv(value.csv, await this.currentMonth(this.pool));
    await transaction(this.pool, async (client) => {
      await this.operators.require(actor, value.site, true, client);
      // Re-check against the transaction's clock in case the import straddles a month change.
      const current = await this.currentMonth(client);
      const future = rows.filter((row) => row.month > current);
      if (future.length)
        throw new CsvImportError(future.map((row) => ({ row: 0, message: `${row.month} 是未来月份` })));
      await this.upsert(client, actor, value.site, rows);
      await client.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'ai.reconcile.import',$3)",
        [actor.id, value.site, { rows: rows.length, months: rows.map(monthOf) }],
      );
    });
    return { imported: rows.length, ...(await this.reconcile(actor, value.site)) };
  }
  private async upsert(
    client: Pick<Pool, "query">,
    actor: Operator,
    site: string,
    rows: ParsedRow[],
  ) {
    await client.query(
      `INSERT INTO ai_usage_report(site_id,month,tokens_in,tokens_out,note,reported_by,reported_at)
       SELECT $1,to_date(r.month,'YYYY-MM'),r.tokens_in,r.tokens_out,r.note,$2,now()
       FROM jsonb_to_recordset($3::jsonb) AS r(month text,tokens_in bigint,tokens_out bigint,note text)
       ON CONFLICT(site_id,month) DO UPDATE SET tokens_in=excluded.tokens_in,tokens_out=excluded.tokens_out,
         note=excluded.note,reported_by=excluded.reported_by,reported_at=excluded.reported_at`,
      [
        site,
        actor.id,
        JSON.stringify(
          rows.map((row) => ({
            month: row.month,
            tokens_in: row.tokensIn,
            tokens_out: row.tokensOut,
            note: row.note,
          })),
        ),
      ],
    );
  }
  async balance(actor: Operator, site: string) {
    siteSchema.parse(site);
    await this.operators.require(actor, site, false);
    await this.siteExists(site);
    const row = (
      await this.pool.query(
        "SELECT url,field,enabled,value::float8 AS value,checked_at,requested_at,error_code FROM ai_balance WHERE site_id=$1",
        [site],
      )
    ).rows[0];
    return row
      ? {
          configured: true,
          url: row.url as string,
          field: row.field as string,
          enabled: row.enabled as boolean,
          value: row.value === null ? null : Number(row.value),
          checkedAt: row.checked_at as Date | null,
          requestedAt: row.requested_at as Date | null,
          error: row.error_code as string | null,
        }
      : {
          configured: false,
          url: "",
          field: "",
          enabled: false,
          value: null,
          checkedAt: null,
          requestedAt: null,
          error: null,
        };
  }
  // Saving clears the previous result (value, error, checked_at) and any pending request.
  // A never-checked enabled row is picked up by the worker's periodic re-check.
  async saveBalance(actor: Operator, input: unknown) {
    const value = balanceInput.parse(input);
    await transaction(this.pool, async (client) => {
      await this.operators.require(actor, value.site, true, client);
      await client.query(
        `INSERT INTO ai_balance(site_id,url,field,enabled,updated_at) VALUES($1,$2,$3,$4,now())
         ON CONFLICT(site_id) DO UPDATE SET url=$2,field=$3,enabled=$4,value=NULL,error_code=NULL,
           checked_at=NULL,requested_at=NULL,updated_at=now()`,
        [value.site, value.url, value.field, value.enabled],
      );
      await client.query(
        "INSERT INTO audit_event(actor_id,site_id,action,detail) VALUES($1,$2,'ai.balance.save',$3)",
        [actor.id, value.site, { host: new URL(value.url).host, field: value.field, enabled: value.enabled }],
      );
    });
    return this.balance(actor, value.site);
  }
  // Only queues the check; the worker makes the outbound request.
  async requestCheck(actor: Operator, input: unknown) {
    const { site } = checkInput.parse(input);
    await transaction(this.pool, async (client) => {
      await this.operators.require(actor, site, true, client);
      const exists = (await client.query("SELECT 1 FROM ai_balance WHERE site_id=$1", [site]))
        .rowCount;
      if (!exists) throw new HttpError(404, "尚未配置余额检查");
      // A row locked by the worker is being checked right now.
      const row = (
        await client.query(
          `SELECT enabled,requested_at,checked_at>now()-$2::int*interval '1 second' AS recent
           FROM ai_balance WHERE site_id=$1 FOR UPDATE SKIP LOCKED`,
          [site, RECHECK_COOLDOWN_SECONDS],
        )
      ).rows[0];
      if (!row) throw new HttpError(409, "余额检查正在进行，请稍后刷新");
      if (!row.enabled) throw new HttpError(409, "余额检查未启用");
      if (row.requested_at) throw new HttpError(409, "已有余额检查在排队");
      if (row.recent) throw new HttpError(409, "上次检查不到 60 秒，请稍后再试");
      await client.query(
        "UPDATE ai_balance SET requested_at=now(),updated_at=now() WHERE site_id=$1",
        [site],
      );
    });
    return this.balance(actor, site);
  }
}

export class AiBalanceWorker {
  constructor(
    private pool: Pool,
    private key: string,
    private transport: BalanceTransport = balanceRequest,
  ) {}
  async runOnce(): Promise<boolean> {
    // Periodic re-check: enabled rows never checked, or last checked over 6 hours ago.
    await this.pool.query(
      `UPDATE ai_balance SET requested_at=now()
       WHERE enabled AND requested_at IS NULL AND (checked_at IS NULL OR checked_at<now()-interval '6 hours')`,
    );
    // The row stays locked during the request, so concurrent workers skip it and a
    // concurrent "check now" sees it as in progress.
    return transaction(this.pool, async (client) => {
      const row = (
        await client.query(
          `SELECT site_id,url,field FROM ai_balance WHERE enabled AND requested_at IS NOT NULL
           ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0] as { site_id: string; url: string; field: string } | undefined;
      if (!row) return false;
      let value: number | null = null,
        code: string | null = null;
      try {
        const config = (
          await client.query("SELECT sealed_key FROM ai_config WHERE site_id=$1", [row.site_id])
        ).rows[0];
        if (!config) throw new Error("no_ai_config");
        let key: string;
        try {
          key = unseal<{ key: string }>(config.sealed_key, this.key).key;
        } catch {
          throw new Error("key_unavailable");
        }
        const response = await this.transport({ url: row.url, key });
        if (response.status < 200 || response.status >= 300)
          throw new Error("http_" + response.status);
        let document: unknown;
        try {
          document = JSON.parse(response.body);
        } catch {
          throw new Error("invalid_json");
        }
        value = readBalanceField(document, row.field);
      } catch (error) {
        value = null;
        code =
          error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
            ? error.message
            : "request_failed";
      }
      await client.query(
        `UPDATE ai_balance SET value=$2::numeric,error_code=$3,checked_at=now(),requested_at=NULL,updated_at=now()
         WHERE site_id=$1`,
        [row.site_id, value === null ? null : String(value), code],
      );
      return true;
    });
  }
}

export async function aiBillingHttp(
  billing: AiBilling,
  actor: Operator,
  action: string,
  request: Request,
  body: () => Promise<unknown>,
): Promise<Response | null> {
  const routes = ["/ai/reconcile", "/ai/reconcile/import", "/ai/balance", "/ai/balance/check"];
  if (!routes.includes(action)) return null;
  const site = () => siteSchema.parse(new URL(request.url).searchParams.get("site"));
  if (request.method === "GET") {
    if (action === "/ai/reconcile") return Response.json(await billing.reconcile(actor, site()));
    if (action === "/ai/balance") return Response.json(await billing.balance(actor, site()));
  }
  if (request.method === "POST") {
    if (action === "/ai/reconcile")
      return Response.json(await billing.saveReport(actor, await body()));
    if (action === "/ai/reconcile/import") {
      try {
        return Response.json(await billing.importCsv(actor, await body()));
      } catch (error) {
        if (error instanceof CsvImportError)
          return Response.json({ error: error.message, errors: error.errors }, { status: 400 });
        throw error;
      }
    }
    if (action === "/ai/balance") return Response.json(await billing.saveBalance(actor, await body()));
    if (action === "/ai/balance/check")
      return Response.json(await billing.requestCheck(actor, await body()), { status: 202 });
  }
  throw new HttpError(405, "Method not allowed");
}
