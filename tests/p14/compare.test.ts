// M14b: reviewed "A vs B" comparisons: storage, visibility, routes and the AI "compare" kind.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../../src/domain/config.js";
import { setup, type Fixture } from "../p6/helpers.js";
import { AiWorker, COMPARE_SYSTEM_PROMPT, type AiTransport } from "../../src/server/ai.js";

let f: Fixture;
let path = "";
const ORIGIN = "https://atlas.p6.test";
const get = (p: string) => f.app.respond(new Request(ORIGIN + p, { headers: { host: "atlas.p6.test" } }));
const save = (input: Record<string, unknown>, actor = f.admin) =>
  f.app.content.saveComparison(actor, "atlas", input);

before(async () => {
  f = await setup();
  const snapshot = await f.app.sites.export(f.admin, "atlas");
  snapshot.config = configSchema.parse({ ...snapshot.config, locales: ["zh", "en"] });
  await f.app.sites.save(f.admin, "atlas", snapshot, { revision: 0, draftVersion: 0 });
  await f.app.sites.publish(f.admin, "atlas", { revision: 0, draftVersion: 1 }, randomUUID());
  path = (await f.pool.query("SELECT config->>'catalogPath' AS p FROM site WHERE id='atlas'")).rows[0].p;
  for (const [id, locales] of [
    ["figma", ["zh", "en"]],
    ["penpot", ["zh", "en"]],
    ["sketch", ["zh"]],
  ] as const) {
    await f.app.content.saveResource(f.admin, {
      id,
      expectedVersion: 0,
      public: true,
      data: {
        url: `https://example.com/${id}`,
        source: "manual",
        translations: {
          zh: { title: `${id} 标题`, description: `${id} 说明` },
          en: { title: `${id} title`, description: `${id} description` },
        },
      },
    });
    for (const locale of locales) {
      await f.app.content.stage(f.admin, "atlas", id, locale, {
        candidate: { resourceVersion: 1, slug: id },
        expected: { published: 0, draft: 0 },
      });
      await f.app.content.publish(f.admin, "atlas", id, locale, {
        expected: { published: 0, draft: 1 },
        operationId: randomUUID(),
      });
    }
  }
});
after(async () => {
  await f?.close();
});

test("P14 comparisons are stored per language under a stable pair id", async () => {
  const saved = await save({
    locale: "zh",
    resourceA: "penpot",
    resourceB: "figma",
    title: "Figma 对比 Penpot",
    content: "## 区别\n\n| | Figma | Penpot |\n|---|---|---|\n| 开源 | 否 | 是 |",
    published: true,
    expectedVersion: 0,
  });
  assert.deepEqual(saved, { id: "figma-vs-penpot", version: 1 });
  await assert.rejects(
    save({ locale: "zh", resourceA: "figma", resourceB: "penpot", title: "x", expectedVersion: 0 }),
    /version changed/,
  );
  await assert.rejects(save({ locale: "zh", resourceA: "figma", resourceB: "figma", title: "x", expectedVersion: 0 }));
  await assert.rejects(
    save({ locale: "zh", resourceA: "figma", resourceB: "nope", title: "x", expectedVersion: 0 }),
    /不存在的资源/,
  );
  await assert.rejects(
    save({ locale: "en", resourceA: "figma", resourceB: "penpot", title: "x", published: true, expectedVersion: 0 }),
    /正文/,
  );
  await assert.rejects(
    save({ locale: "zh", resourceA: "figma", resourceB: "sketch", title: "x", expectedVersion: 0 }, f.viewer),
  );
  // Editors may write comparisons.
  assert.equal(
    (await save({ locale: "zh", resourceA: "figma", resourceB: "sketch", title: "草稿", expectedVersion: 0 }, f.editor)).version,
    1,
  );
  const rows = await (await f.api("/content/atlas/comparisons")).json();
  assert.deepEqual(
    rows.map((r: { id: string; status: string }) => [r.id, r.status]),
    [
      ["figma-vs-penpot", "published"],
      ["figma-vs-sketch", "draft"],
    ],
  );
});

