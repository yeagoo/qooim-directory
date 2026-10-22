import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import {
  AiBalanceWorker,
  balanceRequest,
  pickPublicAddress,
  type BalanceTransport,
} from "../../src/server/ai-billing.js";
import { monthlyTokensUsed } from "../../src/server/ai.js";
import { HttpError, type Operator } from "../../src/server/operators.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
beforeEach(async () => {
  for (const table of ["ai_job", "ai_usage_month", "ai_usage_report", "ai_balance"])
    await f.pool.query(`DELETE FROM ${table}`);
  await f.pool.query("DELETE FROM audit_event WHERE action LIKE 'ai.%'");
  await configure();
});
async function configure() {
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    key: "sk-test-12345678",
    enabled: true,
    monthlyTokens: 100000,
  });
}
// Month n months before the database's current month, as YYYY-MM.
async function month(n: number) {
  return (
    await f.pool.query(
      "SELECT to_char(date_trunc('month',now())-$1::int*interval '1 month','YYYY-MM') AS m",
      [n],
    )
  ).rows[0].m as string;
}
async function job(monthsAgo: number, tokensIn: number, tokensOut: number, site = "atlas") {
  await f.pool.query(
    `INSERT INTO ai_job(site_id,actor_id,kind,payload,status,tokens_in,tokens_out,created_at,completed_at)
     VALUES($1,$2,'translate',$3,'done',$4,$5,
       date_trunc('month',now())-$6::int*interval '1 month'+interval '1 hour',
       date_trunc('month',now())-$6::int*interval '1 month'+interval '2 hours')`,
    [site, f.editor.id, { locale: "en", title: "Hello", brief: "" }, tokensIn, tokensOut, monthsAgo],
  );
}
async function rollup(monthsAgo: number, jobs: number, tokensIn: number, tokensOut: number) {
  await f.pool.query(
    `INSERT INTO ai_usage_month(site_id,month,jobs,tokens_in,tokens_out)
     VALUES('atlas',(date_trunc('month',now())-$1::int*interval '1 month')::date,$2,$3,$4)`,
    [monthsAgo, jobs, tokensIn, tokensOut],
  );
}
const post = (path: string, body: unknown) => f.api(path, { method: "POST", body });
async function ok(response: Response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}
async function rejected(response: Response, status: number, pattern?: RegExp) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  if (pattern) assert.match(data.error, pattern);
  return data;
}
async function forbidden(work: Promise<unknown>) {
  await assert.rejects(work, (error) => error instanceof HttpError && error.status === 403);
}
async function audits(action: string) {
  return (
    await f.pool.query(
      "SELECT actor_id,site_id,detail FROM audit_event WHERE action=$1 ORDER BY id",
      [action],
    )
  ).rows;
}
async function reportCount() {
  return Number((await f.pool.query("SELECT count(*) FROM ai_usage_report")).rows[0].count);
}
async function balanceRow(site = "atlas") {
  return (await f.pool.query("SELECT * FROM ai_balance WHERE site_id=$1", [site])).rows[0];
}
async function saveBalance(field = "data.balance", enabled = true, operator: Operator = f.editor) {
  return f.app.aiBilling.saveBalance(operator, {
    site: "atlas",
    url: "https://api.example.com/v1/balance?scope=all",
    field,
    enabled,
  });
}
// Marks the row as requested directly, bypassing the HTTP rate limit.
const request = () =>
  f.pool.query("UPDATE ai_balance SET requested_at=now() WHERE site_id='atlas'");
function recording(response: { status: number; body: string } | Error) {
  const calls: { url: string; key: string }[] = [];
  const transport: BalanceTransport = async (input) => {
    calls.push(input);
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, worker: new AiBalanceWorker(f.pool, f.key, transport) };
}

