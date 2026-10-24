import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "./helpers.js";
import { monthlyTokensUsed, pruneAiJobs } from "../../src/server/ai.js";
import { runMaintenance } from "../../src/server/maintenance.js";
import { DEFAULT_RETENTION, type RetentionPolicy } from "../../src/server/retention.js";

let f: Fixture;
// 35 days is the minimum allowed retention; every job created two or more months ago
// (and completed shortly after) is older than that.
const policy: RetentionPolicy = { ...DEFAULT_RETENTION, aiJobDays: 35 };
type Job = {
  site?: string;
  monthsAgo: number;
  status?: "pending" | "processing" | "done" | "failed" | "cancelled";
  tokensIn?: number;
  tokensOut?: number;
  // SQL interval before now() for completed_at; null leaves it empty; default is created_at+1h.
  completedAgo?: string | null;
};
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
beforeEach(async () => {
  await f.pool.query("DELETE FROM ai_job");
  await f.pool.query("DELETE FROM ai_usage_month");
});
async function insert(job: Job) {
  const status = job.status ?? "done";
  const terminal = ["done", "failed", "cancelled"].includes(status);
  const { rows } = await f.pool.query(
    `INSERT INTO ai_job(site_id,kind,payload,status,tokens_in,tokens_out,created_at,completed_at)
     SELECT $1,'generate','{}',$2,$3,$4,c,
       CASE WHEN $6::boolean THEN NULL WHEN $5::interval IS NULL THEN c+interval '1 hour' ELSE now()-$5::interval END
     FROM (SELECT date_trunc('month',now())-$7::int*interval '1 month'
                  +CASE WHEN $7::int=0 THEN interval '0' ELSE interval '2 days' END AS c) t
     RETURNING id`,
    [
      job.site ?? "atlas",
      status,
      job.tokensIn ?? 10,
      job.tokensOut ?? 5,
      job.completedAgo ?? null,
      job.completedAgo === null || !terminal,
      job.monthsAgo,
    ],
  );
  return rows[0].id as string;
}
const monthKey = async (monthsAgo: number) =>
  (
    await f.pool.query(
      "SELECT to_char(date_trunc('month',now())-$1::int*interval '1 month','YYYY-MM') AS m",
      [monthsAgo],
    )
  ).rows[0].m as string;
async function rollups() {
  const { rows } = await f.pool.query(
    "SELECT site_id,to_char(month,'YYYY-MM') AS month,jobs,tokens_in::int,tokens_out::int FROM ai_usage_month ORDER BY site_id,month",
  );
  return rows;
}
async function usage(site: string) {
  const response = await f.api("/ai/usage?site=" + site);
  assert.equal(response.status, 200);
  return response.json();
}
async function liveIds() {
  return (await f.pool.query("SELECT id FROM ai_job ORDER BY id")).rows.map(
    (row) => row.id as string,
  );
}

test("P6 AI prune rolls old terminal jobs into monthly usage per site and month", async () => {
  // Eligible: terminal, older than the retention window and from a past month.
  await insert({ monthsAgo: 3, tokensIn: 100, tokensOut: 20 });
  await insert({ monthsAgo: 3, status: "failed", tokensIn: 7, tokensOut: 0 });
  await insert({ monthsAgo: 4, status: "cancelled", completedAgo: null, tokensIn: 0, tokensOut: 0 });
  await insert({ monthsAgo: 4, tokensIn: 50, tokensOut: 50 });
  await insert({ site: "notes", monthsAgo: 3, tokensIn: 1, tokensOut: 2 });
  await insert({ site: "notes", monthsAgo: 8, tokensIn: 30, tokensOut: 40 });
  // Kept: recently completed, current month (even with an old completed_at), not terminal.
  const keep = [
    await insert({ monthsAgo: 2, completedAgo: "10 days" }),
    await insert({ monthsAgo: 0, completedAgo: "400 days", tokensIn: 300 }),
    await insert({ site: "notes", monthsAgo: 0, status: "failed", completedAgo: "400 days" }),
    await insert({ monthsAgo: 5, status: "pending" }),
    await insert({ site: "notes", monthsAgo: 6, status: "processing" }),
  ].sort();
  const before = { atlas: await usage("atlas"), notes: await usage("notes") };

  assert.deepEqual(await pruneAiJobs(f.pool, policy), { deletedJobs: 6, batches: 1 });
  assert.deepEqual(await liveIds(), keep);
  const [m3, m4, m8] = [await monthKey(3), await monthKey(4), await monthKey(8)];
  const expected = [
    { site_id: "atlas", month: m4, jobs: 2, tokens_in: 50, tokens_out: 50 },
    { site_id: "atlas", month: m3, jobs: 2, tokens_in: 107, tokens_out: 20 },
    { site_id: "notes", month: m8, jobs: 1, tokens_in: 30, tokens_out: 40 },
    { site_id: "notes", month: m3, jobs: 1, tokens_in: 1, tokens_out: 2 },
  ].sort((a, b) => (a.site_id + a.month).localeCompare(b.site_id + b.month));
  assert.deepEqual(await rollups(), expected);
  assert.deepEqual(await usage("atlas"), before.atlas);
  assert.deepEqual(await usage("notes"), before.notes);

  // Rerunning is a no-op and never double counts.
  assert.deepEqual(await pruneAiJobs(f.pool, policy), { deletedJobs: 0, batches: 0 });
  assert.deepEqual(await rollups(), expected);
  assert.deepEqual(await liveIds(), keep);

  // A later prune into an existing month adds onto the rollup.
  await insert({ monthsAgo: 3, tokensIn: 3, tokensOut: 4 });
  const atlasBefore = await usage("atlas");
  assert.deepEqual(await pruneAiJobs(f.pool, policy), { deletedJobs: 1, batches: 1 });
  const row = (await rollups()).find((r) => r.site_id === "atlas" && r.month === m3);
  assert.deepEqual(row, { site_id: "atlas", month: m3, jobs: 3, tokens_in: 110, tokens_out: 24 });
  assert.deepEqual(await usage("atlas"), atlasBefore);
});

