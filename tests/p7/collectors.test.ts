import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, type Fixture } from "../p6/helpers.js";
import { CollectorWorker } from "../../src/server/collectors.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
beforeEach(async () => {
  await f.pool.query(
    "DELETE FROM content_draft; DELETE FROM collector_candidate; DELETE FROM collector_task; DELETE FROM collector_source; DELETE FROM site_limit",
  );
});
let feedCounter = 0;
const create = (site: string, url = `https://feed${++feedCounter}.example.test/rss`) =>
  f.app.collectors.save(f.admin, {
    siteId: site,
    kind: "rss",
    config: { url, locale: "zh" },
    enabled: true,
    intervalSeconds: 3600,
    expectedVersion: 0,
  });
const limit = (site: string, collectorRunsPerHour: number | null) =>
  f.app.limits.save(f.admin, { site, collectorRunsPerHour });
// Inserts a finished task; old tasks do not count toward the hourly run limit.
const seedTask = async (
  sourceId: string,
  status: "pending" | "processing" | "done" | "failed" | "cancelled",
  minutesAgo = 120,
) =>
  (
    await f.pool.query(
      `INSERT INTO collector_task(source_id,source_version,status,attempts,error_code,completed_at,created_at)
       SELECT id,version,$2,CASE WHEN $2='failed' THEN 5 ELSE 1 END,CASE WHEN $2='failed' THEN 'fetch_failed' END,
         CASE WHEN $2 IN ('done','failed','cancelled') THEN now()-$3::int*interval '1 minute' END,now()-$3::int*interval '1 minute'
       FROM collector_source WHERE id=$1 RETURNING id`,
      [sourceId, status, minutesAgo],
    )
  ).rows[0].id as string;
