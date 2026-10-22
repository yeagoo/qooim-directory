import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { password, setup, type Fixture } from "../p6/helpers.js";
import { runMaintenance } from "../../src/server/maintenance.js";
import { DEFAULT_RETENTION } from "../../src/server/retention.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
test("P7 migration adds retry links that survive retention deletes", async () => {
  const site = "atlas";
  const original = (
    await f.pool.query(
      "INSERT INTO ai_job(site_id,kind,payload,status,completed_at) VALUES($1,'seo','{}','failed',now()) RETURNING id",
      [site],
    )
  ).rows[0].id;
  const retry = (
    await f.pool.query(
      "INSERT INTO ai_job(site_id,kind,payload,retry_of) VALUES($1,'seo','{}',$2) RETURNING id",
      [site, original],
    )
  ).rows[0].id;
  await f.pool.query("DELETE FROM ai_job WHERE id=$1", [original]);
  const row = (
    await f.pool.query("SELECT retry_of FROM ai_job WHERE id=$1", [retry])
  ).rows[0];
  assert.equal(row.retry_of, null);
  await f.pool.query("DELETE FROM ai_job");
});
test("P7 tasks API reports AI/collector counts, retention policy and last cleanup", async () => {
  await runMaintenance(f.pool, { force: true });
  const data = await (await f.api("/tasks")).json();
  assert.deepEqual(data.retention, DEFAULT_RETENTION);
  assert.ok(Array.isArray(data.ai));
  assert.ok(Array.isArray(data.collectors));
  const last = data.maintenance.find(
    (m: { name: string }) => m.name === "retention",
  );
  assert.equal(last.detail.state, "done");
  const viewer = f.app.respond(
    new Request("https://admin.p6.test/admin/api/tasks", {
      headers: {
        host: "admin.p6.test",
        cookie:
          "network_operator=" +
          (await f.app.sites.operators.login(f.viewer.email, password)),
      },
    }),
  );
  assert.equal((await viewer).status, 403);
});
test("P7 tasks page renders the retention panel", async () => {
  const { page, close } = await f.browse(f.admin, "#tasks");
  try {
    await page.waitForSelector("#retention");
    const text = (await page.locator("#retention").textContent()) ?? "";
    assert.match(text, /数据保留/);
    assert.match(text, new RegExp(`${DEFAULT_RETENTION.aiJobDays} 天`));
    assert.match(text, /最近一次清理/);
    assert.match(text, /完成/);
  } finally {
    await close();
  }
});
