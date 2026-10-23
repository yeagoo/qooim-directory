// M14 in the toolso template: an entry's alternatives page, the link from the detail page, and the RSS link.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "../p12/helpers.js";

let f: Fixture;
async function publish(id: string, title: string, candidate: Record<string, unknown>) {
  await f.app.content.saveResource(f.admin, {
    id,
    expectedVersion: 0,
    public: true,
    data: {
      url: `https://example.com/${id}`,
      source: "manual",
      translations: { zh: { title, description: `${id} 说明` }, en: { title, description: `${id} text` } },
    },
  });
  await f.app.content.stage(f.admin, "atlas", id, "zh", {
    candidate: { resourceVersion: 1, slug: id, ...candidate },
    expected: { published: 0, draft: 0 },
  });
  await f.app.content.publish(f.admin, "atlas", id, "zh", {
    expected: { published: 0, draft: 1 },
    operationId: randomUUID(),
  });
}
before(async () => {
  f = await setup();
  // figma and penpot (category design) come from the shared seed.
  await seedToolso(f);
  for (const id of ["t1", "t2"])
    await f.app.content.saveTag(f.admin, "atlas", { id, labels: { zh: id, en: id }, expectedVersion: 0 });
  await publish("target", "目标工具", { categoryId: "design", tagIds: ["t1"] });
  await publish("both", "同类同标签", { categoryId: "design", tagIds: ["t1"] });
  await publish("tagonly", XSS, { tagIds: ["t1"] });
  await publish("lonely", "孤单工具", { tagIds: ["t2"] });
  await publish("mate", "唯一伙伴", { tagIds: ["t2"] });
});
after(async () => {
  await f?.close();
});
const html = async (path: string, status = 200) => {
  const response = await get(f, path);
  assert.equal(response.status, status, path);
  return await response.text();
};
const order = (body: string) =>
  [...body.matchAll(/href="\/zh\/tools\/([a-z0-9-]+)"/g)].map((m) => m[1]!);

test("P14 alternatives page lists entries by overlap and excludes the entry itself", async () => {
  const body = await html("/zh/tools/target/alternatives");
  assert.match(body, /<h1[^>]*>目标工具 的最佳替代品<\/h1>/);
  assert.match(body, /对比 目标工具 与 4 个最相似的 AI 工具。/);
  assert.match(body, /<a href="\/zh\/tools\/target"[^>]*>[\s\S]*?返回 目标工具<\/a>/);
  const cards = [...new Set(order(body).filter((slug) => ["both", "figma", "penpot", "tagonly", "target"].includes(slug)))];
  // Back link and breadcrumb point at the entry; among cards: category+tag, then category, then tag only.
  assert.deepEqual(cards.filter((s) => s !== "target"), ["both", "figma", "penpot", "tagonly"]);
  assert.equal(body.match(/class="surface-card group flex/g)?.length, 4);
  assert.doesNotMatch(body, /noindex/);
  assert.match(body, /<link rel="canonical" href="https:\/\/atlas\.p6\.test\/zh\/tools\/target\/alternatives"/);
  assert.match(body, /"@type":"ItemList"/);
  assert.match(body, /<title>目标工具 的最佳替代品 · Atlas 工具<\/title>/);
  assert.equal(body.includes(XSS), false);
  assert.match(body, /&lt;img src=x onerror=/);
});

test("P14 thin alternatives pages are noindex; unknown entries are 404", async () => {
  const body = await html("/zh/tools/lonely/alternatives");
  assert.match(body, /noindex/);
  assert.ok(order(body).includes("mate"));
  await html("/zh/tools/no-such-tool/alternatives", 404);
  const none = await html("/zh/tools/unsafe/alternatives");
  assert.match(none, /暂无与此工具相近的替代品。/);
});

test("P14 detail links to alternatives; pages advertise the RSS feed", async () => {
  const detail = await html("/zh/tools/target");
  assert.match(detail, /href="\/zh\/tools\/target\/alternatives"/);
  assert.match(detail, /<link type="application\/rss\+xml" rel="alternate" title="Atlas 工具" href="\/zh\/feed\.xml"/);
  for (const path of ["/zh/tools/target/alternatives", "/zh/tools/lonely/alternatives"]) {
    const body = await html(path);
    assert.doesNotMatch(body, /\sstyle="/, path);
    assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)(?![^>]*application\/ld\+json)[^>]*>/, path);
  }
});
