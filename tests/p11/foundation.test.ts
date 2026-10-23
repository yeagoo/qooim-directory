import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { password, setup, type Fixture } from "../p6/helpers.js";
import { pruneCollectors } from "../../src/server/collectors.js";
import { DEFAULT_RETENTION } from "../../src/server/retention.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
const sitesAs = async (email: string) => {
  const token = await f.app.sites.operators.login(email, password);
  const response = await f.app.respond(
    new Request("https://admin.p6.test/admin/api/sites", {
      headers: { host: "admin.p6.test", cookie: "network_operator=" + token },
    }),
  );
  assert.equal(response.status, 200);
  return Object.fromEntries(
    ((await response.json()) as { id: string; role: string }[]).map((s) => [s.id, s.role]),
  );
};
test("P11 site list reports the operator's role per site", async () => {
  assert.deepEqual(await sitesAs(f.admin.email), { atlas: "admin", notes: "admin" });
  assert.deepEqual(await sitesAs(f.editor.email), { atlas: "editor" });
  assert.deepEqual(await sitesAs(f.viewer.email), { atlas: "viewer" });
});
test("P11 retention prunes finished tasks that never recorded completed_at", async () => {
  const source = (
    await f.pool.query(
      "INSERT INTO collector_source(site_id,kind,config) VALUES('atlas','rss','{\"url\":\"https://example.com/f.xml\",\"locale\":\"zh\"}') RETURNING id",
    )
  ).rows[0].id;
  const insert = (status: string, created: string, completed: string | null) =>
    f.pool
      .query(
        "INSERT INTO collector_task(source_id,source_version,status,created_at,completed_at) VALUES($1,1,$2,$3,$4) RETURNING id",
        [source, status, created, completed],
      )
      .then((r) => r.rows[0].id as string);
  const staleNoCompletion = await insert("failed", "2000-01-01", null);
  const freshNoCompletion = await insert("cancelled", new Date().toISOString(), null);
  const stalePending = await insert("pending", "2000-01-01", null);
  const result = await pruneCollectors(f.pool, DEFAULT_RETENTION);
  assert.equal(result.deletedTasks, 1);
  const left = (
    await f.pool.query("SELECT id FROM collector_task WHERE source_id=$1 ORDER BY created_at", [source])
  ).rows.map((r) => r.id);
  assert.deepEqual(left.sort(), [freshNoCompletion, stalePending].sort());
  assert.equal(left.includes(staleNoCompletion), false);
});
test("P11 single candidate review works over HTTP (regression since M5)", async () => {
  const source = (
    await f.pool.query(
      "INSERT INTO collector_source(site_id,kind,config) VALUES('atlas','rss','{\"url\":\"https://example.com/r.xml\",\"locale\":\"zh\"}') RETURNING id",
    )
  ).rows[0].id;
  const task = (
    await f.pool.query(
      "INSERT INTO collector_task(source_id,source_version,status,completed_at) VALUES($1,1,'done',now()) RETURNING id",
      [source],
    )
  ).rows[0].id;
  const candidate = (external: string) =>
    f.pool
      .query(
        `INSERT INTO collector_candidate(source_id,task_id,external_id,locale,data,fingerprint)
         VALUES($1,$2,$3,'zh',$4,'fp') RETURNING id`,
        [
          source,
          task,
          external,
          {
            url: `https://example.com/${external}`,
            kind: "website",
            source: "rss:example.com",
            translations: { zh: { title: external, description: external } },
          },
        ],
      )
      .then((r) => r.rows[0].id as string);
  const review = (id: string, decision: string, expectedVersion = 1) =>
    f.api(`/collector-candidates/${id}/review`, {
      method: "POST",
      body: { site: "atlas", decision, expectedVersion },
    });
  const accepted = await candidate("accept-me");
  const response = await review(accepted, "accept");
  assert.equal(response.status, 200);
  const { resourceId } = await response.json();
  assert.ok(resourceId);
  assert.equal(
    (await f.pool.query("SELECT 1 FROM content_draft WHERE resource_id=$1", [resourceId])).rowCount,
    1,
  );
  const rejected = await candidate("reject-me");
  assert.equal((await review(rejected, "reject")).status, 200);
  assert.equal(
    (await f.pool.query("SELECT status FROM collector_candidate WHERE id=$1", [rejected])).rows[0].status,
    "rejected",
  );
  // Stale version and unknown ids report real errors instead of a schema 400.
  assert.equal((await review(rejected, "reject")).status, 409);
  assert.equal((await review("00000000-0000-4000-8000-000000000000", "reject")).status, 404);
});