test("P9 reconcile compares live jobs plus rollups with provider reports", async () => {
  const [m0, m1, m2, m3] = await Promise.all([0, 1, 2, 3].map(month));
  await job(0, 100, 50);
  await job(1, 1000, 0);
  await rollup(1, 2, 500, 500);
  await rollup(3, 4, 70, 30);
  await job(0, 999, 999, "notes");
  await f.app.aiBilling.saveReport(f.editor, { site: "atlas", month: m0, tokensIn: 120, tokensOut: 60, note: "十月" });
  await f.app.aiBilling.saveReport(f.admin, { site: "atlas", month: m1, tokensIn: 1500, tokensOut: 530 });
  await f.app.aiBilling.saveReport(f.admin, { site: "atlas", month: m2, tokensIn: 10, tokensOut: 5 });
  await f.app.aiBilling.saveReport(f.admin, { site: "notes", month: m3, tokensIn: 1, tokensOut: 1 });
  const data = await ok(await f.api("/ai/reconcile?site=atlas"));
  assert.equal(data.site, "atlas");
  assert.equal(data.months.length, 12);
  assert.deepEqual(
    data.months.slice(0, 4).map((m: { month: string }) => m.month),
    [m0, m1, m2, m3],
  );
  const [current, previous, empty, unreported] = data.months;
  assert.deepEqual(current.app, { jobs: 1, tokensIn: 100, tokensOut: 50, total: 150 });
  assert.equal(current.provider.total, 180);
  assert.equal(current.provider.note, "十月");
  assert.equal(current.provider.reportedBy, "editor@example.test");
  assert.ok(current.provider.reportedAt);
  assert.deepEqual(current.diff, { tokensIn: 20, tokensOut: 10, total: 30 });
  assert.equal(current.diffPercent, 20);
  // Live job and the rolled-up history of the same month both count.
  assert.deepEqual(previous.app, { jobs: 3, tokensIn: 1500, tokensOut: 500, total: 2000 });
  assert.deepEqual(previous.diff, { tokensIn: 0, tokensOut: 30, total: 30 });
  assert.equal(previous.diffPercent, 1.5);
  // No app usage: a difference but no percentage.
  assert.equal(empty.app.total, 0);
  assert.equal(empty.diff.total, 15);
  assert.equal(empty.diffPercent, null);
  // No report: provider, diff and percentage are all null.
  assert.deepEqual(unreported.app, { jobs: 4, tokensIn: 70, tokensOut: 30, total: 100 });
  assert.equal(unreported.provider, null);
  assert.equal(unreported.diff, null);
  assert.equal(unreported.diffPercent, null);
  // Same definition as the M6 usage endpoint.
  const usage = await f.app.ai.usage(f.admin, "atlas");
  assert.deepEqual(
    usage.months.map((m) => m.tokensIn + m.tokensOut),
    data.months.map((m: { app: { total: number } }) => m.app.total),
  );
  await rejected(await f.api("/ai/reconcile?site=missing"), 404);
  await rejected(await f.api("/ai/reconcile?site=BAD"), 400);
});

