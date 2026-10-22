import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, type Fixture } from "../p6/helpers.js";
import { GithubClient } from "../../src/server/github-client.js";
import { GithubWorker } from "../../src/server/github.js";
import {
  CollectorWorker,
  pruneCollectors,
} from "../../src/server/collectors.js";
import { CollectorTaskWorker } from "../../src/server/collector-worker.js";
import {
  adapters,
  discoveryKinds,
  sourceLabel,
} from "../../src/server/collector-adapters.js";
import { DEFAULT_RETENTION } from "../../src/server/retention.js";

let f: Fixture;
let mode: "ok" | "missing" = "ok";
let stars = 10;
let calls = 0;
const client = new GithubClient(async (input) => {
  calls++;
  const name = new URL(String(input)).pathname.slice("/repos/".length);
  if (mode === "missing") return new Response(null, { status: 404 });
  return new Response(
    JSON.stringify({
      id: 77,
      full_name: name,
      private: false,
      description: "Fixture repository",
      stargazers_count: stars,
      forks_count: 1,
      open_issues_count: 0,
      language: "TypeScript",
      license: null,
      topics: [],
      archived: false,
      pushed_at: null,
    }),
    { headers: { "content-type": "application/json", etag: '"fixture"' } },
  );
}, "");
const rssXml = `<?xml version="1.0"?><rss><channel><title>Feed</title><item><guid>one</guid><title>One</title><link>https://example.com/one</link></item></channel></rss>`;
const rssFetcher = async () => ({ notModified: false, text: rssXml, etag: null });

before(async () => {
  f = await setup();
  await f.pool.query(
    "UPDATE site SET modules=ARRAY['directory','opensource'] WHERE id='atlas'; UPDATE site SET modules=ARRAY['directory'] WHERE id='notes'",
  );
});
after(async () => {
  await f?.close();
});
beforeEach(async () => {
  mode = "ok";
  stars = 10;
  await f.pool.query(
    "DELETE FROM github_request; DELETE FROM github_candidate; DELETE FROM collector_candidate; DELETE FROM collector_task; DELETE FROM collector_source; DELETE FROM site_limit; UPDATE github_budget SET next_at=now()-interval '1 second'",
  );
  await f.pool.query(
    "UPDATE site SET modules=ARRAY['directory','opensource'] WHERE id='atlas'",
  );
});
const limit = (
  site: string,
  values: { collectorSources?: number | null; collectorRunsPerHour?: number | null },
) => f.app.limits.save(f.admin, { site, ...values });
const github = (resourceId: string, site = "atlas", enabled = true) =>
  f.app.github.save(f.admin, {
    siteId: site,
    resourceId,
    repository: "acme/" + resourceId,
    enabled,
    expectedVersion: 0,
  });
let feeds = 0;
const rss = (site = "atlas") =>
  f.app.collectors.save(f.admin, {
    siteId: site,
    kind: "rss",
    config: { url: `https://feed${++feeds}.example.test/rss`, locale: "zh" },
    enabled: true,
    intervalSeconds: 3600,
    expectedVersion: 0,
  });
const status = (code: number, message?: RegExp) => (error: { status?: number; message: string }) => {
  assert.equal(error.status, code);
  if (message) assert.match(error.message, message);
  return true;
};
const budgetOpen = () =>
  f.pool.query("UPDATE github_budget SET next_at=now()-interval '1 second'");

