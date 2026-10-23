// M13a content model: rich listing fields, per-site tags, extra categories, logos and publish times.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../../src/domain/config.js";
import { pagination, searchForm, type TemplatePage } from "../../src/public/sdk.js";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;
const basePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// The media parser reads the PNG header only; the trailing seed makes each file distinct.
const png = (seed: number) => {
  const data = Buffer.alloc(1000, 0);
  basePng.copy(data);
  data.writeUInt32BE(seed, 996);
  return { filename: `logo-${seed}.png`, mime: "image/png", data: data.toString("base64") };
};
const get = (path: string, host = "atlas.p6.test") =>
  f.app.respond(new Request(`https://${host}${path}`, { headers: { host } }));
const json = async (path: string) => {
  const response = await get(path);
  assert.equal(response.status, 200, path);
  return await response.json();
};
const rich = {
  tagline: "协作设计",
  features: ["实时协作", "原型"],
  useCases: ["界面设计"],
  pros: ["免费版够用"],
  cons: ["需要联网"],
  content: "## 概览\n\n- 一\n- 二\n",
  faqs: [{ question: "免费吗？", answer: "有免费版。" }],
};
async function resource(id: string, extra: Record<string, unknown> = {}, zh: Record<string, unknown> = {}) {
  return f.app.content.saveResource(f.admin, {
    id,
    expectedVersion: 0,
    data: {
      url: `https://example.com/${id}`,
      source: "manual",
      ...extra,
      translations: {
        zh: { title: `${id} 标题`, description: `${id} 说明`, ...zh },
        en: { title: `${id} title`, description: `${id} description` },
      },
    },
    public: true,
  });
}
async function publish(id: string, locale: "zh" | "en", candidate: Record<string, unknown>) {
  const row = (
    await f.pool.query(
      "SELECT coalesce((SELECT version FROM publication WHERE site_id='atlas' AND resource_id=$1 AND locale=$2),0) AS published, coalesce((SELECT version FROM content_draft WHERE site_id='atlas' AND resource_id=$1 AND locale=$2),0) AS draft",
      [id, locale],
    )
  ).rows[0];
  const expected = { published: row.published, draft: row.draft };
  const draft = await f.app.content.stage(f.admin, "atlas", id, locale, {
    candidate: { resourceVersion: 1, slug: id, ...candidate },
    expected,
  });
  return f.app.content.publish(f.admin, "atlas", id, locale, {
    expected: { published: expected.published, draft },
    operationId: randomUUID(),
  });
}

before(async () => {
  f = await setup();
  // Both languages on atlas (basic template).
  const snapshot = await f.app.sites.export(f.admin, "atlas");
  snapshot.config = configSchema.parse({ ...snapshot.config, locales: ["zh", "en"] });
  await f.app.sites.save(f.admin, "atlas", snapshot, { revision: 0, draftVersion: 0 });
  await f.app.sites.publish(f.admin, "atlas", { revision: 0, draftVersion: 1 }, randomUUID());
  for (const [id, zh, en] of [
    ["design", "设计", "Design"],
    ["dev", "开发", "Dev"],
  ])
    await f.app.content.saveCategory(f.admin, "atlas", { id, labels: { zh, en }, expectedVersion: 0 });
  await f.app.content.saveTag(f.admin, "atlas", { id: "free", labels: { zh: "免费", en: "Free" }, expectedVersion: 0 });
  await f.app.content.saveTag(f.admin, "atlas", { id: "zh-only", labels: { zh: "仅中文" }, expectedVersion: 0 });
  await resource("figma", { pricing: "freemium" }, rich);
  await resource("plain");
});
after(async () => {
  await f?.close();
});

test("P13 master schema accepts rich fields and rejects unknown or oversized ones", async () => {
  await assert.rejects(resource("bad-pricing", { pricing: "cheap" }));
  await assert.rejects(resource("bad-field", {}, { slogan: "x" }));
  await assert.rejects(resource("bad-faq", {}, { faqs: [{ question: "q" }] }));
  await assert.rejects(resource("bad-list", {}, { features: Array(13).fill("x") }));
  const saved = (await f.pool.query("SELECT data FROM resource WHERE id='figma'")).rows[0].data;
  assert.equal(saved.pricing, "freemium");
  assert.deepEqual(saved.translations.zh.faqs, rich.faqs);
});