const rss = (ids: string[]) =>
  `<?xml version="1.0"?><rss><channel><title>Feed</title>${ids
    .map(
      (id) =>
        `<item><guid>${id}</guid><title>Item ${id}</title><link>https://example.com/${id}</link><description>About ${id}</description></item>`,
    )
    .join("")}</channel></rss>`;
// Runs one real collection so candidates go through the normal pipeline.
const collect = async (sourceId: string, ids: string[]) => {
  await f.app.collectors.enqueue(f.admin, sourceId, randomUUID());
  const worker = new CollectorWorker(f.pool, async () => ({
    notModified: false,
    text: rss(ids),
    etag: null,
  }));
  assert.equal(await worker.runOnce(), "done");
  return (
    await f.pool.query(
      "SELECT id,external_id,version FROM collector_candidate WHERE source_id=$1 ORDER BY external_id",
      [sourceId],
    )
  ).rows as { id: string; external_id: string; version: number }[];
};
const status = (error: unknown) => (error as { status?: number }).status;
const json = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});
const retry = (taskId: string, body: unknown) =>
  f.api(`/collectors/tasks/${taskId}/retry`, { method: "POST", body });

test("P7 collector task list pages, filters and checks permissions", async () => {
  const rssSource = await create("atlas");
  const npmSource = await f.app.collectors.save(f.admin, {
    siteId: "atlas",
    kind: "npm",
    config: { query: "react" },
    expectedVersion: 0,
  });
  // 60 tasks, one per minute, every fifth failed; newest is index 0.
  const ids: string[] = [];
  for (let i = 0; i < 60; i++)
    ids.push(
      await seedTask(
        i % 2 ? npmSource.id : rssSource.id,
        i % 5 === 0 ? "failed" : "done",
        i + 1,
      ),
    );
  const first = await json(await f.api("/collectors/tasks?site=atlas"));
  assert.equal(first.status, 200);
  assert.equal(first.body.page, 1);
  assert.equal(first.body.items.length, 50);
  assert.equal(first.body.hasMore, true);
  assert.deepEqual(
    first.body.items.map((item: { id: string }) => item.id),
    ids.slice(0, 50),
  );
  const item = first.body.items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    "attempts",
    "completedAt",
    "createdAt",
    "error",
    "id",
    "kind",
    "result",
    "retryOf",
    "source",
    "sourceId",
    "status",
  ]);
  assert.equal(item.source, rssSource.config.url);
  assert.equal(item.status, "failed");
  assert.equal(item.error, "fetch_failed");
  assert.equal(first.body.items[1].source, "npm: react");
  const second = await json(await f.api("/collectors/tasks?site=atlas&page=2"));
  assert.equal(second.body.items.length, 10);
  assert.equal(second.body.hasMore, false);
  assert.deepEqual(
    second.body.items.map((item: { id: string }) => item.id),
    ids.slice(50),
  );
  const failed = await json(await f.api("/collectors/tasks?site=atlas&status=failed"));
  assert.equal(failed.body.items.length, 12);
  assert.ok(failed.body.items.every((item: { status: string }) => item.status === "failed"));
  assert.equal(failed.body.hasMore, false);
  const empty = await json(await f.api("/collectors/tasks?site=atlas&status=pending"));
  assert.deepEqual(empty.body, { items: [], page: 1, hasMore: false });
  // Other sites' tasks are not listed.
  await seedTask((await create("notes")).id, "failed");
  assert.equal(
    (await json(await f.api("/collectors/tasks?site=atlas&status=failed"))).body.items.length,
    12,
  );
  for (const query of ["status=bogus", "page=0", "page=10001", "page=x"])
    assert.equal(
      (await f.api(`/collectors/tasks?site=atlas&${query}`)).status,
      400,
      query,
    );
  assert.equal((await f.api("/collectors/tasks")).status, 400);
  // The literal route does not shadow the source detail route.
  assert.equal(
    (await json(await f.api(`/collectors/${rssSource.id}`))).body.source.id,
    rssSource.id,
  );
  // Viewer can read the list but not retry; no access to sites without a grant.
  const viewed = await f.app.collectors.tasks(f.viewer, { site: "atlas", page: "2" });
  assert.equal(viewed.items.length, 10);
  await assert.rejects(f.app.collectors.tasks(f.viewer, { site: "notes" }), (e) => status(e) === 403);
  await assert.rejects(f.app.collectors.tasks(f.editor, { site: "notes" }), (e) => status(e) === 403);
  await assert.rejects(
    f.app.collectors.retry(f.viewer, ids[0]!, { site: "atlas", operationId: randomUUID() }),
    (e) => status(e) === 403,
  );
  await assert.rejects(
    f.app.collectors.batchReview(f.viewer, {
      site: "atlas",
      decision: "reject",
      items: [{ id: randomUUID(), expectedVersion: 1 }],
    }),
    (e) => status(e) === 403,
  );
});

test("P7 retrying a failed collector task creates a linked pending task", async () => {
  const source = await create("atlas");
  const failed = await seedTask(source.id, "failed");
  const done = await seedTask(source.id, "done");
  const cancelled = await seedTask(source.id, "cancelled");
  for (const id of [done, cancelled]) {
    const response = await json(await retry(id, { site: "atlas", operationId: randomUUID() }));
    assert.equal(response.status, 409);
  }
  assert.match(
    (await json(await retry(cancelled, { site: "atlas", operationId: randomUUID() }))).body.error,
    /来源配置改变/,
  );
  // Task from another site is not found under this site.
  assert.equal((await retry(failed, { site: "notes", operationId: randomUUID() })).status, 404);
  assert.equal((await retry(randomUUID(), { site: "atlas", operationId: randomUUID() })).status, 404);
  const operationId = randomUUID();
  const first = await json(await retry(failed, { site: "atlas", operationId }));
  assert.equal(first.status, 202);
  assert.equal(first.body.id, operationId);
  assert.equal(first.body.status, "pending");
  assert.equal(first.body.retry_of, failed);
  assert.equal(first.body.source_version, source.version);
  // Original task is unchanged.
  const original = (
    await f.pool.query("SELECT status,attempts,error_code FROM collector_task WHERE id=$1", [failed])
  ).rows[0];
  assert.deepEqual(original, { status: "failed", attempts: 5, error_code: "fetch_failed" });
  const audit = (
    await f.pool.query(
      "SELECT site_id,detail FROM audit_event WHERE action='collector.task.retry' ORDER BY id DESC LIMIT 1",
    )
  ).rows[0];
  assert.deepEqual(audit, { site_id: "atlas", detail: { taskId: operationId, retryOf: failed } });
  // Replay returns the same task even though it is now the open task.
  const replay = await json(await retry(failed, { site: "atlas", operationId }));
  assert.equal(replay.status, 202);
  assert.equal(replay.body.id, operationId);
  // A new operation is blocked while the source has an open task.
  const blocked = await json(await retry(failed, { site: "atlas", operationId: randomUUID() }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /排队或处理中/);
  // Operation ids cannot be reused across different operations.
  const other = await seedTask(source.id, "failed");
  assert.equal((await retry(other, { site: "atlas", operationId })).status, 409);
  const sync = await f.api(`/collectors/${source.id}/sync`, {
    method: "POST",
    body: { operationId },
  });
  assert.equal(sync.status, 202);
  assert.equal((await sync.json()).id, operationId);
  // The list exposes the link.
  const listed = (await json(await f.api("/collectors/tasks?site=atlas&status=pending"))).body
    .items;
  assert.deepEqual(
    listed.map((item: { id: string; retryOf: string }) => [item.id, item.retryOf]),
    [[operationId, failed]],
  );
  // Retry is an outbound sync, so like manual sync it is global-operator only.
  await f.pool.query("UPDATE collector_task SET status='done',completed_at=now() WHERE id=$1", [
    operationId,
  ]);
  await assert.rejects(
    f.app.collectors.retry(f.editor, failed, { site: "atlas", operationId: randomUUID() }),
    (e) => status(e) === 403,
  );
  const notesFailed = await seedTask((await create("notes")).id, "failed");
  await assert.rejects(
    f.app.collectors.retry(f.editor, notesFailed, { site: "notes", operationId: randomUUID() }),
    (e) => status(e) === 403,
  );
  assert.equal(
    (await retry(failed, { site: "atlas", operationId: "not-a-uuid" })).status,
    400,
  );
  assert.equal((await retry(failed, { operationId: randomUUID() })).status, 400);
});

test("P7 collector retry shares the manual rate limit and rejects disabled sources", async () => {
  const source = await create("atlas");
  const failed = await seedTask(source.id, "failed");
  await limit("atlas", 1);
  // One recent finished task uses the whole allowance.
  await seedTask(source.id, "done", 5);
  const limited = await json(await retry(failed, { site: "atlas", operationId: randomUUID() }));
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /每小时 1 次的上限/);
  await limit("atlas", 0);
  const stopped = await json(await retry(failed, { site: "atlas", operationId: randomUUID() }));
  assert.equal(stopped.status, 429);
  assert.match(stopped.body.error, /已停用采集/);
  await limit("atlas", null);
  // Disabled source: 409, and nothing is created.
  const disabled = await f.app.collectors.save(f.admin, {
    id: source.id,
    siteId: "atlas",
    kind: "rss",
    config: source.config,
    enabled: false,
    intervalSeconds: 3600,
    expectedVersion: source.version,
  });
  const off = await json(await retry(failed, { site: "atlas", operationId: randomUUID() }));
  assert.equal(off.status, 409);
  assert.match(off.body.error, /来源已停用/);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM collector_task WHERE retry_of IS NOT NULL",
      )
    ).rows[0].n,
    0,
  );
  // A retried task counts toward the limit like a manual sync.
  await f.app.collectors.save(f.admin, {
    id: source.id,
    siteId: "atlas",
    kind: "rss",
    config: source.config,
    enabled: true,
    intervalSeconds: 3600,
    expectedVersion: disabled.version,
  });
  await f.pool.query("DELETE FROM collector_task WHERE created_at>now()-interval '1 hour'");
  await limit("atlas", 1);
  await f.app.collectors.retry(f.admin, failed, { site: "atlas", operationId: randomUUID() });
  await assert.rejects(
    f.app.collectors.enqueue(f.admin, source.id, randomUUID()),
    (e) => status(e) === 429,
  );
});

test("P7 concurrent retries of one failed task create exactly one task", async () => {
  const source = await create("atlas");
  const failed = await seedTask(source.id, "failed");
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      f.app.collectors.retry(f.admin, failed, { site: "atlas", operationId: randomUUID() }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const result of results)
    if (result.status === "rejected") assert.equal(status(result.reason), 409);
  assert.equal(
    (
      await f.pool.query("SELECT count(*)::int AS n FROM collector_task WHERE retry_of=$1", [
        failed,
      ])
    ).rows[0].n,
    1,
  );
});

test("P7 source edit with a stale version conflicts", async () => {
  const source = await create("atlas");
  const edit = (expectedVersion: number, url: string) =>
    f.api("/collectors", {
      method: "POST",
      body: {
        id: source.id,
        siteId: "atlas",
        kind: "rss",
        config: { url, locale: "en" },
        enabled: false,
        intervalSeconds: 7200,
        expectedVersion,
      },
    });
  const ok = await json(await edit(source.version, "https://edited.example.test/rss"));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.version, source.version + 1);
  assert.equal(ok.body.interval_seconds, 7200);
  assert.equal(ok.body.enabled, false);
  const stale = await json(await edit(source.version, "https://stale.example.test/rss"));
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /版本已改变/);
  const row = (
    await f.pool.query("SELECT config,version FROM collector_source WHERE id=$1", [source.id])
  ).rows[0];
  assert.deepEqual(row, {
    config: { url: "https://edited.example.test/rss", locale: "en" },
    version: source.version + 1,
  });
});

test("P7 batch review reports per-item results and only drafts accepted items", async () => {
  const source = await create("atlas");
  const rows = await collect(source.id, ["a", "b", "c", "d", "e"]);
  const [a, b, c, d, e] = rows as [
    (typeof rows)[0],
    (typeof rows)[0],
    (typeof rows)[0],
    (typeof rows)[0],
    (typeof rows)[0],
  ];
  // d is already reviewed.
  await f.app.collectors.review(f.admin, "atlas", d.id, {
    decision: "reject",
    expectedVersion: d.version,
  });
  const missing = randomUUID();
  const accepted = await json(
    await f.api("/collector-candidates/batch-review", {
      method: "POST",
      body: {
        site: "atlas",
        decision: "accept",
        items: [
          { id: a.id, expectedVersion: a.version },
          { id: b.id, expectedVersion: b.version + 1 },
          { id: c.id, expectedVersion: c.version },
          { id: d.id, expectedVersion: d.version + 1 },
          { id: missing, expectedVersion: 1 },
        ],
      },
    }),
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.accepted, 2);
  assert.equal(accepted.body.rejected, 0);
  assert.equal(accepted.body.failed, 3);
  const byId = new Map(
    accepted.body.results.map((r: { id: string }) => [r.id, r] as const),
  );
  assert.deepEqual(
    accepted.body.results.map((r: { id: string }) => r.id),
    [a.id, b.id, c.id, d.id, missing],
  );
  for (const ok of [a, c]) {
    const result = byId.get(ok.id) as { ok: boolean; resourceId: string };
    assert.equal(result.ok, true);
    assert.match(result.resourceId, /^collector-/);
  }
  for (const [id, code] of [
    [b.id, 409],
    [d.id, 409],
    [missing, 404],
  ] as const) {
    const result = byId.get(id) as { ok: boolean; status: number; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.status, code);
    assert.ok(result.error);
  }
  const drafts = (
    await f.pool.query("SELECT resource_id FROM content_draft WHERE site_id='atlas' ORDER BY 1")
  ).rows.map((row) => row.resource_id);
  assert.deepEqual(
    drafts,
    [a, c]
      .map((row) => (byId.get(row.id) as { resourceId: string }).resourceId)
      .sort(),
  );
  const statuses = async () =>
    Object.fromEntries(
      (
        await f.pool.query(
          "SELECT external_id,status FROM collector_candidate WHERE source_id=$1",
          [source.id],
        )
      ).rows.map((row) => [row.external_id, row.status]),
    );
  assert.deepEqual(await statuses(), {
    a: "accepted",
    b: "pending",
    c: "accepted",
    d: "rejected",
    e: "pending",
  });
  // Batch reject: valid, already accepted and stale.
  const rejected = await f.app.collectors.batchReview(f.editor, {
    site: "atlas",
    decision: "reject",
    items: [
      { id: b.id, expectedVersion: b.version },
      { id: a.id, expectedVersion: a.version },
      { id: e.id, expectedVersion: e.version + 5 },
    ],
  });
  assert.deepEqual(
    { accepted: rejected.accepted, rejected: rejected.rejected, failed: rejected.failed },
    { accepted: 0, rejected: 1, failed: 2 },
  );
  assert.deepEqual(rejected.results[0], { id: b.id, ok: true, resourceId: null });
  assert.equal((rejected.results[1] as { status: number }).status, 409);
  assert.deepEqual(await statuses(), {
    a: "accepted",
    b: "rejected",
    c: "accepted",
    d: "rejected",
    e: "pending",
  });
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM content_draft")).rows[0].n,
    2,
  );
  // Validation and permissions apply to the whole request.
  const items = (n: number) =>
    Array.from({ length: n }, () => ({ id: randomUUID(), expectedVersion: 1 }));
  const batch = (body: unknown) =>
    f.api("/collector-candidates/batch-review", { method: "POST", body });
  assert.equal((await batch({ site: "atlas", decision: "reject", items: items(101) })).status, 400);
  assert.equal((await batch({ site: "atlas", decision: "reject", items: [] })).status, 400);
  assert.equal(
    (
      await batch({
        site: "atlas",
        decision: "reject",
        items: [
          { id: e.id, expectedVersion: e.version },
          { id: e.id, expectedVersion: e.version },
        ],
      })
    ).status,
    400,
  );
  assert.equal((await batch({ site: "atlas", decision: "maybe", items: items(1) })).status, 400);
  const hundred = await json(
    await batch({ site: "atlas", decision: "reject", items: items(100) }),
  );
  assert.equal(hundred.status, 200);
  assert.equal(hundred.body.failed, 100);
  await assert.rejects(
    f.app.collectors.batchReview(f.viewer, {
      site: "atlas",
      decision: "accept",
      items: [{ id: e.id, expectedVersion: e.version }],
    }),
    (error) => status(error) === 403,
  );
  await assert.rejects(
    f.app.collectors.batchReview(f.editor, {
      site: "notes",
      decision: "reject",
      items: [{ id: e.id, expectedVersion: e.version }],
    }),
    (error) => status(error) === 403,
  );
  assert.equal((await statuses()).e, "pending");
});

test("P7 collector console edits sources, retries tasks and batch reviews", async () => {
  const source = await create("atlas");
  const rows = await collect(source.id, ["x1", "x2", "x3"]);
  const failed = await seedTask(source.id, "failed");
  // Source save/sync are global-admin only (pre-existing M5 rule), so the console runs as admin.
  const session = await f.browse(f.admin, "#collectors/atlas");
  const message = (text: string) =>
    session.page.waitForFunction(
      (expected) => document.querySelector("#message")?.textContent?.includes(expected),
      text,
    );
  try {
    const { page } = session;
    await page.waitForSelector("#collector-tasks");
    // Batch review: one candidate goes stale after the page loaded.
    await f.pool.query("UPDATE collector_candidate SET version=version+1 WHERE id=$1", [
      rows[1]!.id,
    ]);
    assert.equal(await page.isDisabled("#batch-accept"), true);
    await page.check("#select-all-candidates");
    assert.equal(await page.isDisabled("#batch-accept"), false);
    await page.click("#batch-accept");
    await page.waitForSelector("#collector-batch-result:not([hidden])");
    const summary = await page.textContent("#collector-batch-result");
    assert.match(summary!, /成功 2 条，失败 1 条/);
    assert.match(summary!, /Item x2/);
    assert.match(summary!, /版本已改变/);
    assert.equal(
      (await f.pool.query("SELECT count(*)::int AS n FROM content_draft")).rows[0].n,
      2,
    );
    // Reloaded list only has the stale candidate left.
    assert.equal(await page.locator(".candidate-check").count(), 1);
    // Retry the failed task; the first attempt dies on the network, and the
    // second click resends the same operation id.
    const operations: string[] = [];
    await page.route("**/retry", async (route) => {
      operations.push(JSON.parse(route.request().postData()!).operationId);
      if (operations.length === 1) await route.abort("connectionreset");
      else await route.fallback();
    });
    await page.click(`.retry-task[data-id="${failed}"]`);
    await message("网络错误");
    await page.click(`.retry-task[data-id="${failed}"]`);
    await message("已重新排队");
    assert.equal(operations.length, 2);
    assert.equal(operations[0], operations[1]);
    const retried = (
      await f.pool.query("SELECT id,status FROM collector_task WHERE retry_of=$1", [failed])
    ).rows;
    assert.equal(retried.length, 1);
    assert.equal(retried[0].id, operations[0]);
    assert.equal(retried[0].status, "pending");
    await page.waitForSelector(`tr[data-task="${retried[0].id}"]`);
    // Status filter.
    await page.selectOption("#task-status", "failed");
    await page.waitForFunction(
      () => document.querySelectorAll("#collector-tasks tbody tr[data-task]").length === 1,
    );
    // Edit with a version conflict keeps the user's input.
    await page.click(`.edit-collector[data-id="${source.id}"]`);
    await page.fill("#edit-url", "https://mine.example.test/rss");
    await page.fill("#edit-interval", "2");
    await f.app.collectors.save(f.admin, {
      id: source.id,
      siteId: "atlas",
      kind: "rss",
      config: { url: "https://theirs.example.test/rss", locale: "zh" },
      enabled: true,
      intervalSeconds: 3600,
      expectedVersion: source.version,
    });
    await page.click("#save-edit");
    await message("版本冲突");
    assert.equal(await page.inputValue("#edit-url"), "https://mine.example.test/rss");
    assert.equal(await page.inputValue("#edit-interval"), "2");
    // Reload and edit again.
    await page.click("#refresh-collectors");
    await page.waitForSelector("#collector-edit[hidden]", { state: "attached" });
    await page.click(`.edit-collector[data-id="${source.id}"]`);
    assert.equal(await page.inputValue("#edit-url"), "https://theirs.example.test/rss");
    await page.fill("#edit-url", "https://mine.example.test/rss");
    await page.fill("#edit-interval", "2");
    await page.selectOption("#edit-locale", "en");
    await page.uncheck("#edit-enabled");
    await page.click("#save-edit");
    await message("来源已更新");
    const row = (
      await f.pool.query(
        "SELECT config,enabled,interval_seconds,version FROM collector_source WHERE id=$1",
        [source.id],
      )
    ).rows[0];
    assert.deepEqual(row, {
      config: { url: "https://mine.example.test/rss", locale: "en" },
      enabled: false,
      interval_seconds: 7200,
      version: source.version + 2,
    });
  } finally {
    await session.close();
  }
});
