import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { AiWorker, type AiTransport } from "../../src/server/ai.js";
import type { Operator } from "../../src/server/operators.js";

let f: Fixture;
type Status = "pending" | "processing" | "done" | "failed" | "cancelled";
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
beforeEach(async () => {
  await f.pool.query("DELETE FROM ai_job");
  await f.pool.query("DELETE FROM ai_usage_month");
  await f.pool.query("DELETE FROM audit_event WHERE action LIKE 'ai.%'");
  await configure();
});
async function configure(enabled = true, monthlyTokens = 100000) {
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    key: "sk-test-12345678",
    enabled,
    monthlyTokens,
  });
}
const input = { site: "atlas", kind: "generate", locale: "zh", title: "示例", brief: "简洁" };
async function create(operator: Operator = f.editor) {
  return (await f.app.ai.create(operator, input)).id as string;
}
// Inserts a job directly; secondsAgo orders the list (larger = older).
async function insert(status: Status, secondsAgo: number, site = "atlas") {
  const terminal = ["done", "failed", "cancelled"].includes(status);
  const { rows } = await f.pool.query(
    `INSERT INTO ai_job(site_id,actor_id,kind,payload,status,error_code,tokens_in,tokens_out,created_at,completed_at)
     VALUES($1,$2,'translate',$3,$4,$5,3,2,now()-$6::int*interval '1 second',
       CASE WHEN $7::boolean THEN now()-$6::int*interval '1 second'+interval '1 second' END)
     RETURNING id`,
    [
      site,
      f.editor.id,
      { locale: "en", title: "Hello", brief: "" },
      status,
      status === "failed" ? "provider_http_500" : null,
      secondsAgo,
      terminal,
    ],
  );
  return rows[0].id as string;
}
async function row(id: string) {
  return (await f.pool.query("SELECT * FROM ai_job WHERE id=$1", [id])).rows[0];
}
async function list(query: string) {
  const response = await f.api("/ai/jobs?" + query);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const post = (path: string, body: unknown) => f.api(path, { method: "POST", body });
const okTransport =
  (title: string, tokensIn = 11, tokensOut = 4): AiTransport =>
  async () => ({ output: { title }, tokensIn, tokensOut, model: "m-" + title });
// A transport that blocks until released, so tests can act while the call is in flight.
function blocking() {
  let entered!: () => void, release!: (value: Awaited<ReturnType<AiTransport>> | Error) => void;
  const called = new Promise<void>((resolve) => (entered = resolve));
  const result = new Promise<Awaited<ReturnType<AiTransport>> | Error>((resolve) => (release = resolve));
  const transport: AiTransport = async () => {
    entered();
    const value = await result;
    if (value instanceof Error) throw value;
    return value;
  };
  return { transport, called, release };
}
async function audits() {
  return (
    await f.pool.query(
      "SELECT action,actor_id,site_id,detail FROM audit_event WHERE action LIKE 'ai.job.%' ORDER BY id",
    )
  ).rows;
}

test("P7 AI job list pages newest first, filters by status and hides payload", async () => {
  const statuses: Status[] = ["done", "failed", "cancelled", "pending", "processing"];
  const ids: string[] = [];
  for (let i = 0; i < 120; i++) ids.push(await insert(statuses[i % 5]!, i));
  await insert("done", 0, "notes");
  const first = await list("site=atlas");
  assert.equal(first.page, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.items.length, 50);
  assert.deepEqual(
    first.items.map((item: { id: string }) => item.id),
    ids.slice(0, 50),
  );
  assert.deepEqual(Object.keys(first.items[1]).sort(), [
    "actor",
    "completedAt",
    "createdAt",
    "error",
    "id",
    "kind",
    "promptVersion",
    "retriedBy",
    "retryOf",
    "status",
    "tokens",
  ]);
  assert.deepEqual(
    { ...first.items[1], createdAt: undefined, completedAt: undefined },
    {
      id: ids[1],
      kind: "translate",
      status: "failed",
      error: "provider_http_500",
      tokens: { input: 3, output: 2 },
      actor: "editor@example.test",
      retryOf: null,
      retriedBy: null,
      promptVersion: "v1",
      createdAt: undefined,
      completedAt: undefined,
    },
  );
  assert.equal(first.items[3].completedAt, null);
  const second = await list("site=atlas&page=2");
  assert.deepEqual(second.items.map((item: { id: string }) => item.id), ids.slice(50, 100));
  assert.equal(second.hasMore, true);
  const third = await list("site=atlas&page=3");
  assert.equal(third.items.length, 20);
  assert.equal(third.hasMore, false);
  assert.deepEqual((await list("site=atlas&page=4")).items, []);
  const failed = await list("site=atlas&status=failed");
  assert.equal(failed.items.length, 24);
  assert.equal(failed.hasMore, false);
  assert.ok(failed.items.every((item: { status: string }) => item.status === "failed"));
  assert.deepEqual(
    failed.items.map((item: { id: string }) => item.id),
    ids.filter((_, i) => i % 5 === 1),
  );
  assert.equal((await list("site=notes")).items.length, 1);
  // Validation and permissions.
  for (const query of ["site=atlas&page=0", "site=atlas&page=10001", "site=atlas&page=x", "site=atlas&status=bogus", "site=Bad!"])
    assert.equal((await f.api("/ai/jobs?" + query)).status, 400, query);
  assert.equal((await f.api("/ai/jobs?site=missing")).status, 404);
  assert.equal((await f.app.ai.jobs(f.viewer, { site: "atlas" })).items.length, 50);
  assert.equal((await f.app.ai.jobs(f.editor, { site: "atlas", page: 3 })).items.length, 20);
  await assert.rejects(f.app.ai.jobs(f.viewer, { site: "notes" }), { status: 403 });
  await assert.rejects(f.app.ai.jobs(f.editor, { site: "notes" }), { status: 403 });
  // Detail and create keep working.
  const detail = await f.api(`/ai/jobs/${ids[0]}?site=atlas`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).id, ids[0]);
  const created = await post("/ai/jobs", input);
  assert.equal(created.status, 201);
  assert.equal((await list("site=atlas&status=pending")).items[0].id, (await created.json()).id);
});