test("P13 tags are per-site taxonomies with version checks", async () => {
  const tags = await (await f.api("/content/atlas/tags")).json();
  assert.deepEqual(
    tags.map((t: { id: string }) => t.id),
    ["free", "zh-only"],
  );
  const conflict = await f.api("/content/atlas/tags", {
    method: "POST",
    body: { id: "free", labels: { zh: "免费" }, expectedVersion: 0 },
  });
  assert.equal(conflict.status, 409);
  // Another site's tag is not usable here.
  await f.app.content.saveTag(f.admin, "notes", { id: "notes-tag", labels: { zh: "笔记" }, expectedVersion: 0 });
  await assert.rejects(
    f.app.content.stage(f.admin, "atlas", "plain", "zh", {
      candidate: { resourceVersion: 1, slug: "plain", tagIds: ["notes-tag"] },
      expected: { published: 0, draft: 0 },
    }),
    /标签不属于本站/,
  );
  await assert.rejects(
    f.app.content.stage(f.admin, "atlas", "plain", "zh", {
      candidate: { resourceVersion: 1, slug: "plain", extraCategoryIds: ["dev"] },
      expected: { published: 0, draft: 0 },
    }),
    /主分类/,
  );
  // The viewer can read but not write.
  await assert.rejects(
    f.app.content.saveTag(f.viewer, "atlas", { id: "nope", labels: { zh: "不行" }, expectedVersion: 0 }),
  );
});