test("P9 reconcile upserts one report per month, rejects bad input and never touches budgets", async () => {
  const [m0, m1] = await Promise.all([0, 1].map(month));
  await job(0, 300, 200);
  const usedBefore = await monthlyTokensUsed(f.pool, "atlas");
  await ok(await post("/ai/reconcile", { site: "atlas", month: m1, tokensIn: 5, tokensOut: 6, note: "初稿" }));
  const data = await ok(
    await post("/ai/reconcile", { site: "atlas", month: m1, tokensIn: 50, tokensOut: 60 }),
  );
  assert.equal(await reportCount(), 1);
  const row = data.months.find((m: { month: string }) => m.month === m1);
  assert.deepEqual(
    [row.provider.tokensIn, row.provider.tokensOut, row.provider.note, row.provider.reportedBy],
    [50, 60, "", "owner@example.test"],
  );
  await ok(await post("/ai/reconcile", { site: "atlas", month: m0, tokensIn: 1e12, tokensOut: 0 }));
  const next = (
    await f.pool.query("SELECT to_char(date_trunc('month',now())+interval '1 month','YYYY-MM') AS m")
  ).rows[0].m;
  await rejected(
    await post("/ai/reconcile", { site: "atlas", month: next, tokensIn: 1, tokensOut: 1 }),
    400,
    /未来月份/,
  );
  for (const bad of [
    { month: "2026-13", tokensIn: 1, tokensOut: 1 },
    { month: "1999-12", tokensIn: 1, tokensOut: 1 },
    { month: m1, tokensIn: -1, tokensOut: 1 },
    { month: m1, tokensIn: 1.5, tokensOut: 1 },
    { month: m1, tokensIn: 1e12 + 1, tokensOut: 1 },
    { month: m1, tokensIn: "1", tokensOut: 1 },
    { month: m1, tokensIn: 1, tokensOut: 1, note: "x".repeat(501) },
    { month: m1, tokensIn: 1, tokensOut: 1, extra: true },
  ])
    await rejected(await post("/ai/reconcile", { site: "atlas", ...bad }), 400);
  assert.equal(await reportCount(), 2);
  const saved = await audits("ai.reconcile.save");
  assert.equal(saved.length, 3);
  assert.equal(saved[0].site_id, "atlas");
  assert.deepEqual(saved[1].detail, { month: m1, tokensIn: 50, tokensOut: 60 });
  // Reports are informational: budget usage and job data are unchanged.
  assert.equal(await monthlyTokensUsed(f.pool, "atlas"), usedBefore);
  assert.equal(Number((await f.pool.query("SELECT count(*) FROM ai_job")).rows[0].count), 1);
  assert.equal(Number((await f.pool.query("SELECT count(*) FROM ai_usage_month")).rows[0].count), 0);
  await rejected(await f.api("/ai/reconcile/import?site=atlas"), 405);
  await rejected(await f.api("/ai/balance/check?site=atlas"), 405);
});

test("P9 reconcile and balance permissions: viewer reads, editor writes, other sites forbidden", async () => {
  const m0 = await month(0);
  const report = { site: "atlas", month: m0, tokensIn: 1, tokensOut: 1 };
  const csv = { site: "atlas", csv: `month,tokens_in,tokens_out\n${m0},1,1` };
  const balance = { site: "atlas", url: "https://api.example.com/b", field: "balance", enabled: true };
  const billing = f.app.aiBilling;
  assert.equal((await billing.reconcile(f.viewer, "atlas")).months.length, 12);
  assert.equal((await billing.balance(f.viewer, "atlas")).configured, false);
  await forbidden(billing.saveReport(f.viewer, report));
  await forbidden(billing.importCsv(f.viewer, csv));
  await forbidden(billing.saveBalance(f.viewer, balance));
  await billing.saveReport(f.editor, report);
  await billing.importCsv(f.editor, csv);
  await billing.saveBalance(f.editor, balance);
  await forbidden(billing.requestCheck(f.viewer, { site: "atlas" }));
  await billing.requestCheck(f.editor, { site: "atlas" });
  for (const operator of [f.viewer, f.editor]) {
    await forbidden(billing.reconcile(operator, "notes"));
    await forbidden(billing.balance(operator, "notes"));
    await forbidden(billing.saveReport(operator, { ...report, site: "notes" }));
    await forbidden(billing.importCsv(operator, { ...csv, site: "notes" }));
    await forbidden(billing.saveBalance(operator, { ...balance, site: "notes" }));
    await forbidden(billing.requestCheck(operator, { site: "notes" }));
  }
  assert.equal(await reportCount(), 1);
});

