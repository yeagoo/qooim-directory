// M14a: sitemap pages and lastmod, sitemap index for large sites, RSS feeds, alternatives.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../../src/domain/config.js";
import { candidateSchema } from "../../src/server/content.js";
import { rssXml, sitemapIndexXml, sitemapXml } from "../../src/ui/directory.js";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;
let path = "";
const ORIGIN = "https://atlas.p6.test";
const get = (p: string) => f.app.respond(new Request(ORIGIN + p, { headers: { host: "atlas.p6.test" } }));
const text = async (p: string, status = 200) => {
  const response = await get(p);
  assert.equal(response.status, status, p);
  return await response.text();
};
async function publish(id: string, categoryId: string | null, tagIds: string[], locales: ("zh" | "en")[] = ["zh", "en"]) {
  await f.app.content.saveResource(f.admin, {
    id,
    expectedVersion: 0,
    public: true,
    data: {
      url: `https://example.com/${id}`,
      source: "manual",
      translations: {
        zh: { title: `${id} 标题`, description: `${id} <说明>`, tagline: `${id} 口号` },
        en: { title: `${id} title`, description: `${id} description` },
      },
    },
  });
  for (const locale of locales) {
    await f.app.content.stage(f.admin, "atlas", id, locale, {
      candidate: { resourceVersion: 1, slug: id, categoryId, ...(tagIds.length ? { tagIds } : {}) },
      expected: { published: 0, draft: 0 },
    });
    await f.app.content.publish(f.admin, "atlas", id, locale, {
      expected: { published: 0, draft: 1 },
      operationId: randomUUID(),
    });
  }
}

before(async () => {
  f = await setup();
  const snapshot = await f.app.sites.export(f.admin, "atlas");
  snapshot.config = configSchema.parse({ ...snapshot.config, locales: ["zh", "en"], tagline: "好工具" });
  await f.app.sites.save(f.admin, "atlas", snapshot, { revision: 0, draftVersion: 0 });
  await f.app.sites.publish(f.admin, "atlas", { revision: 0, draftVersion: 1 }, randomUUID());
  path = (await f.pool.query("SELECT config->>'catalogPath' AS p FROM site WHERE id='atlas'")).rows[0].p;
  for (const [id, zh, en] of [
    ["design", "设计", "Design"],
    ["dev", "开发", "Dev"],
  ])
    await f.app.content.saveCategory(f.admin, "atlas", { id, labels: { zh, en }, expectedVersion: 0 });
  await f.app.content.saveTag(f.admin, "atlas", { id: "free", labels: { zh: "免费", en: "Free" }, expectedVersion: 0 });
  await publish("figma", "design", ["free"]);
  await publish("penpot", "design", ["free"]);
  await publish("sketch", "design", []);
  await publish("vscode", "dev", ["free"]);
  await publish("vim", "dev", [], ["zh"]);
  await f.app.content.saveCollection(f.admin, "atlas", {
    id: "hot",
    labels: { zh: "热门", en: "Hot" },
    items: ["figma"],
    expectedVersion: 0,
  });
});
after(async () => {
  await f?.close();
});

test("P14 sitemap lists home, catalog and term pages per language, and items with lastmod", async () => {
  const xml = await text("/sitemap.xml");
  assert.match(xml, /^<\?xml[^>]*><urlset /);
  for (const loc of [
    `${ORIGIN}/`,
    `${ORIGIN}/zh/${path}`,
    `${ORIGIN}/en/${path}`,
    `${ORIGIN}/zh/${path}/category/design`,
    `${ORIGIN}/en/${path}/category/dev`,
    `${ORIGIN}/zh/${path}/tag/free`,
    `${ORIGIN}/zh/${path}/collection/hot`,
  ])
    assert.ok(xml.includes(`<loc>${loc}</loc>`), loc);
  // The basic template has no locale home page.
  assert.equal(xml.includes(`<loc>${ORIGIN}/en</loc>`), false);
  assert.match(
    xml,
    new RegExp(`<url><loc>${ORIGIN}/zh/${path}/figma</loc><lastmod>\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ</lastmod><xhtml:link rel="alternate" hreflang="en"`),
  );
  // vim is Chinese only: no English entry and no category page for it in English.
  assert.equal(xml.includes(`/en/${path}/vim`), false);
  assert.equal((await get("/sitemap-1.xml")).status, 404);
});

