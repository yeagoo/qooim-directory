import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { setup, type Fixture } from "../p6/helpers.js";

const basePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// The parser only reads the PNG header, so trailing bytes give distinct hashes.
function png(seed: number) {
  const data = Buffer.alloc(1000, 0);
  basePng.copy(data);
  data.writeUInt32BE(seed, 996);
  return data;
}
const file = (name: string, seed: number, mimeType = "image/png") => ({
  name,
  mimeType,
  buffer: png(seed),
});
let f: Fixture, locale: string;
before(async () => {
  f = await setup();
  locale = (
    await f.pool.query("SELECT config->'locales'->>0 AS l FROM site WHERE id='atlas'")
  ).rows[0].l;
});
after(async () => {
  await f?.close();
});
const upload = (seed: number) =>
  f.app.media.upload(f.admin, {
    site: "atlas",
    filename: `p${seed}.png`,
    mime: "image/png",
    alt: "封面",
    data: png(seed).toString("base64"),
  });
const replace = (id: string, seed: number) =>
  f.app.media.replace(f.admin, id, {
    filename: `r${seed}.png`,
    mime: "image/png",
    data: png(seed).toString("base64"),
  });
const count = async () =>
  (await f.pool.query("SELECT count(*)::int AS n FROM media WHERE site_id='atlas'")).rows[0]
    .n as number;
const versions = async (id: string) =>
  (
    await f.pool.query(
      "SELECT version FROM media_version WHERE media_id=$1 ORDER BY version",
      [id],
    )
  ).rows.map((row) => Number(row.version));
const current = async (id: string) =>
  Number((await f.pool.query("SELECT version FROM media WHERE id=$1", [id])).rows[0].version);
async function publishWith(resource: string, mediaId: string) {
  await f.app.content.saveResource(f.admin, {
    id: resource,
    expectedVersion: 0,
    data: {
      url: `https://example.com/${resource}`,
      source: "manual",
      translations: { [locale]: { title: resource, description: `${resource} item` } },
    },
    public: true,
  });
  const version = async (table: string) =>
    Number(
      (
        await f.pool.query(
          `SELECT version FROM ${table} WHERE site_id='atlas' AND resource_id=$1 AND locale=$2`,
          [resource, locale],
        )
      ).rows[0]?.version ?? 0,
    );
  const published = await version("publication");
  const draft = await f.app.content.stage(f.admin, "atlas", resource, locale, {
    candidate: {
      resourceVersion: 1,
      slug: resource,
      overrides: { image: { mediaId, alt: "资源封面" } },
    },
    expected: { published, draft: await version("content_draft") },
  });
  await f.app.content.publish(f.admin, "atlas", resource, locale, {
    expected: { published, draft },
    operationId: randomUUID(),
  });
}
const message = (page: Page, text: string) =>
  page.waitForFunction(
    (t) => document.querySelector("#message")?.textContent?.includes(t),
    text,
  );
const statuses = (page: Page) =>
  page.$$eval(".batch-status", (cells) => cells.map((cell) => cell.textContent ?? ""));
const card = (id: string) => `.media-item[data-id="${id}"]`;
const row = (version: number) => `#media-history .version-row[data-version="${version}"]`;
const labels = (page: Page, version: number) =>
  page.$$eval(`${row(version)} .version-label`, (spans) =>
    spans.map((span) => span.textContent ?? ""),
  );
async function openHistory(page: Page, id: string) {
  await page.click(`${card(id)} .history-media`);
  await page.waitForSelector("#media-history .version-row");
}