test("P10 adapter registry describes discovery and binding review models", () => {
  assert.deepEqual(Object.keys(adapters), ["rss", "npm", "json", "github"]);
  assert.deepEqual(discoveryKinds, ["rss", "npm", "json"]);
  assert.deepEqual(
    Object.values(adapters).map((a) => [a.kind, a.mode, a.requiredModules]),
    [
      ["rss", "discovery", ["directory"]],
      ["npm", "discovery", ["directory"]],
      ["json", "discovery", ["directory"]],
      ["github", "binding", ["directory", "opensource"]],
    ],
  );
  assert.equal(sourceLabel("npm", { query: "react" }), "npm: react");
  assert.equal(sourceLabel("rss", { url: "https://a.test/rss" }), "https://a.test/rss");
  assert.equal(sourceLabel("github", { repository: "acme/tool" }), "acme/tool");
  assert.deepEqual(adapters.github.validateConfig({ repository: "Acme/Tool" }), {
    repository: "acme/tool",
  });
  assert.throws(() => adapters.github.validateConfig({ repository: "https://x.test/a" }));
  assert.throws(
    () => adapters.rss.validateConfig({ url: "https://127.0.0.1/feed" }),
    status(400),
  );
  assert.deepEqual(adapters.github.statsFields, ["stars", "forks", "openIssues", "pushedAt"]);
  assert.deepEqual(adapters.github.reviewFields, [
    "project",
    "url",
    "source",
    "translations.en.title",
    "translations.en.description",
  ]);
  // Statistics never change the binding content hash; reviewable fields do.
  const data = {
    kind: "repository" as const,
    url: "https://github.com/acme/tool",
    source: "https://api.github.com/repos/acme/tool",
    project: {
      provider: "github" as const,
      repoId: "1",
      fullName: "acme/tool",
      stars: 1,
      forks: 1,
      openIssues: 1,
      language: null,
      license: null,
      topics: [],
      archived: false,
      pushedAt: null,
    },
    translations: { en: { title: "acme/tool", description: "Tool" } },
  };
  const hash = adapters.github.contentHash(data);
  assert.equal(
    adapters.github.contentHash({ ...data, project: { ...data.project, stars: 99, pushedAt: "2026-10-01T00:00:00Z" } }),
    hash,
  );
  assert.notEqual(
    adapters.github.contentHash({ ...data, project: { ...data.project, archived: true } }),
    hash,
  );
});

test("P10 GitHub sources share the site source quota; edits are free and the generic editor rejects them", async () => {
  await limit("atlas", { collectorSources: 2 });
  await rss();
  const first = await github("quota-one");
  assert.equal(first.repository, "acme/quota-one");
  await assert.rejects(github("quota-two"), status(409, /上限（2 个）/));
  const response = await f.api("/github/sources", {
    method: "POST",
    body: { siteId: "atlas", resourceId: "quota-three", repository: "acme/q", expectedVersion: 0 },
  });
  assert.equal(response.status, 409);
  // Editing an existing GitHub source never counts, even below the quota.
  await limit("atlas", { collectorSources: 1 });
  const edited = await f.app.github.save(f.admin, {
    siteId: "atlas",
    resourceId: "quota-one",
    repository: "acme/renamed",
    expectedVersion: 1,
  });
  assert.equal(edited.version, 2);
  assert.equal(edited.repository, "acme/renamed");
  await limit("atlas", { collectorSources: 0 });
  await assert.rejects(github("quota-zero"), status(409, /配额为 0/));
  // Usage and the generic list see GitHub rows of the same table.
  const usage = await (await f.api("/collectors/usage?site=atlas")).json();
  assert.equal(usage.sources, 2);
  const listed = await f.app.collectors.list(f.admin, "atlas");
  assert.deepEqual(listed.map((s) => s.kind).sort(), ["github", "rss"]);
  // The generic editor can neither create nor edit nor sync GitHub sources.
  await limit("atlas", { collectorSources: 10 });
  const create = await f.api("/collectors", {
    method: "POST",
    body: { siteId: "atlas", kind: "github", config: { repository: "acme/x" }, expectedVersion: 0 },
  });
  assert.equal(create.status, 400);
  assert.match((await create.json()).error, /开源项目/);
  await assert.rejects(
    f.app.collectors.save(f.admin, {
      id: first.id,
      siteId: "atlas",
      kind: "rss",
      config: { url: "https://feed.example.test/rss" },
      expectedVersion: 2,
    }),
    status(400, /开源项目/),
  );
  await assert.rejects(
    f.app.collectors.enqueue(f.admin, first.id, randomUUID()),
    status(400, /开源项目/),
  );
  assert.equal(
    (await f.pool.query("SELECT kind,version FROM collector_source WHERE id=$1", [first.id])).rows[0].kind,
    "github",
  );
});