test("P7 AI cancel pending job, rejects terminal jobs and enforces write permission", async () => {
  const id = await create();
  await assert.rejects(f.app.ai.cancel(f.viewer, id, { site: "atlas" }), { status: 403 });
  await assert.rejects(f.app.ai.cancel(f.editor, id, { site: "notes" }), { status: 403 });
  const response = await post(`/ai/jobs/${id}/cancel`, { site: "atlas" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "cancelled");
  const cancelled = await row(id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error_code, "cancelled_by_operator");
  assert.ok(cancelled.completed_at);
  assert.equal(cancelled.lease_token, null);
  // Nothing is left for the worker.
  assert.equal(await new AiWorker(f.pool, f.key, okTransport("x")).runOnce(), false);
  for (const status of ["done", "failed", "cancelled"] as Status[]) {
    const other = await insert(status, 5);
    const conflict = await post(`/ai/jobs/${other}/cancel`, { site: "atlas" });
    assert.equal(conflict.status, 409, status);
    assert.equal((await row(other)).status, status);
  }
  const foreign = await insert("pending", 1, "notes");
  assert.equal((await post(`/ai/jobs/${foreign}/cancel`, { site: "atlas" })).status, 404);
  assert.equal((await row(foreign)).status, "pending");
  assert.equal(
    (await post(`/ai/jobs/00000000-0000-4000-8000-000000000000/cancel`, { site: "atlas" })).status,
    404,
  );
  assert.equal((await post(`/ai/jobs/${id}/cancel`, {})).status, 400);
  assert.equal((await f.api(`/ai/jobs/${id}/cancel?site=atlas`)).status, 405);
  // An editor can cancel on its own site.
  const own = await create();
  assert.equal((await f.app.ai.cancel(f.editor, own, { site: "atlas" })).status, "cancelled");
  assert.deepEqual(await audits(), [
    { action: "ai.job.cancel", actor_id: f.admin.id, site_id: "atlas", detail: { jobId: id, from: "pending" } },
    { action: "ai.job.cancel", actor_id: f.editor.id, site_id: "atlas", detail: { jobId: own, from: "pending" } },
  ]);
});

test("P7 AI cancel while the provider call is in flight keeps tokens but discards output", async () => {
  const id = await create();
  const gate = blocking();
  const run = new AiWorker(f.pool, f.key, gate.transport).runOnce();
  await gate.called;
  assert.equal((await row(id)).status, "processing");
  const response = await post(`/ai/jobs/${id}/cancel`, { site: "atlas" });
  assert.equal(response.status, 200);
  gate.release({ output: { title: "迟到的输出" }, tokensIn: 40, tokensOut: 9, model: "late-model" });
  assert.equal(await run, true);
  const job = await row(id);
  assert.equal(job.status, "cancelled");
  assert.equal(job.error_code, "cancelled_by_operator");
  assert.equal(job.output, null);
  assert.equal(job.tokens_in, 40);
  assert.equal(job.tokens_out, 9);
  assert.equal(job.provider_model, "late-model");
  assert.equal(job.lease_token, null);
  assert.deepEqual((await audits())[0]?.detail, { jobId: id, from: "processing" });
  // Spent tokens count against the monthly budget.
  assert.equal((await f.app.ai.usage(f.editor, "atlas")).currentMonth.used, 49);

  // A provider failure after cancellation neither retries nor fails the job.
  const second = await create();
  const failing = blocking();
  const again = new AiWorker(f.pool, f.key, failing.transport).runOnce();
  await failing.called;
  await f.app.ai.cancel(f.editor, second, { site: "atlas" });
  failing.release(new Error("provider_http_502"));
  await again;
  const stillCancelled = await row(second);
  assert.equal(stillCancelled.status, "cancelled");
  assert.equal(stillCancelled.error_code, "cancelled_by_operator");
  assert.equal(await new AiWorker(f.pool, f.key, okTransport("x")).runOnce(), false);
});

test("P7 AI lease guard ignores a stale worker after its lease was re-claimed", async () => {
  const id = await create();
  const stale = blocking();
  const first = new AiWorker(f.pool, f.key, stale.transport).runOnce();
  await stale.called;
  await f.pool.query("UPDATE ai_job SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
  assert.equal(await new AiWorker(f.pool, f.key, okTransport("新输出", 5, 5)).runOnce(), true);
  const finished = await row(id);
  assert.equal(finished.status, "done");
  assert.equal(finished.attempts, 2);
  stale.release({ output: { title: "旧输出" }, tokensIn: 7, tokensOut: 1, model: "stale" });
  await first;
  const after = await row(id);
  assert.equal(after.status, "done");
  assert.deepEqual(after.output, { title: "新输出" });
  assert.equal(after.provider_model, "m-新输出");
  assert.equal(String(after.completed_at), String(finished.completed_at));
  // Both provider calls were charged, so both count.
  assert.equal(after.tokens_in, 12);
  assert.equal(after.tokens_out, 6);

  // A stale failure cannot push a finished job back to pending or failed.
  const other = await create();
  const failing = blocking();
  const run = new AiWorker(f.pool, f.key, failing.transport).runOnce();
  await failing.called;
  await f.pool.query("UPDATE ai_job SET lease_until=now()-interval '1 second' WHERE id=$1", [other]);
  assert.equal(await new AiWorker(f.pool, f.key, okTransport("ok")).runOnce(), true);
  failing.release(new Error("provider_timeout"));
  await run;
  const done = await row(other);
  assert.equal(done.status, "done");
  assert.equal(done.error_code, null);
  assert.deepEqual(done.output, { title: "ok" });
});

test("P7 AI retry creates one linked job per failed or cancelled original", async () => {
  const failed = await insert("failed", 10);
  const original = await row(failed);
  await assert.rejects(f.app.ai.retry(f.viewer, failed, { site: "atlas" }), { status: 403 });
  const response = await f.app.ai.retry(f.editor, failed, { site: "atlas" });
  assert.equal(response.status, "pending");
  assert.equal(response.retry_of, failed);
  const retried = await row(response.id);
  assert.equal(retried.kind, "translate");
  assert.deepEqual(retried.payload, original.payload);
  assert.equal(retried.actor_id, f.editor.id);
  assert.equal(retried.retry_of, failed);
  assert.equal(retried.tokens_in, 0);
  assert.equal(retried.attempts, 0);
  assert.deepEqual(await row(failed), original);
  const listed = (await list("site=atlas")).items;
  assert.equal(listed[0].retryOf, failed);
  assert.equal(listed[1].retriedBy, response.id);
  // A second retry of the same original is rejected.
  assert.equal((await post(`/ai/jobs/${failed}/retry`, { site: "atlas" })).status, 409);
  // Only failed/cancelled jobs can be retried.
  for (const status of ["pending", "processing", "done"] as Status[]) {
    const other = await insert(status, 3);
    assert.equal((await post(`/ai/jobs/${other}/retry`, { site: "atlas" })).status, 409, status);
  }
  // Cancelled jobs can be retried over HTTP; the retry itself can be retried later.
  const cancelled = await create();
  await f.app.ai.cancel(f.editor, cancelled, { site: "atlas" });
  const http = await post(`/ai/jobs/${cancelled}/retry`, { site: "atlas" });
  assert.equal(http.status, 201);
  const created = await http.json();
  assert.equal(created.retry_of, cancelled);
  assert.equal((await row(created.id)).actor_id, f.admin.id);
  assert.equal((await post(`/ai/jobs/${(await insert("failed", 1, "notes"))}/retry`, { site: "atlas" })).status, 404);
  assert.deepEqual(
    (await audits()).filter((a) => a.action === "ai.job.retry"),
    [
      { action: "ai.job.retry", actor_id: f.editor.id, site_id: "atlas", detail: { jobId: response.id, retryOf: failed } },
      { action: "ai.job.retry", actor_id: f.admin.id, site_id: "atlas", detail: { jobId: created.id, retryOf: cancelled } },
    ],
  );
});

test("P7 AI concurrent retries of the same job create exactly one", async () => {
  const failed = await insert("failed", 10);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => post(`/ai/jobs/${failed}/retry`, { site: "atlas" })),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
  const count = (
    await f.pool.query("SELECT count(*)::int AS n FROM ai_job WHERE retry_of=$1", [failed])
  ).rows[0].n;
  assert.equal(count, 1);
  assert.equal((await audits()).length, 1);
});

test("P7 AI retry applies the enabled and budget checks", async () => {
  const failed = await insert("failed", 10);
  await configure(false);
  const disabled = await post(`/ai/jobs/${failed}/retry`, { site: "atlas" });
  assert.equal(disabled.status, 409);
  assert.match((await disabled.json()).error, /未启用/);
  await configure(true, 1000);
  await f.pool.query(
    "INSERT INTO ai_job(site_id,kind,payload,status,tokens_in,tokens_out) VALUES('atlas','generate','{}','done',600,400)",
  );
  const over = await post(`/ai/jobs/${failed}/retry`, { site: "atlas" });
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /预算/);
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM ai_job WHERE retry_of IS NOT NULL")).rows[0].n,
    0,
  );
  assert.deepEqual(await audits(), []);
  await configure(true, 2000);
  assert.equal((await post(`/ai/jobs/${failed}/retry`, { site: "atlas" })).status, 201);
});