test("P8 batch upload uploads each file, keeps going after a failure and allows removal", async () => {
  const before = await count();
  const editor = await f.browse(f.editor, "#media/atlas");
  try {
    const { page } = editor;
    await page.waitForSelector("#media-batch-files");
    await page.setInputFiles("#media-batch-files", [
      file("sunrise.png", 101),
      { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") },
      file("night sky.png", 102),
      file("unwanted.png", 103),
    ]);
    await page.waitForSelector(".batch-row >> nth=3");
    // Alt text defaults to the filename without its extension.
    assert.deepEqual(
      await page.$$eval(".batch-alt", (inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value),
      ),
      ["sunrise", "broken", "night sky", "unwanted"],
    );
    assert.deepEqual(await statuses(page), ["等待", "等待", "等待", "等待"]);
    await page.click('.batch-row[data-index="3"] .batch-remove');
    await page.waitForFunction(() => document.querySelectorAll(".batch-row").length === 3);
    await page.fill('.batch-alt[data-index="0"]', "日出");
    await page.click("#start-batch");
    await message(page, "批量上传完成");
    const result = await statuses(page);
    assert.equal(result[0], "成功");
    assert.match(result[1]!, /^失败：/);
    assert.equal(result[2], "成功");
    assert.match(await page.getAttribute("#message", "class") ?? "", /error/);
    assert.match(await page.textContent("#message") ?? "", /成功 2 个，失败 1 个/);
    // The list and quota panel were refreshed.
    await page.waitForFunction(
      (n) => document.querySelectorAll(".media-item").length === n,
      before + 2,
    );
    assert.match(await page.textContent("#media-usage") ?? "", new RegExp(`文件数量：${before + 2} /`));
    assert.equal(await count(), before + 2);
    const alts = (
      await f.pool.query("SELECT alt FROM media WHERE site_id='atlas' ORDER BY created_at")
    ).rows.map((r) => r.alt);
    assert.ok(alts.includes("日出") && alts.includes("night sky"));
    assert.ok(!alts.includes("unwanted"));
  } finally {
    await editor.close();
  }
});

test("P8 batch upload stops the remaining files on a quota error", async () => {
  const before = await count();
  await f.app.limits.save(f.admin, { site: "atlas", mediaFiles: before + 1 });
  const editor = await f.browse(f.editor, "#media/atlas");
  try {
    const { page } = editor;
    await page.waitForSelector("#media-batch-files");
    await page.setInputFiles("#media-batch-files", [
      file("q1.png", 111),
      file("q2.png", 112),
      file("q3.png", 113),
    ]);
    await page.click("#start-batch");
    await message(page, "配额不足，已停止上传剩余文件");
    const result = await statuses(page);
    assert.equal(result[0], "成功");
    assert.match(result[1]!, /^失败：媒体文件数量已达上限/);
    assert.match(result[2]!, /^未上传/);
    assert.equal(await count(), before + 1);
  } finally {
    await editor.close();
    await f.app.limits.save(f.admin, { site: "atlas", mediaFiles: null });
  }
});

test("P8 replace, history, restore and version deletion from the media page", async () => {
  const item = await upload(200);
  const editor = await f.browse(f.editor, "#media/atlas");
  try {
    const { page } = editor;
    page.on("dialog", (dialog) => dialog.accept());
    await page.waitForSelector(card(item.id));
    assert.equal((await page.textContent(`${card(item.id)} .media-version`))?.trim(), "v1");
    // Replace: explains publication freezing, then becomes v2.
    await page.click(`${card(item.id)} .replace-media`);
    await page.waitForSelector("#media-replace:not([hidden])");
    assert.match(await page.textContent("#media-replace") ?? "", /已发布的页面仍显示发布时的版本/);
    await page.setInputFiles("#replace-file", file("new.png", 201));
    await page.fill("#replace-alt", "新封面");
    await page.click("#confirm-replace");
    await message(page, "已替换为 v2");
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.trim() === "v2",
      `${card(item.id)} .media-version`,
    );
    assert.equal(await page.isHidden("#media-replace"), true);
    assert.equal(await current(item.id), 2);
    // History lists both versions, newest first, with the current one labelled.
    await openHistory(page, item.id);
    assert.deepEqual(
      await page.$$eval("#media-history .version-row", (rows) =>
        rows.map((r) => (r as HTMLElement).dataset.version),
      ),
      ["2", "1"],
    );
    assert.deepEqual(await labels(page, 2), ["当前"]);
    assert.deepEqual(await labels(page, 1), []);
    assert.match(await page.textContent(row(1)) ?? "", /editor@example\.test|owner@example\.test/);
    assert.equal(await page.locator(`${row(2)} .restore-version`).count(), 0);
    assert.equal(await page.isDisabled(`${row(2)} .delete-version`), true);
    assert.match((await page.getAttribute(`${row(2)} .delete-version`, "title")) ?? "", /当前版本/);
    assert.match((await page.getAttribute(`${row(1)} img`, "src")) ?? "", /\/versions\/1\/file$/);
    // Restore v1 creates v3 and keeps the history open.
    await page.click(`${row(1)} .restore-version`);
    await message(page, "已将 v1 设为当前版本（新版本 v3）");
    await page.waitForSelector(row(3));
    assert.deepEqual(await labels(page, 3), ["当前", "由 v1 恢复"]);
    assert.equal(
      (await page.textContent(`${card(item.id)} .media-version`))?.trim(),
      "v3",
    );
    // Delete the non-current, unpinned v2.
    assert.equal(await page.isEnabled(`${row(2)} .delete-version`), true);
    await page.click(`${row(2)} .delete-version`);
    await message(page, "v2 已删除");
    await page.waitForFunction(
      () => document.querySelectorAll("#media-history .version-row").length === 2,
    );
    assert.deepEqual(await versions(item.id), [1, 3]);
    assert.equal(await page.isDisabled(`${row(3)} .delete-version`), true);
  } finally {
    await editor.close();
  }
});

