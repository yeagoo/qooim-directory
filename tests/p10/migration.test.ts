import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";

let pool: Pool;
const ids = {
  enabled: randomUUID(),
  disabled: randomUUID(),
  done: randomUUID(),
  failed: randomUUID(),
  pending: randomUUID(),
  processing: randomUUID(),
  lease: randomUUID(),
  pendingCandidate: randomUUID(),
  acceptedCandidate: randomUUID(),
  supersededCandidate: randomUUID(),
  request: randomUUID(),
};
const project = {
  repoId: "123",
  fullName: "acme/tool",
  stars: 5,
  forks: 1,
  openIssues: 0,
  pushedAt: null,
};
before(async () => {
  pool = await database();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  // Build a v0.2.0-rc.1 + M6–M9 database (migrations up to 013) holding GitHub data in every state.
  const dir = await mkdtemp(join(tmpdir(), "p10-migrate-"));
  try {
    for (const file of await readdir("migrations"))
      if (/^0(0\d|1[0-3])-/.test(file)) await cp(join("migrations", file), join(dir, file));
    await migrate(pool, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await pool.query(
    "INSERT INTO site(id,host,config) VALUES('atlas','atlas.test',$1)",
    [{ name: "Atlas", template: "basic", locales: ["en"], navigation: [], catalogPath: "tools", tagline: "" }],
  );
  await pool.query(
    "INSERT INTO resource(id,internal_note) VALUES('tool',''),('other','')",
  );
  await pool.query(
    `INSERT INTO github_source(id,site_id,resource_id,repository,enabled,version,interval_seconds,next_run_at,etag,last_hash,remote_id,created_at)
     VALUES($1,'atlas','tool','acme/tool',true,3,7200,'2026-10-01T00:00:00Z','"etag-1"','hash-1','123','2026-09-01T00:00:00Z'),
           ($2,'atlas','other','acme/other',false,1,86400,'2026-10-02T00:00:00Z',NULL,NULL,NULL,'2026-09-02T00:00:00Z')`,
    [ids.enabled, ids.disabled],
  );
  await pool.query(
    `INSERT INTO github_task(id,source_id,source_version,status,attempts,available_at,lease_token,lease_until,error_code,result,created_at,completed_at) VALUES
     ($1,$6,3,'done',1,'2026-10-01T00:00:00Z',NULL,NULL,NULL,'candidate_created','2026-10-01T00:00:00Z','2026-10-01T00:01:00Z'),
     ($2,$6,3,'failed',5,'2026-10-02T00:00:00Z',NULL,NULL,'rate_limited',NULL,'2026-10-02T00:00:00Z','2026-10-02T00:05:00Z'),
     ($3,$7,1,'pending',0,'2026-10-03T00:00:00Z',NULL,NULL,NULL,NULL,'2026-10-03T00:00:00Z',NULL),
     ($4,$6,3,'processing',2,'2026-10-04T00:00:00Z',$5,'2026-10-04T00:01:00Z','delivery_failed',NULL,'2026-10-04T00:00:00Z',NULL)`,
    [ids.done, ids.failed, ids.pending, ids.processing, ids.lease, ids.enabled, ids.disabled],
  );
  await pool.query("INSERT INTO github_request VALUES($1,$2,$3)", [
    ids.request,
    ids.enabled,
    ids.processing,
  ]);
  const data = { url: "https://github.com/acme/tool", kind: "repository", source: "github", translations: {}, project };
  // Before 014 every candidate needs its own task.
  await pool.query(
    `INSERT INTO github_candidate(id,source_id,task_id,source_version,base_version,data,status,version,applied_version,review_fingerprint,created_at) VALUES
     ($1,$4,$5,3,2,$8,'pending',1,NULL,NULL,'2026-10-01T00:01:00Z'),
     ($2,$4,$6,3,1,$8,'accepted',2,2,'fp-1','2026-09-20T00:00:00Z'),
     ($3,$9,$7,1,0,$8,'superseded',2,NULL,NULL,'2026-09-10T00:00:00Z')`,
    [ids.pendingCandidate, ids.acceptedCandidate, ids.supersededCandidate, ids.enabled, ids.done, ids.failed, ids.pending, data, ids.disabled],
  );
  await migrate(pool);
});
after(async () => {
  await pool?.end();
});
const iso = (value: Date | null) => (value ? value.toISOString() : null);
test("P10 migration moves GitHub sources into the unified table with ids, versions and cursors", async () => {
  const rows = (
    await pool.query(
      "SELECT * FROM collector_source WHERE kind='github' ORDER BY created_at",
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => ({
      id: r.id,
      site: r.site_id,
      resource: r.resource_id,
      config: r.config,
      enabled: r.enabled,
      version: r.version,
      interval: r.interval_seconds,
      next: iso(r.next_run_at),
      etag: r.etag,
      hash: r.last_hash,
      remote: r.remote_id,
      created: iso(r.created_at),
    })),
    [
      { id: ids.enabled, site: "atlas", resource: "tool", config: { repository: "acme/tool" }, enabled: true, version: 3, interval: 7200, next: "2026-10-01T00:00:00.000Z", etag: '"etag-1"', hash: "hash-1", remote: "123", created: "2026-09-01T00:00:00.000Z" },
      { id: ids.disabled, site: "atlas", resource: "other", config: { repository: "acme/other" }, enabled: false, version: 1, interval: 86400, next: "2026-10-02T00:00:00.000Z", etag: null, hash: null, remote: null, created: "2026-09-02T00:00:00.000Z" },
    ],
  );
});
test("P10 migration keeps every task state, lease and result", async () => {
  const rows = (
    await pool.query(
      "SELECT * FROM collector_task WHERE id=ANY($1::uuid[]) ORDER BY created_at",
      [[ids.done, ids.failed, ids.pending, ids.processing]],
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => [r.id, r.source_id, r.source_version, r.status, r.attempts, r.lease_token, iso(r.lease_until), r.error_code, r.result, iso(r.completed_at), r.retry_of]),
    [
      [ids.done, ids.enabled, 3, "done", 1, null, null, null, "candidate_created", "2026-10-01T00:01:00.000Z", null],
      [ids.failed, ids.enabled, 3, "failed", 5, null, null, "rate_limited", null, "2026-10-02T00:05:00.000Z", null],
      [ids.pending, ids.disabled, 1, "pending", 0, null, null, null, null, null, null],
      [ids.processing, ids.enabled, 3, "processing", 2, ids.lease, "2026-10-04T00:01:00.000Z", "delivery_failed", null, null, null],
    ],
  );
});
test("P10 migration re-points candidates and request coalescing and drops the old tables", async () => {
  const candidates = (
    await pool.query(
      "SELECT id,source_id,task_id,status,version,base_version,applied_version,review_fingerprint,data FROM github_candidate ORDER BY created_at",
    )
  ).rows;
  assert.equal(candidates.length, 3);
  assert.deepEqual(
    candidates.map((c) => [c.id, c.status, c.version, c.base_version, c.applied_version, c.review_fingerprint]),
    [
      [ids.supersededCandidate, "superseded", 2, 0, null, null],
      [ids.acceptedCandidate, "accepted", 2, 1, 2, "fp-1"],
      [ids.pendingCandidate, "pending", 1, 2, null, null],
    ],
  );
  assert.deepEqual(candidates[2].data.project, project);
  const request = (
    await pool.query("SELECT source_id,task_id FROM github_request WHERE id=$1", [ids.request])
  ).rows[0];
  assert.deepEqual(request, { source_id: ids.enabled, task_id: ids.processing });
  const old = (
    await pool.query(
      "SELECT to_regclass('github_source') AS s, to_regclass('github_task') AS t",
    )
  ).rows[0];
  assert.deepEqual(old, { s: null, t: null });
});
test("P10 unified constraints bind GitHub sources to one resource and let retention prune tasks", async () => {
  // A binding source needs a resource; a discovery source must not have one.
  await assert.rejects(
    pool.query(
      "INSERT INTO collector_source(site_id,kind,config) VALUES('atlas','github','{\"repository\":\"acme/x\"}')",
    ),
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO collector_source(site_id,kind,config,resource_id) VALUES('atlas','rss','{}','tool')",
    ),
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO collector_source(site_id,kind,config,resource_id) VALUES('atlas','github','{\"repository\":\"acme/x\"}','tool')",
    ),
  );
  // Deleting a task keeps its candidate (task_id cleared) and drops request mappings.
  await pool.query("DELETE FROM collector_task WHERE id=$1", [ids.done]);
  const pending = (
    await pool.query("SELECT task_id,status FROM github_candidate WHERE id=$1", [ids.pendingCandidate])
  ).rows[0];
  assert.deepEqual(pending, { task_id: null, status: "pending" });
  await pool.query("DELETE FROM collector_task WHERE id=$1", [ids.processing]);
  assert.equal(
    (await pool.query("SELECT 1 FROM github_request WHERE id=$1", [ids.request])).rowCount,
    0,
  );
});