test("P10 manual GitHub sync uses the hourly run limit only when it creates a task", async () => {
  await limit("atlas", { collectorRunsPerHour: 2 });
  const source = await github("rate-one");
  const feed = await rss();
  const op1 = randomUUID();
  const task = await f.app.github.enqueue(f.admin, source.id, op1);
  assert.equal(
    (await f.app.github.enqueue(f.admin, source.id, randomUUID())).id,
    task.id,
  );
  await f.app.collectors.enqueue(f.admin, feed.id, randomUUID());
  // The allowance is used up, but coalescing into the open task is free.
  assert.equal(
    (await f.app.github.enqueue(f.admin, source.id, randomUUID())).id,
    task.id,
  );
  assert.equal(
    (await (await f.api("/collectors/usage?site=atlas")).json()).runsLastHour,
    2,
  );
  await f.pool.query(
    "UPDATE collector_task SET status='done',completed_at=now() WHERE id=$1",
    [task.id],
  );
  await assert.rejects(
    f.app.github.enqueue(f.admin, source.id, randomUUID()),
    status(429, /每小时 2 次/),
  );
  const response = await f.api(`/github/sources/${source.id}/sync`, {
    method: "POST",
    body: { operationId: randomUUID() },
  });
  assert.equal(response.status, 429);
  // Replaying an operation id still returns its task.
  const replay = await f.app.github.enqueue(f.admin, source.id, op1);
  assert.equal(replay.id, task.id);
  assert.equal(replay.status, "done");
  assert.equal("retry_of" in replay, false);
  await limit("atlas", { collectorRunsPerHour: 0 });
  await assert.rejects(
    f.app.github.enqueue(f.admin, source.id, randomUUID()),
    status(429, /已停用采集/),
  );
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM collector_task WHERE source_id=$1", [source.id])).rows[0].n,
    1,
  );
});

test("P10 collector task list shows GitHub tasks and retries failed ones through the GitHub worker", async () => {
  const source = await github("listed");
  const worker = new GithubWorker(f.pool, client);
  await f.app.github.enqueue(f.admin, source.id, randomUUID());
  mode = "missing";
  assert.equal(await worker.runOnce(), "failed");
  const listed = await f.app.collectors.tasks(f.admin, { site: "atlas" });
  assert.equal(listed.items.length, 1);
  const failed = listed.items[0];
  assert.deepEqual(
    { kind: failed.kind, source: failed.source, status: failed.status, error: failed.error, sourceId: failed.sourceId },
    { kind: "github", source: "acme/listed", status: "failed", error: "not_found", sourceId: source.id },
  );
  const viaApi = await (await f.api("/collectors/tasks?site=atlas&status=failed")).json();
  assert.equal(viaApi.items[0].source, "acme/listed");
  // Retrying is a global-operator action, as for every collector retry.
  await assert.rejects(
    f.app.collectors.retry(f.editor, failed.id, { site: "atlas", operationId: randomUUID() }),
    status(403),
  );
  // A binding retry needs the site's modules, like a manual GitHub sync.
  await f.pool.query("UPDATE site SET modules=ARRAY['directory'] WHERE id='atlas'");
  await assert.rejects(
    f.app.collectors.retry(f.admin, failed.id, { site: "atlas", operationId: randomUUID() }),
    status(409, /开源项目模块/),
  );
  await f.pool.query("UPDATE site SET modules=ARRAY['directory','opensource'] WHERE id='atlas'");
  const operationId = randomUUID();
  const response = await f.api(`/collectors/tasks/${failed.id}/retry`, {
    method: "POST",
    body: { site: "atlas", operationId },
  });
  assert.equal(response.status, 202);
  const retried = await response.json();
  assert.equal(retried.retry_of, failed.id);
  assert.equal(
    (await f.app.collectors.retry(f.admin, failed.id, { site: "atlas", operationId })).id,
    retried.id,
  );
  // Never a second open task for one GitHub source.
  await assert.rejects(
    f.app.collectors.retry(f.admin, failed.id, { site: "atlas", operationId: randomUUID() }),
    status(409, /已有排队或处理中的任务/),
  );
  assert.equal(
    (await f.app.github.enqueue(f.admin, source.id, randomUUID())).id,
    retried.id,
  );
  mode = "ok";
  await budgetOpen();
  assert.equal(await worker.runOnce(), "done");
  const detail = await f.app.github.detail(f.admin, source.id);
  assert.equal(detail.candidates.length, 1);
  assert.equal(detail.candidates[0].task_id, retried.id);
  assert.deepEqual(
    detail.tasks.map((t) => [t.id, t.status, t.result ?? t.error_code]),
    [
      [retried.id, "done", "candidate_created"],
      [failed.id, "failed", "not_found"],
    ],
  );
  // The original failed row is left untouched for audit.
  const original = (await f.pool.query("SELECT status,error_code FROM collector_task WHERE id=$1", [failed.id])).rows[0];
  assert.deepEqual(original, { status: "failed", error_code: "not_found" });
});

