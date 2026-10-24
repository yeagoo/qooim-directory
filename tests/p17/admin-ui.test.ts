// M18 admin: persona presets and the manual copy/paste distribution flow, in Chromium.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;
before(async () => {
  f = await setup();
  await f.app.content.saveResource(f.admin, {
    id: "figma",
    expectedVersion: 0,
    public: true,
    data: {
      url: "https://figma.com",
      source: "manual",
      translations: { zh: { title: "Figma", description: "多人实时协作的在线界面设计工具" } },
    },
  });
  await f.app.content.stage(f.admin, "atlas", "figma", "zh", {
    candidate: { resourceVersion: 1, slug: "figma" },
    expected: { published: 0, draft: 0 },
  });
  await f.app.content.publish(f.admin, "atlas", "figma", "zh", {
    expected: { published: 0, draft: 1 },
    operationId: randomUUID(),
  });
});
after(async () => {
  await f?.close();
});

test("P17 admin applies a persona preset and saves it", async () => {
  const { page, close } = await f.browse(f.admin, "#persona/atlas");
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  try {
    await page.locator(".persona-preset[data-preset=review]").click();
    assert.equal(await page.locator("#persona-length").inputValue(), "long");
    await page.locator("#persona-audience").fill("正在挑选设计工具的团队");
    await page.locator("#persona-save").click();
    await page.waitForFunction(() => document.querySelector("#persona-meta")?.textContent?.includes("版本 1"));
    const saved = (await f.pool.query("SELECT data FROM site_persona WHERE site_id='atlas'")).rows[0].data;
    assert.equal(saved.audience, "正在挑选设计工具的团队");
    assert.deepEqual(saved.structure, ["总结", "优点", "不足", "适合谁"]);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test("P17 admin distributes manually: copy the prompt, paste a reply, save a draft", async () => {
  const { page, close } = await f.browse(f.admin, "#distribute/figma");
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => void d.accept());
  try {
    await page.locator(".dist-site[value=notes]").check();
    await page.locator("#dist-mode").selectOption("manual");
    await page.locator("#dist-create").click();
    await page.locator(".task-manual").first().waitFor();
    await page.locator(".task-manual").first().click();
    await page.waitForFunction(() => (document.querySelector("#manual-prompt") as HTMLTextAreaElement)?.value.includes("<data>"));
    const reply = {
      title: "用 Figma 和同伴一起做设计",
      description: "不用安装软件，打开网页就能邀请朋友共同修改作品。",
    };
    await page.locator("#manual-reply").fill("```json\n" + JSON.stringify(reply) + "\n```");
    await page.locator("#manual-preview").click();
    await page.locator("#manual-result h3").waitFor();
    assert.equal(
      (await f.pool.query("SELECT 1 FROM content_draft WHERE site_id='notes' AND resource_id='figma'")).rowCount,
      0,
    );
    await page.locator("#manual-save").click();
    await page.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("已保存为草稿"));
    const draft = (
      await f.pool.query("SELECT candidate FROM content_draft WHERE site_id='notes' AND resource_id='figma'")
    ).rows[0];
    assert.equal(draft.candidate.overrides.title, reply.title);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});