test("P14 a pair that maps to an existing comparison id is rejected", async () => {
  for (const id of ["a", "b-vs-c", "a-vs-b", "c"])
    await f.app.content.saveResource(f.admin, {
      id,
      expectedVersion: 0,
      public: true,
      data: {
        url: `https://example.com/${id}`,
        source: "manual",
        translations: {
          zh: { title: `${id} 标题`, description: `${id} 说明` },
          en: { title: `${id} title`, description: `${id} description` },
        },
      },
    });
  assert.equal(
    (await save({
      locale: "zh",
      resourceA: "a",
      resourceB: "b-vs-c",
      title: "first",
      expectedVersion: 0,
    })).id,
    "a-vs-b-vs-c",
  );
  await assert.rejects(
    save({
      locale: "zh",
      resourceA: "a-vs-b",
      resourceB: "c",
      title: "collision",
      expectedVersion: 0,
    }),
    (error: { status?: number; message?: string }) =>
      error.status === 409 && /对比标识与已有对比冲突/.test(error.message ?? ""),
  );
  const rows = (
    await f.pool.query(
      "SELECT resource_a,resource_b FROM comparison WHERE site_id='atlas' AND locale='zh' AND id='a-vs-b-vs-c'",
    )
  ).rows;
  assert.deepEqual(rows, [{ resource_a: "a", resource_b: "b-vs-c" }]);
});

test("P14 the basic template serves published comparisons only (M16)", async () => {
  assert.equal((await get(`/en/${path}/compare/figma-vs-penpot`)).status, 404);
  assert.equal((await get(`/zh/${path}/compare/figma-vs-penpot`)).status, 200);
  // Drafts are private.
  assert.equal((await get(`/zh/${path}/compare/figma-vs-sketch`)).status, 404);
  assert.equal((await get(`/zh/${path}/compare/penpot-vs-figma`)).status, 404);
  const detail = await (await f.app.respond(new Request(`${ORIGIN}/api/items/zh/figma`, { headers: { host: "atlas.p6.test" } }))).json();
  assert.equal(detail.slug, "figma");
  const sitemap = await (await get("/sitemap.xml")).text();
  assert.equal(sitemap.includes(`/zh/${path}/compare/figma-vs-penpot`), true);
  // Unpublishing one entry hides the comparison everywhere.
  await f.pool.query("UPDATE publication SET status='draft' WHERE resource_id='penpot' AND locale='zh'");
  try {
    assert.equal((await get(`/zh/${path}/compare/figma-vs-penpot`)).status, 404);
    assert.equal((await (await get("/sitemap.xml")).text()).includes("figma-vs-penpot"), false);
  } finally {
    await f.pool.query("UPDATE publication SET status='published' WHERE resource_id='penpot' AND locale='zh'");
  }
});

test("P14 the compare AI kind returns a title and Markdown body", async () => {
  await f.app.ai.saveConfig(f.admin, {
    site: "atlas",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "m",
    enabled: true,
    monthlyTokens: 100000,
    key: "sk-test-12345678",
  });
  const calls: Parameters<AiTransport>[0][] = [];
  const output = { title: "Figma vs Penpot", content: "## Overview\n\nBoth design tools." };
  const transport: AiTransport = async (request) => {
    calls.push(request);
    return { output, tokensIn: 1, tokensOut: 1, model: "m" };
  };
  const job = (await f.app.ai.create(f.editor, {
    site: "atlas",
    kind: "compare",
    locale: "en",
    title: "Figma vs Penpot",
    description: "A: Figma\nB: Penpot",
    brief: "",
  })) as { id: string };
  await new AiWorker(f.pool, f.key, transport).runOnce();
  const row = (await f.pool.query("SELECT status,output FROM ai_job WHERE id=$1", [job.id])).rows[0];
  assert.equal(row.status, "done");
  assert.deepEqual(row.output, output);
  assert.equal(calls[0].messages[0].content, COMPARE_SYSTEM_PROMPT);
  assert.equal(calls[0].maxTokens, 4000);
  const { comparisonFacts } = await import("../../src/ui/content-admin.js");
  const facts = comparisonFacts(
    "A",
    { id: "figma", data: { url: "https://figma.com", pricing: "freemium", translations: { en: { title: "Figma", description: "Design", pros: ["fast"] } } } },
    "en",
  );
  assert.equal(facts, "A: Figma\nDesign\nhttps://figma.com\npricing: freemium\npros: fast");
  assert.throws(() => comparisonFacts("B", { id: "x", data: { translations: {} } }, "en"));
});
