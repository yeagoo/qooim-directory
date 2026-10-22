import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
test("P10 collector page sends GitHub rows to the open-source page instead of generic actions", async () => {
  await f.pool.query("INSERT INTO resource(id,internal_note) VALUES('bound-tool','')");
  await f.pool.query(
    `INSERT INTO collector_source(site_id,kind,config,resource_id) VALUES
     ('atlas','github','{"repository":"acme/tool"}','bound-tool'),
     ('atlas','rss','{"url":"https://example.com/feed.xml","locale":"zh"}',NULL)`,
  );
  const { page, close } = await f.browse(f.admin, "#collectors/atlas");
  try {
    await page.waitForSelector(".manage-github");
    const rows = page.locator("tr", { has: page.locator("td", { hasText: /^github$/ }) });
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.locator(".sync-collector, .edit-collector, .detail-collector").count(), 0);
    assert.equal(await rows.locator("a.manage-github").getAttribute("href"), "#github");
    const rss = page.locator("tr", { has: page.locator("td", { hasText: /^rss$/ }) });
    assert.equal(await rss.locator(".sync-collector").count(), 1);
    assert.equal(await rss.locator(".edit-collector").count(), 1);
  } finally {
    await close();
  }
});
