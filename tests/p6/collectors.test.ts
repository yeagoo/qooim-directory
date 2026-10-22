import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, type Fixture } from "./helpers.js";
import {
  CollectorWorker,
  pruneCollectors,
} from "../../src/server/collectors.js";
import { runMaintenance } from "../../src/server/maintenance.js";
import { DEFAULT_RETENTION } from "../../src/server/retention.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
beforeEach(async () => {
  await f.pool.query(
    "DELETE FROM collector_candidate; DELETE FROM collector_task; DELETE FROM collector_source; DELETE FROM site_limit",
  );
});
const limit = (
  site: string,
  values: { collectorSources?: number | null; collectorRunsPerHour?: number | null },
) => f.app.limits.save(f.admin, { site, ...values });
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
const rss = (ids: string[]) =>
  `<?xml version="1.0"?><rss><channel><title>Feed</title>${ids
    .map(
      (id) =>
        `<item><guid>${id}</guid><title>Item ${id}</title><link>https://example.com/${id}</link><description>About ${id}</description></item>`,
    )
    .join("")}</channel></rss>`;
// Feeds keyed by URL so one worker can serve several sources.
const worker = (feeds: Record<string, string[]>) =>
  new CollectorWorker(f.pool, async (url: string) => ({
    notModified: false,
    text: rss(feeds[url] ?? []),
    etag: null,
  }));
const count = async (sql: string, params: unknown[] = []) =>
  (await f.pool.query(sql, params)).rows[0].n as number;

test("P6 collector source quota blocks creation, allows edits and holds under concurrency", async () => {
  await limit("atlas", { collectorSources: 2 });
  const first = await create("atlas");
  await create("atlas");
  await assert.rejects(create("atlas"), (error: { status?: number; message: string }) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /上限（2 个）/);
    return true;
  });
  const response = await f.api("/collectors", {
    method: "POST",
    body: {
      siteId: "atlas",
      kind: "npm",
      config: { query: "react" },
      expectedVersion: 0,
    },
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /采集来源已达上限/);
  // Lowering the limit below current usage still allows editing existing sources.
  await limit("atlas", { collectorSources: 1 });
  const edited = await f.app.collectors.save(f.admin, {
    id: first.id,
    siteId: "atlas",
    kind: "rss",
    config: { url: "https://edited.example.test/rss", locale: "en" },
    enabled: false,
    intervalSeconds: 7200,
    expectedVersion: first.version,
  });
  assert.equal(edited.version, first.version + 1);
  await assert.rejects(create("atlas"), { status: 409 });
  await limit("atlas", { collectorSources: 0 });
  await assert.rejects(create("atlas"), /配额为 0/);
  const usage = await (await f.api("/collectors/usage?site=atlas")).json();
  assert.deepEqual(
    { sources: usage.sources, sourceLimit: usage.sourceLimit },
    { sources: 2, sourceLimit: 0 },
  );
  // Other sites keep their own (default) quota.
  await create("notes");
  // Concurrent creations at the boundary admit exactly the allowed number.
  await limit("notes", { collectorSources: 4 });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => create("notes")),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  for (const result of results)
    if (result.status === "rejected")
      assert.equal((result.reason as { status?: number }).status, 409);
  assert.equal(
    await count("SELECT count(*)::int AS n FROM collector_source WHERE site_id='notes'"),
    4,
  );
});

test("P6 manual collection is rate limited per site with idempotent replay", async () => {
  await limit("atlas", { collectorRunsPerHour: 2 });
  const a = await create("atlas"),
    b = await create("atlas");
  const op1 = randomUUID();
  const task1 = await f.app.collectors.enqueue(f.admin, a.id, op1);
  await f.app.collectors.enqueue(f.admin, b.id, randomUUID());
  // The allowance is shared by every source of the site.
  await assert.rejects(
    f.app.collectors.enqueue(f.admin, a.id, randomUUID()),
    (error: { status?: number; message: string }) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /每小时 2 次/);
      return true;
    },
  );
  const response = await f.api(`/collectors/${b.id}/sync`, {
    method: "POST",
    body: { operationId: randomUUID() },
  });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /上限/);
  // Replaying an operation id returns the existing task even at the limit.
  const replay = await f.api(`/collectors/${a.id}/sync`, {
    method: "POST",
    body: { operationId: op1 },
  });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).id, task1.id);
  // Another site is unaffected.
  const other = await create("notes");
  await f.app.collectors.enqueue(f.admin, other.id, randomUUID());
  // Tasks older than an hour no longer count.
  await f.pool.query(
    "UPDATE collector_task SET created_at=now()-interval '61 minutes' WHERE id=$1",
    [task1.id],
  );
  await f.app.collectors.enqueue(f.admin, a.id, randomUUID());
  assert.equal(
    (await (await f.api("/collectors/usage?site=atlas")).json()).runsLastHour,
    2,
  );
  // Limit 0 disables collection for the site but keeps replay working.
  await limit("atlas", { collectorRunsPerHour: 0 });
  await assert.rejects(
    f.app.collectors.enqueue(f.admin, b.id, randomUUID()),
    (error: { status?: number; message: string }) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /已停用采集/);
      return true;
    },
  );
  assert.equal((await f.app.collectors.enqueue(f.admin, a.id, op1)).id, task1.id);
  // Concurrent manual enqueues never exceed the allowance.
  await f.pool.query("DELETE FROM collector_task");
  await limit("atlas", { collectorRunsPerHour: 3 });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      f.app.collectors.enqueue(f.admin, i % 2 ? a.id : b.id, randomUUID()),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM collector_task t JOIN collector_source s ON s.id=t.source_id WHERE s.site_id='atlas'",
    ),
    3,
  );
});

test("P6 scheduler enqueues only the remaining hourly allowance and defers the rest", async () => {
  await limit("atlas", { collectorRunsPerHour: 2 });
  const atlas: { id: string }[] = [];
  for (let i = 0; i < 4; i++) atlas.push(await create("atlas"));
  const notes = [];
  for (let i = 0; i < 3; i++) notes.push(await create("notes"));
  // One manual run already used part of atlas's allowance.
  await f.app.collectors.enqueue(f.admin, atlas[0]!.id, randomUUID());
  await f.pool.query(
    "UPDATE collector_source SET next_run_at=now()-interval '1 minute' WHERE id<>$1",
    [atlas[0]!.id],
  );
  const scheduler = new CollectorWorker(f.pool);
  assert.deepEqual(await scheduler.schedule(), { queued: 4, deferred: 2 });
  // Deferred sources are no longer due, so the next tick does nothing.
  assert.deepEqual(await scheduler.schedule(), { queued: 0, deferred: 0 });
  const rows = (
    await f.pool.query(
      `SELECT s.id,s.site_id,extract(epoch FROM s.next_run_at-now())::int AS wait,
         (SELECT count(*)::int FROM collector_task t WHERE t.source_id=s.id) AS tasks
       FROM collector_source s`,
    )
  ).rows;
  const atlasRows = rows.filter((r) => r.site_id === "atlas" && r.id !== atlas[0]!.id);
  assert.equal(atlasRows.filter((r) => r.tasks === 1).length, 1);
  const deferred = atlasRows.filter((r) => r.tasks === 0);
  assert.equal(deferred.length, 2);
  for (const row of deferred) assert.ok(row.wait >= 14 * 60 && row.wait <= 15 * 60, String(row.wait));
  for (const row of atlasRows.filter((r) => r.tasks === 1))
    assert.ok(row.wait > 3500, String(row.wait));
  // The site with the default allowance is unaffected.
  for (const row of rows.filter((r) => r.site_id === "notes")) {
    assert.equal(row.tasks, 1);
    assert.ok(row.wait > 3500);
  }
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM collector_task t JOIN collector_source s ON s.id=t.source_id WHERE s.site_id='atlas' AND t.created_at>now()-interval '1 hour'",
    ),
    2,
  );
  // Limit 0 disables scheduled collection: due sources are only deferred.
  await limit("notes", { collectorRunsPerHour: 0 });
  await f.pool.query(
    "UPDATE collector_source SET next_run_at=now()-interval '1 minute' WHERE site_id='notes'",
  );
  assert.deepEqual(await scheduler.schedule(), { queued: 0, deferred: 3 });
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM collector_task t JOIN collector_source s ON s.id=t.source_id WHERE s.site_id='notes'",
    ),
    3,
  );
});

test("P6 collector retention deletes old tasks and superseded rows, compacts reviewed rows and preserves dedupe", async () => {
  const feedA = "https://a.example.test/rss",
    feedB = "https://b.example.test/rss";
  const feeds = { [feedA]: ["a", "b", "c", "d", "e", "f"], [feedB]: ["x", "y"] };
  const run = worker(feeds);
  const sourceA = await create("atlas", feedA);
  let sourceB = await create("atlas", feedB);
  await f.app.collectors.enqueue(f.admin, sourceA.id, randomUUID());
  assert.equal(await run.runOnce(), "done");
  await f.app.collectors.enqueue(f.admin, sourceB.id, randomUUID());
  assert.equal(await run.runOnce(), "done");
  const byId = async () =>
    Object.fromEntries(
      (
        await f.pool.query(
          "SELECT cc.*,cs.id AS source FROM collector_candidate cc JOIN collector_source cs ON cs.id=cc.source_id",
        )
      ).rows.map((row) => [row.external_id, row]),
    );
  let rows = await byId();
  const review = (external: string, decision: "accept" | "reject") =>
    f.app.collectors.review(f.admin, "atlas", rows[external].id, {
      decision,
      expectedVersion: rows[external].version,
    });
  await review("a", "reject");
  const accepted = await review("b", "accept");
  await review("c", "reject");
  // Editing a source supersedes its pending candidates.
  sourceB = await f.app.collectors.save(f.admin, {
    id: sourceB.id,
    siteId: "atlas",
    kind: "rss",
    config: { url: feedB, locale: "zh" },
    enabled: true,
    intervalSeconds: 7200,
    expectedVersion: sourceB.version,
  });
  rows = await byId();
  for (const key of ["a", "b", "c", "x", "y"]) assert.ok(rows[key].reviewed_at, key);
  for (const key of ["d", "e", "f"]) assert.equal(rows[key].reviewed_at, null);
  assert.equal(rows.x.status, "superseded");
  assert.equal(rows.b.accepted_resource_id, accepted.resourceId);
  const taskA = rows.a.task_id;
  // Age the history: task A beyond 30 days, a/b beyond 90, superseded beyond 30,
  // pending far beyond every window, c reviewed recently.
  await f.pool.query(
    "UPDATE collector_task SET completed_at=now()-interval '31 days' WHERE id=$1",
    [taskA],
  );
  await f.pool.query(
    "UPDATE collector_candidate SET reviewed_at=now()-interval '91 days' WHERE external_id IN ('a','b')",
  );
  await f.pool.query(
    "UPDATE collector_candidate SET reviewed_at=now()-interval '31 days' WHERE external_id IN ('x','y')",
  );
  await f.pool.query(
    "UPDATE collector_candidate SET created_at=now()-interval '400 days' WHERE status='pending'",
  );
  // Unfinished tasks are never pruned, however old (disabled source so no worker claims them).
  const idle = await create("atlas");
  await f.app.collectors.save(f.admin, {
    id: idle.id,
    siteId: "atlas",
    kind: "rss",
    config: idle.config,
    enabled: false,
    intervalSeconds: 3600,
    expectedVersion: idle.version,
  });
  await f.pool.query(
    `INSERT INTO collector_task(source_id,source_version,status,created_at,lease_until,lease_token)
     VALUES($1,2,'pending',now()-interval '400 days',NULL,NULL),
           ($1,2,'processing',now()-interval '400 days',now()+interval '1 minute',gen_random_uuid())`,
    [idle.id],
  );
  const pendingBefore = (
    await f.pool.query(
      "SELECT id,data,status,version,fingerprint FROM collector_candidate WHERE status='pending' ORDER BY id",
    )
  ).rows;
  assert.equal(pendingBefore.length, 3);
  const result = await pruneCollectors(f.pool, DEFAULT_RETENTION);
  assert.deepEqual(result, { deletedTasks: 1, deletedSuperseded: 2, compacted: 2 });
  assert.equal(
    await count("SELECT count(*)::int AS n FROM collector_task WHERE id=$1", [taskA]),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM collector_task WHERE source_id=$1 AND status IN ('pending','processing')",
      [idle.id],
    ),
    2,
  );
  rows = await byId();
  assert.equal(rows.x, undefined);
  assert.equal(rows.y, undefined);
  for (const key of ["a", "b", "c", "d", "e", "f"]) {
    assert.ok(rows[key], key);
    assert.equal(rows[key].task_id, null);
  }
  for (const key of ["a", "b"]) {
    assert.deepEqual(rows[key].data, {});
    assert.ok(rows[key].compacted_at);
    assert.ok(rows[key].fingerprint);
  }
  assert.equal(rows.a.status, "rejected");
  assert.equal(rows.b.status, "accepted");
  assert.equal(rows.b.accepted_resource_id, accepted.resourceId);
  assert.equal(rows.c.compacted_at, null);
  assert.notDeepEqual(rows.c.data, {});
  const pendingAfter = (
    await f.pool.query(
      "SELECT id,data,status,version,fingerprint FROM collector_candidate WHERE status='pending' ORDER BY id",
    )
  ).rows;
  assert.deepEqual(pendingAfter, pendingBefore);
  // Detail shows archived rows without their payload.
  const detail = await f.app.collectors.detail(f.admin, sourceA.id);
  const archived = detail.candidates.filter((c) => c.compacted_at);
  assert.equal(archived.length, 2);
  for (const row of archived) assert.deepEqual(row.data, {});
  // Dedupe survives compaction: the same feed proposes nothing new.
  await f.app.collectors.enqueue(f.admin, sourceA.id, randomUUID());
  assert.equal(await run.runOnce(), "done");
  rows = await byId();
  assert.equal(rows.a.status, "rejected");
  assert.equal(rows.b.status, "accepted");
  assert.deepEqual(rows.a.data, {});
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM collector_candidate WHERE source_id=$1",
      [sourceA.id],
    ),
    6,
  );
  assert.deepEqual(
    (
      await f.pool.query(
        "SELECT external_id FROM collector_candidate WHERE source_id=$1 AND status='pending' ORDER BY external_id",
        [sourceA.id],
      )
    ).rows.map((r) => r.external_id),
    ["d", "e", "f"],
  );
  // Deleted superseded items may be proposed again.
  await f.app.collectors.enqueue(f.admin, sourceB.id, randomUUID());
  assert.equal(await run.runOnce(), "done");
  rows = await byId();
  assert.equal(rows.x.status, "pending");
  assert.equal(rows.y.status, "pending");
  // Nothing left to prune.
  assert.deepEqual(await pruneCollectors(f.pool, DEFAULT_RETENTION), {
    deletedTasks: 0,
    deletedSuperseded: 0,
    compacted: 0,
  });
});

async function seed(rows: number, tasks: number, pendingEvery = 10) {
  // Old terminal tasks and candidates on one notes source.
  const source = await create("notes");
  await f.pool.query(
    `INSERT INTO collector_task(id,source_id,source_version,status,completed_at,created_at)
     SELECT md5($3||g)::uuid,$1,1,(ARRAY['done','failed','cancelled'])[1+g%3],now()-interval '60 days',now()-interval '60 days'
     FROM generate_series(1,$2::int) g`,
    [source.id, tasks, source.id],
  );
  // Per ten rows: 3 rejected, 3 accepted, 3 superseded, 1 pending; 50 candidates per task at 100k.
  await f.pool.query(
    `INSERT INTO collector_candidate(source_id,task_id,external_id,locale,data,fingerprint,status,accepted_resource_id,created_at,reviewed_at)
     SELECT $1,md5($5||(1+g%$3::int))::uuid,'item-'||g,'zh',
       jsonb_build_object('url','https://example.com/'||g,'kind','website','translations',jsonb_build_object('zh',jsonb_build_object('title','T'||g,'description','D'||g))),
       md5('fp'||g),st,CASE WHEN st='accepted' THEN 'collector-'||g END,now()-interval '200 days',
       CASE WHEN st='pending' THEN NULL ELSE now()-interval '100 days' END
     FROM (SELECT g,CASE WHEN g%$4::int=0 THEN 'pending' WHEN g%10<4 THEN 'rejected' WHEN g%10<7 THEN 'accepted' ELSE 'superseded' END AS st
           FROM generate_series(1,$2::int) g) s`,
    [source.id, rows, tasks, pendingEvery, source.id],
  );
  return source;
}

test("P6 collector pruning stops after maxBatches per category", async () => {
  // 20 rows: 12 accepted/rejected, 6 superseded, 2 pending; 10 tasks.
  await seed(20, 10);
  const policy = { ...DEFAULT_RETENTION, batchSize: 3, maxBatches: 2 };
  assert.deepEqual(await pruneCollectors(f.pool, policy), {
    deletedTasks: 6,
    deletedSuperseded: 6,
    compacted: 6,
  });
  assert.deepEqual(await pruneCollectors(f.pool, policy), {
    deletedTasks: 4,
    deletedSuperseded: 0,
    compacted: 6,
  });
  assert.deepEqual(await pruneCollectors(f.pool, policy), {
    deletedTasks: 0,
    deletedSuperseded: 0,
    compacted: 0,
  });
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM collector_candidate WHERE status='pending' AND compacted_at IS NULL AND data<>'{}'::jsonb",
    ),
    2,
  );
});

test("P6 collector pruning handles 100,000 candidates within budget", async (t) => {
  const started = Date.now();
  await seed(100000, 2000);
  await f.pool.query("ANALYZE collector_candidate; ANALYZE collector_task");
  const seeded = Date.now();
  const digest = async () =>
    (
      await f.pool.query(
        "SELECT count(*)::int AS n,md5(string_agg(id::text||data::text||status||version||fingerprint,',' ORDER BY id)) AS h FROM collector_candidate WHERE status='pending'",
      )
    ).rows[0];
  const before = await digest();
  assert.equal(before.n, 10000);
  const totals = { deletedTasks: 0, deletedSuperseded: 0, compacted: 0 };
  let calls = 0;
  for (;;) {
    const result = await pruneCollectors(f.pool, DEFAULT_RETENTION);
    calls++;
    for (const key of Object.keys(totals) as (keyof typeof totals)[])
      totals[key] += result[key]!;
    if (!result.deletedTasks && !result.deletedSuperseded && !result.compacted) break;
    assert.ok(calls < 10);
  }
  const pruneMs = Date.now() - seeded;
  t.diagnostic(`seed ${seeded - started} ms, prune ${pruneMs} ms in ${calls} calls`);
  assert.deepEqual(totals, {
    deletedTasks: 2000,
    deletedSuperseded: 30000,
    compacted: 60000,
  });
  assert.ok(Date.now() - started < 120000);
  assert.deepEqual(await digest(), before);
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM collector_candidate WHERE status IN ('accepted','rejected') AND compacted_at IS NOT NULL AND data='{}'::jsonb AND task_id IS NULL",
    ),
    60000,
  );
  assert.equal(
    await count(
      "SELECT count(*)::int AS n FROM collector_candidate WHERE status='accepted' AND accepted_resource_id IS NOT NULL",
    ),
    30000,
  );
});

test("P6 runMaintenance prunes collector history", async () => {
  await seed(10, 3);
  const result = await runMaintenance(f.pool, {
    policy: DEFAULT_RETENTION,
    force: true,
  });
  assert.deepEqual(result?.collectors, {
    deletedTasks: 3,
    deletedSuperseded: 3,
    compacted: 6,
  });
});

test("P6 collector console shows quota usage, archived candidates and limit errors", async () => {
  const source = await seed(10, 3);
  await pruneCollectors(f.pool, DEFAULT_RETENTION);
  await limit("notes", { collectorSources: 1, collectorRunsPerHour: 0 });
  const owner = await f.browse(f.admin, "#collectors/notes");
  try {
    const { page } = owner;
    await page.waitForSelector("#collector-usage");
    const usage = await page.textContent("#collector-usage");
    assert.match(usage!, /来源 1 \/ 1/);
    assert.match(usage!, /已停用采集/);
    assert.equal(await page.isDisabled("#save-collector"), true);
    await page.click(`.detail-collector[data-id="${source.id}"]`);
    await page.waitForSelector("#collector-history:not([hidden]) tbody tr");
    const history = await page.textContent("#collector-history");
    assert.match(history!, /已归档/);
    assert.match(history!, /item-1/);
    await page.click(`.sync-collector[data-id="${source.id}"]`);
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("已停用采集"),
    );
  } finally {
    await owner.close();
  }
});
