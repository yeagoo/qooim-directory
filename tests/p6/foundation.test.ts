import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "./helpers.js";
import { DEFAULT_LIMITS } from "../../src/server/limits.js";
import { runMaintenance } from "../../src/server/maintenance.js";
import { retentionPolicy } from "../../src/server/retention.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
test("P6 site limits default, override, reset and permissions", async () => {
  assert.deepEqual(await f.app.limits.get(f.viewer, "atlas"), {
    site: "atlas",
    ...DEFAULT_LIMITS,
  });
  await assert.rejects(
    f.app.limits.save(f.editor, { site: "atlas", mediaFiles: 1 }),
    { status: 403 },
  );
  await assert.rejects(f.app.limits.get(f.viewer, "notes"), { status: 403 });
  const saved = await (
    await f.api("/limits", {
      method: "POST",
      body: { site: "atlas", mediaFiles: 3, collectorSources: 0 },
    })
  ).json();
  assert.equal(saved.mediaFiles, 3);
  assert.equal(saved.collectorSources, 0);
  assert.equal(saved.mediaBytes, DEFAULT_LIMITS.mediaBytes);
  // Omitted fields keep their override; null restores the default.
  await f.app.limits.save(f.admin, { site: "atlas", mediaFiles: null });
  const after = await (await f.api("/limits?site=atlas")).json();
  assert.equal(after.mediaFiles, DEFAULT_LIMITS.mediaFiles);
  assert.equal(after.collectorSources, 0);
  await assert.rejects(
    f.app.limits.save(f.admin, { site: "missing", mediaFiles: 1 }),
    { status: 404 },
  );
  await assert.rejects(f.app.limits.save(f.admin, { site: "atlas", mediaFiles: -1 }));
  const audit = await f.pool.query(
    "SELECT count(*)::int AS n FROM audit_event WHERE action='site.limit.save'",
  );
  assert.equal(audit.rows[0].n, 2);
});
test("P6 maintenance claims one slot per interval unless forced", async () => {
  await f.pool.query("DELETE FROM maintenance_status WHERE name='retention'");
  assert.ok(await runMaintenance(f.pool));
  assert.equal(await runMaintenance(f.pool), null);
  assert.ok(await runMaintenance(f.pool, { force: true }));
  const row = (
    await f.pool.query("SELECT detail FROM maintenance_status WHERE name='retention'")
  ).rows[0];
  assert.equal(row.detail.state, "done");
});
test("P6 retention policy validates environment overrides", () => {
  assert.equal(retentionPolicy({}).aiJobDays, 180);
  assert.equal(retentionPolicy({ RETENTION_AI_DAYS: "" }).aiJobDays, 180);
  assert.equal(retentionPolicy({ RETENTION_COLLECTOR_TASK_DAYS: "7" }).collectorTaskDays, 7);
  // AI history must outlive the current budget month.
  assert.throws(() => retentionPolicy({ RETENTION_AI_DAYS: "10" }));
  assert.throws(() => retentionPolicy({ RETENTION_COLLECTOR_REVIEWED_DAYS: "abc" }));
});
test("P6 quota page edits limits for global admins and is read-only otherwise", async () => {
  await f.app.limits.save(f.admin, {
    site: "atlas",
    mediaBytes: null,
    mediaFiles: null,
    collectorSources: null,
    collectorRunsPerHour: null,
  });
  const owner = await f.browse(f.admin, "#limits/atlas");
  try {
    const { page } = owner;
    await page.waitForSelector("#save-limits");
    assert.equal(await page.inputValue("#limit-media-mib"), "1024");
    await page.fill("#limit-media-mib", "5");
    await page.fill("#limit-collector-runs", "0");
    await page.click("#save-limits");
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("配额已保存"),
    );
    const saved = await f.app.limits.get(f.admin, "atlas");
    assert.equal(saved.mediaBytes, 5 * 1024 * 1024);
    assert.equal(saved.collectorRunsPerHour, 0);
    await page.click("#reset-limits");
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("已恢复默认"),
    );
    assert.deepEqual(await f.app.limits.get(f.admin, "atlas"), {
      site: "atlas",
      ...DEFAULT_LIMITS,
    });
  } finally {
    await owner.close();
  }
  const reader = await f.browse(f.viewer, "#limits/atlas");
  try {
    const { page } = reader;
    await page.waitForSelector("#limit-media-files");
    assert.equal(await page.isDisabled("#limit-media-files"), true);
    assert.equal(await page.locator("#save-limits").count(), 0);
  } finally {
    await reader.close();
  }
});