test("P14 RSS feed lists the newest entries of one language", async () => {
  const response = await get("/zh/feed.xml");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/rss\+xml/);
  const xml = await response.text();
  assert.match(xml, /<rss version="2.0"/);
  assert.match(xml, new RegExp(`<link>${ORIGIN}/zh/${path}</link>`));
  // Newest first: vim was published last.
  assert.ok(xml.indexOf(`/zh/${path}/vim<`) < xml.indexOf(`/zh/${path}/figma<`));
  // Tagline preferred, text escaped.
  assert.match(xml, /<description>figma 口号<\/description>/);
  assert.match(await text("/en/feed.xml"), /figma description/);
  assert.doesNotMatch(await text("/en/feed.xml"), /vim/);
  assert.match(await text("/zh/feed.xml"), /<pubDate>[A-Z][a-z]{2}, /);
});

test("P14 alternatives rank shared categories above shared tags and exclude the entry", async () => {
  const items = await f.app.catalog.alternatives(
    await f.app.catalog.resolve("atlas.p6.test"),
    "zh",
    "figma",
  );
  // penpot shares category+tag (3), sketch the category (2), vscode only the tag (1).
  assert.deepEqual(
    items.map((i) => i.slug),
    ["penpot", "sketch", "vscode"],
  );
  // The basic template does not render alternatives pages.
  await text(`/zh/${path}/figma/alternatives`, 404);
  await text(`/en/${path}/vscode/alternatives`, 404);
  await text(`/zh/${path}/missing/alternatives`, 404);
  await text(`/zh/${path}/figma/other`, 404);
});

test("P14 reserved entry slugs are rejected and term routes win over alternatives", async () => {
  assert.throws(
    () => candidateSchema.parse({ resourceVersion: 1, slug: "category" }),
    /保留路径/,
  );
  // Simulate an old draft row that predates the reserve list: the term route still wins.
  await publish("legacy", "design", []);
  await f.pool.query(
    "UPDATE publication SET slug='category' WHERE site_id='atlas' AND resource_id='legacy' AND locale='zh'",
  );
  assert.equal((await get(`/zh/${path}/category`)).status, 200);
  assert.equal((await get(`/zh/${path}/category/alternatives`)).status, 404);
});

test("P14 sitemap and RSS strip characters XML 1.0 forbids", () => {
  const rss = rssXml({
    title: "Feed\u0001 title",
    link: "https://example.test/feed",
    self: "https://example.test/feed.xml",
    description: "tag\u000Bline",
    language: "zh",
    items: [
      {
        title: "A\u0002B\uFFFE",
        link: "https://example.test/a\u0003",
        description: "line\u0004",
        published: null,
      },
    ],
  });
  assert.doesNotMatch(rss, /[\u0001-\u0004\u000B\uFFFE]/);
  assert.match(rss, /<title>Feed title<\/title>/);
  assert.match(rss, /<description>tagline<\/description>/);
  const sitemap = sitemapXml([
    {
      loc: "https://example.test/a\u0005",
      alternates: [{ locale: "zh", href: "https://example.test/zh/a\u0006" }],
    },
  ]);
  const index = sitemapIndexXml(["https://example.test/sitemap-1.xml\u0007"]);
  assert.doesNotMatch(sitemap, /[\u0005\u0006]/);
  assert.doesNotMatch(index, /\u0007/);
});

// Last: it leaves 45k unpublished rows behind.
test("P14 large sites get a sitemap index with numbered parts", async () => {
  // Fake a large catalog by publishing many rows directly into publication.
  await f.pool.query(
    `INSERT INTO resource(id,internal_note,public,version,data)
     SELECT 'bulk-'||g,'',true,1,'{}' FROM generate_series(1,45010) g`,
  );
  await f.pool.query(
    `INSERT INTO publication(site_id,resource_id,locale,slug,title,status,version,first_published_at,published_at)
     SELECT 'atlas','bulk-'||g,'zh','bulk-'||g,'Bulk '||g,'published',1,now(),now() FROM generate_series(1,45010) g`,
  );
  try {
    const index = await text("/sitemap.xml");
    assert.match(index, /<sitemapindex /);
    assert.ok(index.includes(`<loc>${ORIGIN}/sitemap-1.xml</loc>`));
    assert.ok(index.includes(`<loc>${ORIGIN}/sitemap-2.xml</loc>`));
    assert.equal(index.includes("sitemap-3.xml"), false);
    const first = await text("/sitemap-1.xml");
    assert.equal(first.match(/<url>/g)?.length, 45000);
    const second = await text("/sitemap-2.xml");
    assert.ok((second.match(/<url>/g)?.length ?? 0) > 0);
    assert.equal((await get("/sitemap-3.xml")).status, 404);
  } finally {
    // Unpublishing is fast; deleting 45k publications is not and nothing needs it.
    await f.pool.query("UPDATE publication SET status='draft' WHERE resource_id LIKE 'bulk-%'");
  }
  assert.match(await text("/sitemap.xml"), /^<\?xml[^>]*><urlset /);
});
