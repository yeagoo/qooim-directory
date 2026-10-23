// M13b in the toolso template: curated collections on the home page and collection pages.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "../p12/helpers.js";

let f: Fixture;
const LONG = 25; // one more than a page (24)

async function publish(id: string, title: string, locales: ("zh" | "en")[]) {
  await f.app.content.saveResource(f.admin, {
    id,
    expectedVersion: 0,
    data: {
      url: `https://example.com/${id}`,
      source: "manual",
      translations: Object.fromEntries(locales.map((l) => [l, { title, description: `${title} ${l}` }])),
    },
    public: true,
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
const collection = (input: Record<string, unknown>) =>
  f.app.content.saveCollection(f.admin, "atlas", { expectedVersion: 0, ...input });

before(async () => {
  f = await setup();
  await seedToolso(f);
  await publish("zhonly", "仅中文工具", ["zh"]);
  for (let i = 1; i <= LONG; i++) await publish(`long-${String(i).padStart(2, "0")}`, `长榜工具 ${i}`, ["zh"]);
  await collection({
    id: "hot",
    labels: { zh: "热门", en: "Hot" },
    descriptions: { zh: `本周最热 ${XSS}`, en: "Trending this week" },
    rank: 1,
    items: ["penpot", "figma", "zhonly"],
  });
  await collection({
    id: "picks",
    labels: { zh: `编辑精选 ${XSS}`, en: "Editor's picks" },
    rank: 0,
    items: ["figma"],
  });
  await collection({ id: "hidden", labels: { zh: "已停用", en: "Off" }, active: false, rank: -1, items: ["figma"] });
  await collection({ id: "en-label", labels: { en: "English only" }, rank: 2, items: ["figma"] });
  await collection({ id: "zh-list", labels: { zh: "中文榜", en: "Chinese list" }, rank: 3, items: ["zhonly"] });
  await collection({
    id: "long",
    labels: { zh: "长榜", en: "Long list" },
    rank: 4,
    items: Array.from({ length: LONG }, (_, i) => `long-${String(LONG - i).padStart(2, "0")}`),
  });
});
after(async () => {
  await f?.close();
});
const html = async (path: string, status = 200) => {
  const response = await get(f, path);
  assert.equal(response.status, status, path);
  return await response.text();
};
const hrefs = (body: string) => [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
const before_ = (body: string, a: string, b: string) => {
  const i = body.indexOf(a),
    j = body.indexOf(b);
  assert.ok(i >= 0, a);
  assert.ok(j >= 0, b);
  return i < j;
};

test("P13 home shows visible collections in rank order instead of the featured block", async () => {
  const body = await html("/");
  // picks (rank 0) before hot (rank 1); the home takes the first four visible collections.
  assert.ok(before_(body, 'id="collection-picks"', 'id="collection-hot"'));
  assert.ok(before_(body, 'id="collection-hot"', 'id="collection-zh-list"'));
  assert.match(body, /id="collection-long"/);
  // Inactive and unlabelled collections are hidden.
  assert.doesNotMatch(body, /collection-hidden|collection-en-label/);
  // Curated item order inside a section, and a link to the collection page.
  const hot = body.slice(body.indexOf('id="collection-hot"'), body.indexOf('id="collection-zh-list"'));
  assert.ok(before_(hot, 'href="/zh/tools/penpot"', 'href="/zh/tools/figma"'));
  assert.ok(before_(hot, 'href="/zh/tools/figma"', 'href="/zh/tools/zhonly"'));
  assert.ok(hrefs(hot).includes("/zh/tools/collection/hot"));
  assert.match(hot, />热门</);
  assert.match(hot, /查看完整榜单/);
  // The section header shows the description; the generic featured block is replaced.
  assert.match(hot, /本周最热 &lt;img src=x onerror=/);
  assert.doesNotMatch(body, />精选工具</);
  // Untrusted collection text stays escaped.
  assert.equal(body.includes(XSS), false);
  assert.match(body, /编辑精选 &lt;img src=x onerror=/);
  assert.doesNotMatch(body, /\sstyle="/);
});

test("P13 English home lists only collections with English entries and labels", async () => {
  const body = await html("/en");
  assert.match(body, /id="collection-hot"/);
  assert.match(body, />Trending this week</);
  assert.match(body, /id="collection-en-label"/);
  // zh-list and long only have Chinese entries.
  assert.doesNotMatch(body, /collection-zh-list|collection-long/);
  const hot = body.slice(body.indexOf('id="collection-hot"'));
  assert.ok(hrefs(hot).includes("/en/tools/collection/hot"));
});

test("P13 home keeps the featured block when no collection is visible", async () => {
  await f.pool.query("UPDATE collection SET active=false WHERE site_id='atlas'");
  try {
    const body = await html("/");
    assert.match(body, />精选工具</);
    assert.doesNotMatch(body, /id="collection-/);
  } finally {
    await f.pool.query("UPDATE collection SET active=(id<>'hidden') WHERE site_id='atlas'");
  }
});

test("P13 collection page: heading, description, breadcrumb, curated order and rank numbers", async () => {
  const body = await html("/zh/tools/collection/hot");
  assert.match(body, /<h1 class="type-display[^"]*">热门<\/h1>/);
  assert.match(body, /本周最热 &lt;img src=x onerror=/);
  assert.equal(body.includes(XSS), false);
  assert.match(
    body,
    /<nav aria-label="面包屑导航"[\s\S]*?href="\/zh\/tools"[^>]*>全部产品<\/a>[\s\S]*?aria-current="page"[^>]*>热门</,
  );
  assert.ok(before_(body, 'href="/zh/tools/penpot"', 'href="/zh/tools/figma"'));
  assert.ok(before_(body, 'href="/zh/tools/figma"', 'href="/zh/tools/zhonly"'));
  assert.match(body, />01</);
  assert.match(body, />03</);
  assert.match(body, /<title>热门 · Atlas 工具<\/title>/);
  assert.match(body, /<link rel="canonical" href="https:\/\/atlas\.p6\.test\/zh\/tools\/collection\/hot"/);
  assert.match(body, /<link rel="alternate" hrefLang="en" href="https:\/\/atlas\.p6\.test\/en\/tools\/collection\/hot"/);
  assert.match(body, /"@type":"ItemList"/);
  assert.doesNotMatch(body, /noindex/);
  assert.doesNotMatch(body, /\sstyle="/);
  assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)(?![^>]*application\/ld\+json)[^>]*>/);
  const en = await html("/en/tools/collection/hot");
  assert.match(en, />Hot<\/h1>/);
  assert.match(en, />Trending this week</);
});

test("P13 collection hreflang lists only locales with entries; hidden or unknown collections are 404", async () => {
  const body = await html("/zh/tools/collection/zh-list");
  assert.doesNotMatch(body, /<link rel="alternate" hrefLang="en"/);
  await html("/en/tools/collection/zh-list", 404);
  await html("/zh/tools/collection/hidden", 404);
  await html("/zh/tools/collection/en-label", 404);
  await html("/zh/tools/collection/no-such-list", 404);
});

test("P13 long collections paginate on the collection route and keep the rank numbering", async () => {
  const first = await html("/zh/tools/collection/long");
  assert.ok(hrefs(first).includes("/zh/tools/collection/long?page=2"));
  // Curated order is the reverse of the ids.
  assert.ok(before_(first, 'href="/zh/tools/long-25"', 'href="/zh/tools/long-24"'));
  const second = await html("/zh/tools/collection/long?page=2");
  assert.ok(hrefs(second).includes("/zh/tools/long-01"));
  assert.match(second, />25</);
  assert.ok(hrefs(second).includes("/zh/tools/collection/long"));
});