test("P9 CSV import upserts every row in one transaction with one audit event", async () => {
  const [m0, m1, m2] = await Promise.all([0, 1, 2].map(month));
  await f.app.aiBilling.saveReport(f.admin, { site: "atlas", month: m2, tokensIn: 1, tokensOut: 1, note: "旧" });
  await f.pool.query("DELETE FROM audit_event WHERE action LIKE 'ai.%'");
  const csv = `﻿month,tokens_in,tokens_out,note\r\n${m0},100,20,"本月, 预估"\r\n${m1},2000,300,"含 ""引号"""\r\n${m2},7,8,\r\n\r\n`;
  const data = await ok(await post("/ai/reconcile/import", { site: "atlas", csv }));
  assert.equal(data.imported, 3);
  const byMonth = Object.fromEntries(
    data.months.map((m: { month: string; provider: unknown }) => [m.month, m.provider]),
  );
  assert.equal(byMonth[m0].note, "本月, 预估");
  assert.equal(byMonth[m0].total, 120);
  assert.equal(byMonth[m1].note, '含 "引号"');
  assert.deepEqual([byMonth[m2].tokensIn, byMonth[m2].tokensOut, byMonth[m2].note], [7, 8, ""]);
  assert.equal(await reportCount(), 3);
  const imported = await audits("ai.reconcile.import");
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0].detail, { rows: 3, months: [m0, m1, m2] });
  assert.equal((await audits("ai.reconcile.save")).length, 0);
  // Header without note works too.
  await ok(await post("/ai/reconcile/import", { site: "atlas", csv: `MONTH, tokens_in ,tokens_out\n${m1},1,2` }));
  assert.equal(
    (await f.pool.query("SELECT tokens_in FROM ai_usage_report WHERE month=to_date($1,'YYYY-MM')", [m1])).rows[0]
      .tokens_in,
    "1",
  );
});

test("P9 CSV import rejects the whole file with row-numbered errors", async () => {
  const [m0, m1] = await Promise.all([0, 1].map(month));
  const next = (
    await f.pool.query("SELECT to_char(date_trunc('month',now())+interval '1 month','YYYY-MM') AS m")
  ).rows[0].m;
  const csv = [
    "month,tokens_in,tokens_out,note",
    `${m0},10,10,ok`,
    `2026/09,1,1,`,
    `${next},1,1,`,
    `${m0},1,1,dup`,
    `${m1},-5,1,`,
    `${m1},1,1`,
    `${m1},1,"unterminated`,
    `${m1},1.5,99999999999999,`,
  ].join("\n");
  const data = await rejected(await post("/ai/reconcile/import", { site: "atlas", csv }), 400, /第 3 行/);
  assert.deepEqual(
    data.errors.map((e: { row: number }) => e.row),
    [3, 4, 5, 6, 7, 8, 9],
  );
  assert.match(data.errors[1].message, /未来/);
  assert.match(data.errors[2].message, /第 2 行重复/);
  assert.match(data.errors[4].message, /应有 4 列/);
  assert.match(data.errors[6].message, /tokens_in.*tokens_out|tokens_out/);
  assert.equal(await reportCount(), 0);
  assert.equal((await audits("ai.reconcile.import")).length, 0);
  await rejected(
    await post("/ai/reconcile/import", { site: "atlas", csv: `month,in,out\n${m0},1,1` }),
    400,
    /表头/,
  );
  await rejected(await post("/ai/reconcile/import", { site: "atlas", csv: "month,tokens_in,tokens_out\n" }), 400, /没有数据/);
  const many = ["month,tokens_in,tokens_out", ...Array.from({ length: 121 }, () => `${m0},1,1`)].join("\n");
  await rejected(await post("/ai/reconcile/import", { site: "atlas", csv: many }), 400, /120/);
  const big = `month,tokens_in,tokens_out,note\n${m0},1,1,${"x".repeat(65 * 1024)}`;
  await rejected(await post("/ai/reconcile/import", { site: "atlas", csv: big }), 400, /64 KiB/);
  assert.equal(await reportCount(), 0);
});