test("P6 AI usage reports 12 months, current month and budget", async () => {
  await insert({ monthsAgo: 0, tokensIn: 40, tokensOut: 2 });
  await insert({ monthsAgo: 0, status: "pending", tokensIn: 0, tokensOut: 0 });
  await insert({ monthsAgo: 5, tokensIn: 9, tokensOut: 1 });
  await insert({ monthsAgo: 12, tokensIn: 999, tokensOut: 999 });
  const data = await usage("atlas");
  assert.equal(data.site, "atlas");
  assert.equal(data.months.length, 12);
  assert.equal(data.months[0].month, await monthKey(0));
  assert.equal(data.months[11].month, await monthKey(11));
  assert.deepEqual(data.currentMonth, { jobs: 2, tokensIn: 40, tokensOut: 2, used: 42 });
  assert.deepEqual(data.months[5], { month: await monthKey(5), jobs: 1, tokensIn: 9, tokensOut: 1 });
  assert.equal(
    data.months.reduce((n: number, m: { jobs: number }) => n + m.jobs, 0),
    3,
  );
  assert.equal((await usage("notes")).monthlyTokens, null);
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    key: "sk-test-12345678",
    enabled: true,
    monthlyTokens: 5000,
  });
  assert.equal((await usage("atlas")).monthlyTokens, 5000);
});

test("P6 AI prune batches stop at maxBatches and continue on the next run", async () => {
  for (let i = 0; i < 8; i++)
    await insert({ site: i % 2 ? "notes" : "atlas", monthsAgo: 2 + (i % 3), tokensIn: i, tokensOut: 1 });
  const keep = await insert({ monthsAgo: 0 });
  const before = { atlas: await usage("atlas"), notes: await usage("notes") };
  const small = { ...policy, batchSize: 3, maxBatches: 2 };
  assert.deepEqual(await pruneAiJobs(f.pool, small), { deletedJobs: 6, batches: 2 });
  assert.equal((await liveIds()).length, 3);
  assert.deepEqual(await pruneAiJobs(f.pool, small), { deletedJobs: 2, batches: 1 });
  assert.deepEqual(await liveIds(), [keep]);
  assert.deepEqual(await pruneAiJobs(f.pool, small), { deletedJobs: 0, batches: 0 });
  const totals = (
    await f.pool.query(
      "SELECT sum(jobs)::int AS jobs,sum(tokens_in)::int AS tin,sum(tokens_out)::int AS tout FROM ai_usage_month",
    )
  ).rows[0];
  assert.deepEqual(totals, { jobs: 8, tin: 28, tout: 8 });
  assert.deepEqual(await usage("atlas"), before.atlas);
  assert.deepEqual(await usage("notes"), before.notes);
});