test("P10 scheduler applies site allowance, module requirements and one open task per GitHub source", async () => {
  await limit("atlas", { collectorRunsPerHour: 1 });
  const one = await github("sched-one"),
    two = await github("sched-two");
  // A GitHub source on a site without the open-source module is never scheduled.
  const other = await github("sched-notes", "notes", false);
  await f.pool.query("UPDATE collector_source SET enabled=true WHERE id=$1", [other.id]);
  await f.pool.query("UPDATE collector_source SET next_run_at=now()-interval '1 minute'");
  const scheduler = new CollectorTaskWorker(f.pool, { kinds: ["github"], github: client });
  assert.deepEqual(await scheduler.schedule(), { queued: 1, deferred: 1 });
  const rows = async () =>
    Object.fromEntries(
      (
        await f.pool.query(
          `SELECT s.id,extract(epoch FROM s.next_run_at-now())::int AS wait,
             (SELECT count(*)::int FROM collector_task t WHERE t.source_id=s.id) AS tasks
           FROM collector_source s`,
        )
      ).rows.map((row) => [row.id, row]),
    );
  let state = await rows();
  assert.equal(state[other.id].tasks, 0);
  const queued = state[one.id].tasks === 1 ? one : two,
    deferred = queued === one ? two : one;
  assert.equal(state[deferred.id].tasks, 0);
  assert.ok(state[deferred.id].wait >= 14 * 60 && state[deferred.id].wait <= 15 * 60);
  assert.ok(state[queued.id].wait > 3500);
  // With allowance again, the source that still has an open task only advances.
  await limit("atlas", { collectorRunsPerHour: 10 });
  await f.pool.query(
    "UPDATE collector_source SET next_run_at=now()-interval '1 minute' WHERE site_id='atlas'",
  );
  assert.deepEqual(await scheduler.schedule(), { queued: 1, deferred: 0 });
  state = await rows();
  assert.equal(state[queued.id].tasks, 1);
  assert.equal(state[deferred.id].tasks, 1);
  assert.ok(state[queued.id].wait > 3500);
  // The compatibility GitHub worker schedules nothing new while tasks are open.
  await f.pool.query(
    "UPDATE collector_source SET next_run_at=now()-interval '1 minute' WHERE site_id='atlas'",
  );
  await new GithubWorker(f.pool, client).schedule();
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM collector_task")).rows[0].n,
    2,
  );
  // Discovery scheduling ignores GitHub sources, and vice versa.
  const feed = await rss("notes");
  await f.pool.query("UPDATE collector_source SET next_run_at=now()-interval '1 minute'");
  assert.deepEqual(await new CollectorWorker(f.pool).schedule(), { queued: 1, deferred: 0 });
  state = await rows();
  assert.equal(state[feed.id].tasks, 1);
  assert.equal(state[other.id].tasks, 0);
});