test("P9 balance config validates URL and field path and clears previous results", async () => {
  const base = { site: "atlas", url: "https://api.example.com/b", field: "data.balance", enabled: true };
  for (const bad of [
    { url: "http://api.example.com/b" },
    { url: "https://10.0.0.8/b" },
    { url: "https://[::1]/b" },
    { url: "https://localhost/b" },
    { url: "https://billing.internal/b" },
    { url: "https://user:pass@api.example.com/b" },
    { url: "not a url" },
    { field: "data..balance" },
    { field: "data-balance" },
    { field: "a.b.c.d.e.f.g.h.i" },
    { field: "" },
    { enabled: "yes" },
  ])
    await rejected(await post("/ai/balance", { ...base, ...bad }), 400);
  assert.equal(await balanceRow(), undefined);
  const empty = await ok(await f.api("/ai/balance?site=atlas"));
  assert.deepEqual(empty, {
    configured: false,
    url: "",
    field: "",
    enabled: false,
    value: null,
    checkedAt: null,
    requestedAt: null,
    error: null,
  });
  await ok(await post("/ai/balance", { ...base, field: "a.b.c.d.e.f.g.h" }));
  await f.pool.query(
    "UPDATE ai_balance SET value=12.5,error_code='http_500',checked_at=now(),requested_at=now() WHERE site_id='atlas'",
  );
  const saved = await ok(await post("/ai/balance", base));
  assert.equal(saved.configured, true);
  assert.equal(saved.url, base.url);
  assert.equal(saved.field, "data.balance");
  assert.equal(saved.enabled, true);
  assert.equal(saved.value, null);
  assert.equal(saved.error, null);
  assert.equal(saved.checkedAt, null);
  assert.equal(saved.requestedAt, null);
  const audit = await audits("ai.balance.save");
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[1].detail, { host: "api.example.com", field: "data.balance", enabled: true });
  await rejected(await f.api("/ai/balance?site=missing"), 404);
});

test("P9 balance check requests are queued and rate limited", async () => {
  await rejected(await post("/ai/balance/check", { site: "atlas" }), 404, /尚未配置/);
  await saveBalance();
  const queued = await ok(await post("/ai/balance/check", { site: "atlas" }), 202);
  assert.ok(queued.requestedAt);
  assert.equal(queued.value, null);
  await rejected(await post("/ai/balance/check", { site: "atlas" }), 409, /排队/);
  const { worker, calls } = recording({ status: 200, body: '{"data":{"balance":3}}' });
  assert.equal(await worker.runOnce(), true);
  assert.equal(calls.length, 1);
  await rejected(await post("/ai/balance/check", { site: "atlas" }), 409, /60 秒/);
  await f.pool.query("UPDATE ai_balance SET checked_at=now()-interval '61 seconds'");
  await ok(await post("/ai/balance/check", { site: "atlas" }), 202);
  // While a worker holds the row, a new request is reported as in progress.
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = new AiBalanceWorker(f.pool, f.key, async () => {
    entered();
    await gate;
    return { status: 200, body: '{"data":{"balance":4}}' };
  });
  const running = slow.runOnce();
  await inside;
  await rejected(await post("/ai/balance/check", { site: "atlas" }), 409, /正在进行/);
  release();
  assert.equal(await running, true);
  assert.equal(Number((await balanceRow()).value), 4);
  await saveBalance("data.balance", false);
  await rejected(await post("/ai/balance/check", { site: "atlas" }), 409, /未启用/);
});

