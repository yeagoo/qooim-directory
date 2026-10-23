// M13b admin: the collection editor and AI enrichment written to the master, in Chromium.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { AiWorker, type AiTransport } from "../../src/server/ai.js";

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
      translations: { zh: { title: "Figma", description: "在线设计工具" } },
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
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    enabled: true,
    monthlyTokens: 100000,
    key: "sk-test-12345678",
  });
});
after(async () => {
  await f?.close();
});

test("P13 admin writes an AI enrichment into a new master version", async () => {
  const output = { tagline: "一起设计", features: ["实时协作"], faqs: [{ question: "免费吗？", answer: "有免费版。" }] };
  const transport: AiTransport = async () => ({ output, tokensIn: 1, tokensOut: 1, model: "m" });
  const worker = new AiWorker(f.pool, f.key, transport);
  const session = await f.browse(f.admin, "#content/atlas");
  const { page } = session;
  let polling = true;
  // Stands in for the background worker while the page polls the job.
  const loop = (async () => {
    while (polling) {
      await worker.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  try {
    await page.locator(".edit-publication").first().click();
    await page.locator("#ai-kind").selectOption("enrich");
    await page.locator("#ai-run").click();
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>("#ai-apply");
      return button && !button.disabled && button.textContent === "写入主档新版本";
    });
    assert.deepEqual(JSON.parse(await page.locator("#ai-result").textContent() ?? "{}"), output);
    await page.locator("#ai-apply").click();
    await page.waitForFunction(() => document.querySelector("#ai-result")?.textContent?.startsWith("已写入主档"));
    const master = (await f.pool.query("SELECT version,data FROM resource WHERE id='figma'")).rows[0];
    assert.equal(master.version, 2);
    assert.deepEqual(master.data.translations.zh, {
      title: "Figma",
      description: "在线设计工具",
      ...output,
    });
    // The job was created from the master's own text and URL.
    const job = (await f.pool.query("SELECT kind,payload FROM ai_job ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.equal(job.kind, "enrich");
    assert.equal(job.payload.title, "Figma");
    assert.equal(job.payload.url, "https://figma.com");
  } finally {
    polling = false;
    await loop;
    await session.close();
  }
});

test("P13 enrichment refuses to overwrite a master changed after generation", async () => {
  const output = { tagline: "竞态口号", features: ["竞态"] };
  const transport: AiTransport = async () => ({ output, tokensIn: 1, tokensOut: 1, model: "m" });
  const worker = new AiWorker(f.pool, f.key, transport);
  const session = await f.browse(f.admin, "#content/atlas");
  const { page } = session;
  let polling = true;
  const loop = (async () => {
    while (polling) {
      await worker.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  try {
    await page.locator(".edit-publication").first().click();
    await page.locator("#ai-kind").selectOption("enrich");
    await page.locator("#ai-run").click();
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>("#ai-apply");
      return button && !button.disabled && button.textContent === "写入主档新版本";
    });
    const current = (await f.pool.query("SELECT version,data,public,internal_note FROM resource WHERE id='figma'")).rows[0];
    const other = structuredClone(current.data);
    other.translations.zh.title = "另一位编辑";
    const version = await f.app.content.saveResource(f.admin, {
      id: "figma",
      expectedVersion: current.version,
      data: other,
      public: current.public,
      internalNote: current.internal_note,
    });
    await page.locator("#ai-apply").click();
    await page.waitForFunction(() => document.querySelector("#message")?.textContent === "主档在生成后已被修改，请重新生成");
    const master = (await f.pool.query("SELECT version,data FROM resource WHERE id='figma'")).rows[0];
    assert.equal(master.version, version);
    assert.equal(master.data.translations.zh.title, "另一位编辑");
    // The other writer's master is kept as it was; the stale AI fields were not merged in.
    assert.deepEqual(master.data, other);
    assert.deepEqual(JSON.parse(await page.locator("#ai-result").textContent() ?? "{}"), output);
  } finally {
    polling = false;
    await loop;
    await session.close();
  }
});

test("P13 enrichment needs a network administrator", async () => {
  const session = await f.browse(f.editor, "#content/atlas");
  try {
    const { page } = session;
    await page.locator(".edit-publication").first().click();
    await page.locator("#ai-kind").selectOption("enrich");
    await page.locator("#ai-run").click();
    await page.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("需要站群管理员"));
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM ai_job WHERE actor_id=$1", [f.editor.id])).rows[0].n, 0);
  } finally {
    await session.close();
  }
});

test("P13 admin saves a collection with its ordered items", async () => {
  const session = await f.browse(f.editor, "#content/atlas");
  try {
    const { page } = session;
    await page.locator("#collection-id").fill("hot");
    await page.locator("#collection-labels").fill('{"zh":"热门"}');
    await page.locator("#collection-descriptions").fill('{"zh":"最受欢迎"}');
    await page.locator("#collection-items").fill("figma\n");
    await page.locator("#save-collection").click();
    await page.waitForFunction(() => document.querySelector("#message")?.textContent === "榜单已保存。");
    assert.equal(await page.locator(".edit-collection").textContent(), "热门");
    const rows = await f.app.content.collections(f.admin, "atlas");
    assert.deepEqual(
      rows.map((r: { id: string; items: string[]; version: number; descriptions: unknown }) => [r.id, r.items, r.version, r.descriptions]),
      [["hot", ["figma"], 1, { zh: "最受欢迎" }]],
    );
    // A second save keeps using the version it was given.
    await page.locator("#collection-items").fill("");
    await page.evaluate(() => (document.querySelector("#message")!.textContent = ""));
    await page.locator("#save-collection").click();
    await page.waitForFunction(() => document.querySelector("#message")?.textContent === "榜单已保存。");
    assert.deepEqual((await f.app.content.collections(f.admin, "atlas"))[0].items, []);
  } finally {
    await session.close();
  }
});