test("P7 AI settings page task panel cancels, retries, filters and pages", async () => {
  for (let i = 0; i < 52; i++) await insert("done", 100 + i);
  const failed = await insert("failed", 20);
  const pending = await create();
  const session = await f.browse(f.editor, "#ai/atlas");
  try {
    const { page } = session;
    await page.waitForSelector(`#ai-job-list tr[data-id="${pending}"] .cancel-ai-job`);
    // Config and usage panels still render.
    assert.ok(await page.isVisible("#save-ai"));
    assert.ok(await page.isVisible("#ai-usage-months"));
    assert.equal(await page.locator("#ai-job-list tbody tr").count(), 50);
    assert.equal(await page.isDisabled("#ai-jobs-prev"), true);
    assert.equal(await page.isDisabled("#ai-jobs-next"), false);
    // Clicking disables every control in the panel until the request finishes.
    const disabled = await page.evaluate((id) => {
      (document.querySelector(`#ai-job-list tr[data-id="${id}"] .cancel-ai-job`) as HTMLButtonElement).click();
      return [...document.querySelectorAll("#ai-jobs button, #ai-jobs select")].every(
        (el) => (el as HTMLButtonElement).disabled,
      );
    }, pending);
    assert.equal(disabled, true);
    await page.waitForSelector(`#ai-job-list tr[data-id="${pending}"][data-status="cancelled"] .retry-ai-job`);
    assert.match((await page.textContent("#message")) ?? "", /已取消/);
    assert.equal((await row(pending)).status, "cancelled");
    assert.match(
      (await page.textContent(`#ai-job-list tr[data-id="${pending}"]`)) ?? "",
      /操作员取消/,
    );

    await page.click(`#ai-job-list tr[data-id="${failed}"] .retry-ai-job`);
    await page.waitForSelector(`#ai-job-list tr[data-id="${failed}"] >> text=已重试`);
    const retry = (
      await f.pool.query("SELECT id,actor_id FROM ai_job WHERE retry_of=$1", [failed])
    ).rows;
    assert.equal(retry.length, 1);
    assert.equal(retry[0].actor_id, f.editor.id);
    const top = page.locator("#ai-job-list tbody tr").first();
    assert.equal(await top.getAttribute("data-id"), retry[0].id);
    assert.match((await top.textContent()) ?? "", /排队中/);
    assert.match((await top.textContent()) ?? "", /重试自/);
    assert.match((await top.textContent()) ?? "", /editor@example\.test/);

    // A failing action reports the error and keeps the panel usable.
    await f.pool.query("UPDATE ai_job SET status='done' WHERE id=$1", [retry[0].id]);
    await page.click(`#ai-job-list tr[data-id="${retry[0].id}"] .cancel-ai-job`);
    await page.waitForSelector("#message.error");
    assert.match((await page.textContent("#message")) ?? "", /只有排队中或处理中/);
    assert.equal(await page.isDisabled("#refresh-ai-jobs"), false);

    await page.selectOption("#ai-job-status", "failed");
    await page.waitForFunction(
      () => document.querySelectorAll("#ai-job-list tbody tr").length === 1,
    );
    assert.equal(
      await page.getAttribute("#ai-job-list tbody tr", "data-id"),
      failed,
    );
    await page.selectOption("#ai-job-status", "");
    await page.waitForFunction(
      () => document.querySelectorAll("#ai-job-list tbody tr").length === 50,
    );
    await page.click("#ai-jobs-next");
    await page.waitForFunction(() => document.querySelector("#ai-jobs-page")?.textContent === "第 2 页");
    assert.equal(await page.locator("#ai-job-list tbody tr").count(), 5);
    assert.equal(await page.isDisabled("#ai-jobs-next"), true);
    assert.equal(await page.isDisabled("#ai-jobs-prev"), false);
    await page.click("#ai-jobs-prev");
    await page.waitForFunction(() => document.querySelector("#ai-jobs-page")?.textContent === "第 1 页");
  } finally {
    await session.close();
  }
  // A read-only viewer sees the list without actions; the server still rejects them.
  const reader = await f.browse(f.viewer, "#ai/atlas");
  try {
    const { page } = reader;
    await page.waitForSelector(`#ai-job-list tr[data-id="${failed}"]`);
    await page.selectOption("#ai-job-status", "cancelled");
    await page.waitForSelector(`#ai-job-list tr[data-id="${pending}"][data-status="cancelled"]`);
    assert.equal(await page.locator("#ai-job-list .retry-ai-job, #ai-job-list .cancel-ai-job").count(), 0);
    assert.match((await page.textContent("#access-note")) ?? "", /只读/);
    await assert.rejects(
      f.app.ai.retry(f.viewer, pending, { site: "atlas" }),
      (error: { status?: number }) => error.status === 403,
    );
  } finally {
    await reader.close();
  }
});