test("P13 publishing freezes details, terms, logo and publish times", async () => {
  const media = await f.app.media.upload(f.editor, { site: "atlas", alt: "Figma 标志", ...png(1) });
  await publish("figma", "zh", {
    categoryId: "design",
    extraCategoryIds: ["dev", "design"],
    tagIds: ["free", "zh-only", "free"],
    overrides: { tagline: "本站的说法", logo: { mediaId: media.id, alt: "Figma logo" } },
  });
  await publish("figma", "en", { categoryId: "design", tagIds: ["free", "zh-only"] });
  await publish("plain", "zh", {});
  const row = (
    await f.pool.query(
      "SELECT category_ids,tag_ids,details,logo,first_published_at,published_at FROM publication WHERE site_id='atlas' AND resource_id='figma' AND locale='zh'",
    )
  ).rows[0];
  assert.deepEqual(row.category_ids, ["design", "dev"]);
  assert.deepEqual(row.tag_ids, ["free", "zh-only"]);
  assert.equal(row.details.tagline, "本站的说法");
  assert.equal(row.details.pricing, "freemium");
  assert.deepEqual(row.details.faqs, rich.faqs);
  assert.equal("title" in row.details, false);
  assert.deepEqual(row.logo, { mediaId: media.id, alt: "Figma logo", version: 1 });
  assert.ok(row.first_published_at);

  const detail = await json("/api/items/zh/figma");
  assert.deepEqual(detail.categories, [
    { id: "design", label: "设计" },
    { id: "dev", label: "开发" },
  ]);
  assert.deepEqual(detail.tags, [
    { id: "free", label: "免费" },
    { id: "zh-only", label: "仅中文" },
  ]);
  assert.equal(detail.logo.url, `/media/${media.id}/1`);
  assert.equal(detail.logo.alt, "Figma logo");
  assert.equal(detail.details.content, rich.content.trim());
  assert.match(detail.published_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // A tag without an English label is not shown on the English page.
  assert.deepEqual((await json("/api/items/en/figma")).tags, [{ id: "free", label: "Free" }]);
  // The logo is served publicly once published.
  assert.equal((await get(`/media/${media.id}/1`)).status, 200);

  // Republishing moves updated_at but keeps the first publication time.
  const before = (await f.pool.query("SELECT first_published_at FROM publication WHERE resource_id='figma' AND locale='zh'")).rows[0];
  await f.pool.query("SELECT pg_sleep(0.01)");
  await publish("figma", "zh", { categoryId: "design", tagIds: ["free"] });
  const after = (
    await f.pool.query("SELECT first_published_at,published_at FROM publication WHERE resource_id='figma' AND locale='zh'")
  ).rows[0];
  assert.equal(after.first_published_at.getTime(), before.first_published_at.getTime());
  assert.ok(after.published_at > after.first_published_at);
});

test("P13 browse filters by any category and by tag; cards omit long fields", async () => {
  await publish("figma", "zh", {
    categoryId: "design",
    extraCategoryIds: ["dev"],
    tagIds: ["free"],
  });
  const ids = (body: { items: { slug: string }[] }) => body.items.map((i) => i.slug);
  assert.deepEqual(ids(await json("/api/search?locale=zh&category=dev")), ["figma"]);
  assert.deepEqual(ids(await json("/api/search?locale=zh&tag=free")), ["figma"]);
  assert.deepEqual(ids(await json("/api/search?locale=zh&tag=zh-only")), []);
  const card = (await json("/api/search?locale=zh&tag=free")).items[0];
  assert.equal(card.details.tagline, "协作设计");
  assert.equal(card.details.pricing, "freemium");
  for (const key of ["content", "faqs", "features", "useCases", "pros", "cons"])
    assert.equal(key in card.details, false, key);
  // Category counts include extra categories; tag listing has counts too.
  const categories = await json("/api/categories?locale=zh");
  assert.deepEqual(
    categories.map((c: { id: string; count: number }) => [c.id, c.count]),
    [
      ["design", 1],
      ["dev", 1],
    ],
  );
  assert.deepEqual(await json("/api/tags?locale=zh"), [{ id: "free", label: "免费", count: 1 }]);
  // A deactivated extra category or tag drops out of listings and filters.
  await f.app.content.saveTag(f.admin, "atlas", { id: "free", labels: { zh: "免费", en: "Free" }, active: false, expectedVersion: 1 });
  await f.app.content.saveCategory(f.admin, "atlas", { id: "dev", labels: { zh: "开发", en: "Dev" }, active: false, expectedVersion: 1 });
  try {
    assert.deepEqual(await json("/api/tags?locale=zh"), []);
    assert.deepEqual(ids(await json("/api/search?locale=zh&tag=free")), []);
    assert.deepEqual(ids(await json("/api/search?locale=zh&category=dev")), []);
    // The entry itself stays visible through its active primary category.
    assert.deepEqual((await json("/api/items/zh/figma")).categories, [{ id: "design", label: "设计" }]);
  } finally {
    await f.app.content.saveTag(f.admin, "atlas", { id: "free", labels: { zh: "免费", en: "Free" }, expectedVersion: 2 });
    await f.app.content.saveCategory(f.admin, "atlas", { id: "dev", labels: { zh: "开发", en: "Dev" }, expectedVersion: 2 });
  }
});

test("P13 tag pages are routed, indexable and list hreflang only where the tag has entries", async () => {
  // atlas uses the basic template here: tag pages are a shared route.
  const catalogPath = (await f.pool.query("SELECT config->>'catalogPath' AS p FROM site WHERE id='atlas'")).rows[0].p;
  const tagPage = await get(`/zh/${catalogPath}/tag/free`);
  assert.equal(tagPage.status, 200, `/zh/${catalogPath}/tag/free`);
  const body = await tagPage.text();
  assert.doesNotMatch(body, /noindex/);
  assert.match(body, new RegExp(`rel="canonical" href="https://atlas\\.p6\\.test/zh/${catalogPath}/tag/free"`));
  // figma is tagged "free" in both languages.
  assert.match(body, new RegExp(`hreflang="en" href="https://atlas\\.p6\\.test/en/${catalogPath}/tag/free"`, "i"));
  assert.equal((await get(`/zh/${catalogPath}/tag/missing`)).status, 404);
  // zh-only has a zh label but no published entries: 404 in both languages.
  assert.equal((await get(`/zh/${catalogPath}/tag/zh-only`)).status, 404);
  // ?tag= is a filter view: noindex.
  assert.match(await (await get(`/zh/${catalogPath}?tag=free`)).text(), /noindex/);
});

test("P13 basic template keeps tags on term pagination and in the search form", () => {
  type DirectoryPage = Extract<TemplatePage, { kind: "directory" }>;
  const page = {
    site: { name: "Atlas", locales: ["zh"], navigation: [] },
    origin: "https://atlas.p6.test",
    catalogPath: "tools",
    locale: "zh",
    canonical: "https://atlas.p6.test/zh/tools/tag/free",
    alternates: [],
    noindex: false,
    kind: "directory",
    result: { total: 72, items: [], page: 2, limit: 24 },
    categories: [],
    q: "",
    tag: "free",
    tagPage: { id: "free", label: "免费", count: 72 },
  } as DirectoryPage;
  const nav = pagination(page);
  assert.match(nav, /href="\/zh\/tools\/tag\/free\?page=1"/);
  assert.match(nav, /href="\/zh\/tools\/tag\/free\?page=3"/);
  assert.match(searchForm(page), /<input type="hidden" name="tag" value="free">/);
});

test("P13 media in use as a logo cannot be deleted", async () => {
  const media = await f.app.media.upload(f.editor, { site: "atlas", alt: "logo", ...png(2) });
  await publish("plain", "zh", { overrides: { logo: { mediaId: media.id } } });
  const response = await f.api(`/media/${media.id}`, { method: "DELETE" });
  assert.equal(response.status, 409);
  // A logo from another site is rejected at staging.
  const other = await f.app.media.upload(f.admin, { site: "notes", alt: "x", ...png(3) });
  await assert.rejects(
    f.app.content.stage(f.admin, "atlas", "plain", "en", {
      candidate: { resourceVersion: 1, slug: "plain", overrides: { logo: { mediaId: other.id } } },
      expected: { published: 0, draft: 0 },
    }),
    /logo 不属于本站/,
  );
});

test("P13 deleting media re-checks references under the row lock", async () => {
  const media = await f.app.media.upload(f.editor, { site: "atlas", alt: "logo", ...png(4) });
  // A publish in progress: it holds the media row FOR SHARE (as material() does) and
  // commits a logo reference only after the delete's fast pre-check has passed.
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT version FROM media WHERE id=$1 FOR SHARE", [media.id]);
    await client.query(
      "UPDATE publication SET logo=$1 WHERE site_id='atlas' AND resource_id='figma' AND locale='zh'",
      [{ mediaId: media.id, alt: "", version: 1 }],
    );
    const deletion = f.api(`/media/${media.id}`, { method: "DELETE" });
    // Let the delete pass its pre-check and block on the row lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.query("COMMIT");
    assert.equal((await deletion).status, 409);
  } finally {
    client.release();
  }
  assert.equal((await f.pool.query("SELECT 1 FROM media WHERE id=$1", [media.id])).rowCount, 1);
  assert.equal((await get(`/media/${media.id}/1`)).status, 200);
});