test("P10 GitHub API budget paces only GitHub claims while one worker runs every kind", async () => {
  const source = await github("paced");
  const feed = await rss();
  const gTask = await f.app.github.enqueue(f.admin, source.id, randomUUID());
  const rTask = await f.app.collectors.enqueue(f.admin, feed.id, randomUUID());
  await f.pool.query("UPDATE github_budget SET next_at=now()+interval '1 hour'");
  const all = new CollectorTaskWorker(f.pool, { github: client, fetcher: rssFetcher });
  const before = calls;
  // The GitHub task is older, but the cooling budget only holds GitHub back.
  assert.equal(await all.runOnce(), "done");
  assert.equal(await all.runOnce(), "idle");
  assert.equal(calls, before);
  const status = async (id: string) =>
    (await f.pool.query("SELECT status,result FROM collector_task WHERE id=$1", [id])).rows[0];
  assert.deepEqual(await status(rTask.id), { status: "done", result: "items:1" });
  assert.deepEqual(await status(gTask.id), { status: "pending", result: null });
  // A discovery-only worker is never blocked by a held budget row.
  const holder = await f.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM github_budget WHERE id=1 FOR UPDATE");
    await f.app.collectors.enqueue(f.admin, feed.id, randomUUID());
    assert.equal(await new CollectorWorker(f.pool, rssFetcher).runOnce(), "done");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  const opened = (
    await f.pool.query(
      "UPDATE github_budget SET next_at=now()-interval '1 second' RETURNING next_at",
    )
  ).rows[0].next_at;
  assert.equal(await all.runOnce(), "done");
  assert.deepEqual(await status(gTask.id), { status: "done", result: "candidate_created" });
  // Claiming a GitHub task advances the shared budget by one second.
  assert.equal(
    (
      await f.pool.query(
        "SELECT next_at>=$1::timestamptz+interval '1 second' AS paced FROM github_budget",
        [opened],
      )
    ).rows[0].paced,
    true,
  );
  const detail = await f.app.github.detail(f.admin, source.id);
  assert.equal(detail.source.remote_id, "77");
  assert.equal(detail.source.etag, '"fixture"');
});

test("P10 retention prunes superseded GitHub candidates and old GitHub tasks but keeps reviewed history", async () => {
  const source = await github("retained");
  const operation = randomUUID();
  const task = await f.app.github.enqueue(f.admin, source.id, operation);
  assert.equal(await new GithubWorker(f.pool, client).runOnce(), "done");
  const pending = (await f.app.github.detail(f.admin, source.id)).candidates[0];
  assert.equal(pending.task_id, task.id);
  const data = pending.data;
  const insert = async (status: string, age: string) =>
    (
      await f.pool.query(
        `INSERT INTO github_candidate(source_id,source_version,base_version,data,status,created_at)
         VALUES($1,1,0,$2,$3,now()-$4::interval) RETURNING id`,
        [source.id, data, status, age],
      )
    ).rows[0].id as string;
  const oldSuperseded = await insert("superseded", "40 days"),
    newSuperseded = await insert("superseded", "2 days"),
    oldAccepted = await insert("accepted", "400 days"),
    oldRejected = await insert("rejected", "400 days");
  await f.pool.query(
    "UPDATE collector_task SET completed_at=now()-interval '40 days',created_at=now()-interval '40 days' WHERE id=$1",
    [task.id],
  );
  assert.deepEqual(await pruneCollectors(f.pool, DEFAULT_RETENTION), {
    deletedTasks: 1,
    deletedSuperseded: 1,
    compacted: 0,
  });
  const rows = Object.fromEntries(
    (await f.pool.query("SELECT id,status,task_id,data FROM github_candidate")).rows.map((r) => [r.id, r]),
  );
  assert.equal(rows[oldSuperseded], undefined);
  assert.ok(rows[newSuperseded]);
  // Reviewed GitHub candidates are the resource change history: kept intact.
  assert.deepEqual(rows[oldAccepted].data, data);
  assert.deepEqual(rows[oldRejected].data, data);
  // The pending candidate survives its pruned task; the request mapping goes with it.
  assert.equal(rows[pending.id].status, "pending");
  assert.equal(rows[pending.id].task_id, null);
  assert.equal(
    (await f.pool.query("SELECT 1 FROM github_request WHERE id=$1", [operation])).rowCount,
    0,
  );
  assert.deepEqual(await pruneCollectors(f.pool, DEFAULT_RETENTION), {
    deletedTasks: 0,
    deletedSuperseded: 0,
    compacted: 0,
  });
  // A pending candidate is still reviewable after its task was pruned.
  const review = await f.app.content.reviewGithub(f.admin, {
    candidateId: pending.id,
    expectedCandidateVersion: pending.version,
    expectedResourceVersion: 0,
    decision: "accept",
    fields: ["project", "url", "source", "translations.en.title", "translations.en.description"],
  });
  assert.deepEqual(review, { status: "accepted", version: 1 });
});