test("P9 balance worker sends the unsealed key and reads the field", async () => {
  const { worker, calls } = recording({ status: 200, body: '{"data":{"balance":12.5,"currency":"USD"}}' });
  assert.equal(await worker.runOnce(), false);
  await saveBalance();
  await f.app.aiBilling.requestCheck(f.editor, { site: "atlas" });
  assert.equal(await worker.runOnce(), true);
  assert.deepEqual(calls, [
    { url: "https://api.example.com/v1/balance?scope=all", key: "sk-test-12345678" },
  ]);
  const sealed = (await f.pool.query("SELECT sealed_key FROM ai_config WHERE site_id='atlas'")).rows[0]
    .sealed_key;
  assert.doesNotMatch(sealed, /sk-test/);
  const state = await f.app.aiBilling.balance(f.viewer, "atlas");
  assert.equal(state.value, 12.5);
  assert.equal(state.error, null);
  assert.equal(state.requestedAt, null);
  assert.ok(state.checkedAt);
  // Nothing left to do until a new request or the 6 hour re-check.
  assert.equal(await worker.runOnce(), false);
  // Decimal strings inside arrays (e.g. DeepSeek's balance_infos) are read too.
  await saveBalance("balance_infos.0.total_balance");
  const deep = recording({
    status: 200,
    body: '{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00"}]}',
  });
  assert.equal(await deep.worker.runOnce(), true);
  assert.equal((await f.app.aiBilling.balance(f.admin, "atlas")).value, 110);
  const row = await balanceRow();
  assert.equal(JSON.stringify(row).includes("sk-test"), false);
  assert.equal(JSON.stringify(row).includes("CNY"), false);
});

test("P9 balance worker stores stable error codes and clears the value", async () => {
  await saveBalance();
  const cases: [{ status: number; body: string } | Error, string][] = [
    [{ status: 401, body: '{"error":"bad key sk-test-12345678"}' }, "http_401"],
    [{ status: 302, body: "" }, "http_302"],
    [{ status: 200, body: "<html>nope</html>" }, "invalid_json"],
    [{ status: 200, body: '{"data":{}}' }, "field_missing"],
    [{ status: 200, body: '{"data":null}' }, "field_missing"],
    [{ status: 200, body: '{"data":{"balance":"abc"}}' }, "not_a_number"],
    [{ status: 200, body: '{"data":{"balance":true}}' }, "not_a_number"],
    [{ status: 200, body: '{"data":{"balance":{"amount":1}}}' }, "not_a_number"],
    [new Error("timeout"), "timeout"],
    [new Error("Something with sk-test-12345678 in it"), "request_failed"],
  ];
  for (const [response, code] of cases) {
    await f.pool.query("UPDATE ai_balance SET value=99,error_code=NULL WHERE site_id='atlas'");
    await request();
    assert.equal(await recording(response).worker.runOnce(), true);
    const row = await balanceRow();
    assert.equal(row.error_code, code, JSON.stringify(response));
    assert.equal(row.value, null);
    assert.equal(row.requested_at, null);
    assert.ok(row.checked_at);
  }
  await f.pool.query("DELETE FROM ai_config WHERE site_id='atlas'");
  await request();
  const { worker, calls } = recording({ status: 200, body: '{"data":{"balance":1}}' });
  assert.equal(await worker.runOnce(), true);
  assert.equal(calls.length, 0);
  assert.equal((await balanceRow()).error_code, "no_ai_config");
  assert.equal((await f.app.aiBilling.balance(f.admin, "atlas")).error, "no_ai_config");
});

test("P9 balance worker re-checks automatically after 6 hours and skips disabled rows", async () => {
  await saveBalance();
  const { worker, calls } = recording({ status: 200, body: '{"data":{"balance":5}}' });
  // A never-checked enabled row is picked up without a manual request.
  assert.equal(await worker.runOnce(), true);
  assert.equal(await worker.runOnce(), false);
  await f.pool.query("UPDATE ai_balance SET checked_at=now()-interval '5 hours'");
  assert.equal(await worker.runOnce(), false);
  await f.pool.query("UPDATE ai_balance SET checked_at=now()-interval '6 hours 1 minute'");
  assert.equal(await worker.runOnce(), true);
  assert.equal(calls.length, 2);
  await saveBalance("data.balance", false);
  await f.pool.query("UPDATE ai_balance SET checked_at=now()-interval '7 hours'");
  assert.equal(await worker.runOnce(), false);
  await request();
  assert.equal(await worker.runOnce(), false);
  assert.equal(calls.length, 2);
});