test("P13 comparing a newer master keeps extra categories and tags of the published entry", async () => {
  await publish("figma", "en", { categoryId: "design", extraCategoryIds: ["dev"], tagIds: ["free"] });
  await f.pool.query("DELETE FROM content_draft WHERE site_id='atlas' AND resource_id='figma' AND locale='en'");
  const current = (await f.pool.query("SELECT version,data FROM resource WHERE id='figma'")).rows[0];
  const data = structuredClone(current.data);
  data.translations.en.tagline = "Design together";
  await f.app.content.saveResource(f.admin, { id: "figma", expectedVersion: current.version, data, public: true });
  const diff = await f.app.content.updateDiff(f.admin, "atlas", "figma", "en");
  assert.deepEqual(diff.candidate.extraCategoryIds, ["dev"]);
  assert.deepEqual(diff.candidate.tagIds, ["free"]);
  assert.deepEqual(
    diff.differences.map((d: { field: string }) => d.field),
    ["details"],
  );
  // The publication list carries the terms so the admin can rebuild the candidate.
  const rows = await f.app.content.publications(f.admin, "atlas");
  const row = rows.find((r: { id: string; locale: string }) => r.id === "figma" && r.locale === "en");
  assert.deepEqual(row.category_ids, ["design", "dev"]);
  assert.deepEqual(row.tag_ids, ["free"]);
});

test("P13 admin resource form keeps rich translation fields", async () => {
  const { applyResourceForm } = await import("../../src/ui/content-admin.js");
  const data = {
    url: "https://example.com",
    source: "manual",
    pricing: "free",
    translations: { zh: { title: "旧", description: "旧说明", tagline: "口号", faqs: rich.faqs } },
  };
  const next = applyResourceForm(data, {
    url: "https://example.org",
    zh: { title: "新", description: "新说明" },
    en: { title: "", description: "" },
  });
  assert.deepEqual(next, {
    url: "https://example.org",
    source: "manual",
    pricing: "free",
    translations: { zh: { title: "新", description: "新说明", tagline: "口号", faqs: rich.faqs } },
  });
  // Clearing both fields drops the language, including its rich fields.
  const cleared = applyResourceForm(data, {
    url: "https://example.org",
    zh: { title: "", description: "" },
    en: { title: "", description: "" },
  });
  assert.deepEqual(cleared.translations, {});
  // The input is not mutated.
  assert.equal(data.translations.zh.title, "旧");
});