test("P6 AI budget stays enforced after pruning", async () => {
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    key: "sk-test-12345678",
    enabled: true,
    monthlyTokens: 100000,
  });
  const job = { site: "atlas", kind: "generate", locale: "zh", title: "示例" };
  const current = await insert({ monthsAgo: 0, tokensIn: 60000, tokensOut: 50000 });
  await insert({ monthsAgo: 3, tokensIn: 50000, tokensOut: 50000 });
  assert.deepEqual(await pruneAiJobs(f.pool, policy), { deletedJobs: 1, batches: 1 });
  assert.equal(await monthlyTokensUsed(f.pool, "atlas"), 110000);
  await assert.rejects(f.app.ai.create(f.editor, job), { status: 429 });
  // The worker excludes the job it is running from the total.
  assert.equal(await monthlyTokensUsed(f.pool, "atlas", current), 0);
  // Pruned history from earlier months never counts against this month.
  await f.pool.query("DELETE FROM ai_job WHERE id=$1", [current]);
  const created = await f.app.ai.create(f.editor, job);
  assert.equal(created.status, "pending");
  // Usage rolled up for the current month (e.g. after a policy change) still counts.
  await f.pool.query(
    "INSERT INTO ai_usage_month(site_id,month,jobs,tokens_in,tokens_out) VALUES('atlas',date_trunc('month',now())::date,1,90000,10000)",
  );
  assert.equal(await monthlyTokensUsed(f.pool, "atlas", created.id), 100000);
  await assert.rejects(f.app.ai.create(f.editor, job), { status: 429 });
  // The pending job holds a reservation, which gates admission; reported usage stays real spend.
  const reserved = (
    await f.pool.query("SELECT reserved_tokens FROM ai_job WHERE id=$1", [created.id])
  ).rows[0].reserved_tokens as number;
  assert.ok(reserved > 0);
  assert.equal((await usage("atlas")).currentMonth.used, 100000);
});

test("P6 AI usage endpoint enforces site read permission", async () => {
  assert.equal((await f.app.ai.usage(f.viewer, "atlas")).site, "atlas");
  assert.equal((await f.app.ai.usage(f.editor, "atlas")).site, "atlas");
  await assert.rejects(f.app.ai.usage(f.viewer, "notes"), { status: 403 });
  await assert.rejects(f.app.ai.usage(f.editor, "notes"), { status: 403 });
  assert.equal((await f.api("/ai/usage?site=missing")).status, 404);
  assert.notEqual((await f.api("/ai/usage?site=Bad!")).status, 200);
  assert.equal((await f.api("/ai/usage?site=atlas", { method: "POST", body: {} })).status, 405);
});

test("P6 AI retention runs from scheduled maintenance", async () => {
  await insert({ monthsAgo: 3 });
  await insert({ site: "notes", monthsAgo: 4, status: "failed" });
  const keep = await insert({ monthsAgo: 0 });
  const result = await runMaintenance(f.pool, { policy, force: true });
  assert.deepEqual(result?.ai, { deletedJobs: 2, batches: 1 });
  assert.deepEqual(await liveIds(), [keep]);
  assert.equal((await rollups()).length, 2);
  // Default policy keeps 180 days, so recent history is untouched.
  await insert({ monthsAgo: 2 });
  const again = await runMaintenance(f.pool, { force: true });
  assert.deepEqual(again?.ai, { deletedJobs: 0, batches: 0 });
});

test("P6 AI settings page shows usage against budget and monthly history", async () => {
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    key: "sk-test-12345678",
    enabled: true,
    monthlyTokens: 1000,
  });
  await insert({ monthsAgo: 0, tokensIn: 300, tokensOut: 200 });
  await insert({ monthsAgo: 3, tokensIn: 70, tokensOut: 7 });
  assert.equal((await pruneAiJobs(f.pool, policy)).deletedJobs, 1);
  const reader = await f.browse(f.viewer, "#ai/atlas");
  try {
    const { page } = reader;
    await page.waitForSelector("#ai-usage-months");
    const summary = (await page.textContent("#ai-usage")) ?? "";
    assert.match(summary, /1 个任务/);
    assert.match(summary, /已用 500 \/ 1,000 token（50%）/);
    assert.equal(await page.getAttribute("#ai-usage-bar", "value"), "50");
    assert.equal(await page.locator("#ai-usage-months tbody tr").count(), 12);
    const rolled = page.locator("#ai-usage-months tbody tr").nth(3);
    assert.equal(await rolled.locator("td").first().textContent(), await monthKey(3));
    assert.equal(await rolled.locator("td").last().textContent(), "77");
  } finally {
    await reader.close();
  }
});