test("P8 pinned versions cannot be deleted and a stale delete shows the server error", async () => {
  const item = await upload(300);
  await publishWith("pinned-ui", item.id);
  await replace(item.id, 301);
  const editor = await f.browse(f.editor, "#media/atlas");
  try {
    const { page } = editor;
    page.on("dialog", (dialog) => dialog.accept());
    await page.waitForSelector(card(item.id));
    await openHistory(page, item.id);
    assert.deepEqual(await labels(page, 1), ["已发布", "被内容引用"]);
    assert.deepEqual(await labels(page, 2), ["当前"]);
    assert.equal(await page.isDisabled(`${row(1)} .delete-version`), true);
    assert.match((await page.getAttribute(`${row(1)} .delete-version`, "title")) ?? "", /引用/);
    assert.equal(await page.isDisabled(`${row(2)} .delete-version`), true);
    // Simulate a stale page where the button is still enabled: the 409 is reported.
    await page.$eval(`${row(1)} .delete-version`, (button) => {
      delete (button as HTMLButtonElement).dataset.locked;
      (button as HTMLButtonElement).disabled = false;
    });
    await page.click(`${row(1)} .delete-version`);
    await page.waitForFunction(() =>
      document.querySelector("#message")?.className.includes("error"),
    );
    assert.deepEqual(await versions(item.id), [1, 2]);
    await page.waitForSelector(row(1));
    assert.equal(await page.isDisabled(`${row(1)} .delete-version`), true);
  } finally {
    await editor.close();
  }
});

test("P8 viewer can browse history but mutations are rejected with an error", async () => {
  const item = await upload(400);
  await replace(item.id, 401);
  const viewer = await f.browse(f.viewer, "#media/atlas");
  try {
    const { page } = viewer;
    page.on("dialog", (dialog) => dialog.accept());
    await page.waitForSelector(card(item.id));
    assert.equal((await page.textContent(`${card(item.id)} .media-version`))?.trim(), "v2");
    await openHistory(page, item.id);
    assert.equal(await page.locator("#media-history .version-row").count(), 2);
    await page.click(`${row(1)} .restore-version`);
    await page.waitForFunction(() =>
      document.querySelector("#message")?.className.includes("error"),
    );
    assert.equal(await current(item.id), 2);
    // The page stays usable after the rejected request.
    assert.equal(await page.isEnabled(`${row(1)} .restore-version`), true);
    assert.deepEqual(await versions(item.id), [1, 2]);
  } finally {
    await viewer.close();
  }
});