test("P9 real balance transport refuses private addresses before connecting", async () => {
  assert.throws(() => pickPublicAddress([]), /unsafe_address/);
  assert.throws(() => pickPublicAddress([{ address: "10.1.2.3", family: 4 }]), /unsafe_address/);
  assert.throws(
    () =>
      pickPublicAddress([
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:127.0.0.1", family: 6 },
      ]),
    /unsafe_address/,
  );
  assert.deepEqual(pickPublicAddress([{ address: "93.184.216.34", family: 4 }]), {
    address: "93.184.216.34",
    family: 4,
  });
  await assert.rejects(balanceRequest({ url: "https://127.0.0.1/b", key: "k" }), /unsafe_address/);
  await assert.rejects(balanceRequest({ url: "http://api.example.com/b", key: "k" }), /unsafe_address/);
  // The P0 runner maps its test hostnames to 127.0.0.1 in /etc/hosts.
  const host = process.env.P0_HOSTS?.split(",")[0];
  assert.ok(host || !process.env.P0_RUN_ID, "P0 runner should provide test hostnames");
  if (host) {
    await assert.rejects(balanceRequest({ url: `https://${host}/balance`, key: "k" }), /unsafe_address/);
    await f.app.aiBilling.saveBalance(f.admin, {
      site: "atlas",
      url: `https://${host}/balance`,
      field: "balance",
      enabled: true,
    });
    assert.equal(await new AiBalanceWorker(f.pool, f.key).runOnce(), true);
    assert.equal((await balanceRow()).error_code, "unsafe_address");
  }
});

test("P9 billing page shows the monthly difference and requests a balance check", async () => {
  const m1 = await month(1);
  await job(1, 1000, 0);
  const session = await f.browse(f.editor, "#ai-billing/atlas");
  try {
    const { page } = session;
    await page.waitForSelector(`#ai-reconcile tr[data-month="${m1}"]`);
    assert.equal(await page.locator("#ai-reconcile tbody tr").count(), 12);
    await page.fill("#reconcile-month", m1);
    await page.fill("#reconcile-in", "1100");
    await page.fill("#reconcile-out", "0");
    await page.fill("#reconcile-note", "<b>九月</b>");
    await page.click("#save-reconcile");
    await page.waitForSelector(`#ai-reconcile tr[data-month="${m1}"][data-alert="true"]`);
    const row = `#ai-reconcile tr[data-month="${m1}"]`;
    assert.equal((await page.textContent(`${row} .diff-total`))?.trim(), "+100");
    assert.equal((await page.textContent(`${row} .diff-percent`))?.trim(), "+10%");
    assert.match((await page.textContent(row)) ?? "", /<b>九月<\/b>/);
    assert.match((await page.textContent("#message")) ?? "", /已保存/);
    // A rejected CSV lists row errors and writes nothing.
    await page.click("#reconcile-panel ~ section details summary");
    await page.fill("#reconcile-csv", `month,tokens_in,tokens_out\n${m1},x,1`);
    await page.click("#import-reconcile");
    await page.waitForSelector("#message.error");
    assert.match((await page.textContent("#reconcile-errors")) ?? "", /第 2 行/);
    // Balance: save settings, request a check, and see the worker's result by polling.
    await page.fill("#balance-url", "https://api.example.com/balance");
    await page.fill("#balance-field", "data.balance");
    await page.click("#save-balance");
    await page.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("余额设置已保存"));
    await page.click("#check-balance");
    await page.waitForFunction(() => document.querySelector("#balance-state")?.textContent?.includes("排队"));
    const { worker, calls } = recording({ status: 200, body: '{"data":{"balance":42}}' });
    assert.equal(await worker.runOnce(), true);
    assert.equal(calls[0]!.key, "sk-test-12345678");
    await page.waitForFunction(
      () => document.querySelector("#balance-state")?.textContent?.includes("余额：42"),
      undefined,
      { timeout: 15000 },
    );
    await page.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("余额已更新"));
  } finally {
    await session.close();
  }
  assert.equal(await reportCount(), 1);
});
