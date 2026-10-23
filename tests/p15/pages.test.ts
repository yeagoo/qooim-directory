// M15 static pages: config validation, fallback/toolso rendering, routing, SEO and sitemap entries.
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { configSchema, type Config } from "../../src/domain/config.js";
import { setup, type Fixture } from "../p6/helpers.js";
import { seedToolso } from "../p12/helpers.js";

const ATLAS = "atlas.p6.test";
const NOTES = "notes.p6.test";
const ATLAS_ORIGIN = "https://" + ATLAS;
const NOTES_ORIGIN = "https://" + NOTES;
const XSS = `<script>alert("pages")</script>`;
const pages = {
  about: {
    zh: {
      title: "关于我们",
      content: `# 关于我们\n\n第一段 **重点** 与 ${XSS}。\n\n第二段只有文字。`,
    },
    en: {
      title: "About us",
      content: "# About us\n\nFirst paragraph.\n\nSecond paragraph.",
    },
  },
  privacy: {
    zh: { title: "隐私政策", content: "我们只收集运行服务所需的信息。" },
  },
  contact: {
    en: { title: "Contact", content: "Email us at hello@example.test." },
  },
};

let f: Fixture;
const get = (host: string, path: string) =>
  f.app.respond(new Request(`https://${host}${path}`, { headers: { host } }));
const html = async (host: string, path: string, status = 200) => {
  const response = await get(host, path);
  assert.equal(response.status, status, path);
  return await response.text();
};

async function configure(site: string, mutate: (config: Config) => Config) {
  const row = (
    await f.pool.query(
      "SELECT revision,draft_version,config FROM site WHERE id=$1",
      [site],
    )
  ).rows[0];
  const config = configSchema.parse(mutate(row.config));
  const draft = await f.app.sites.save(
    f.admin,
    site,
    {
      schemaVersion: 1,
      kind: "draft",
      siteId: site,
      baseRevision: row.revision,
      config,
    },
    { revision: row.revision, draftVersion: row.draft_version },
  );
  await f.app.sites.publish(
    f.admin,
    site,
    { revision: row.revision, draftVersion: draft },
    randomUUID(),
  );
  f.app.catalog.invalidate(site);
}

before(async () => {
  f = await setup();
  await configure("notes", (config) => ({
    ...config,
    locales: ["zh", "en"],
    pages,
  }));
  await seedToolso(f);
  await configure("atlas", (config) => ({ ...config, pages }));
});
after(async () => {
  await f?.close();
});

test("P15 site config accepts optional pages and rejects oversized or unknown entries", () => {
  const base = {
    name: "Atlas",
    template: "basic",
    locales: ["zh"] as ("zh" | "en")[],
  };
  assert.deepEqual(configSchema.parse(base).pages, {});
  assert.deepEqual(configSchema.parse({ ...base, pages }).pages, pages);
  assert.throws(() =>
    configSchema.parse({
      ...base,
      pages: { about: { zh: { title: "x".repeat(101), content: "ok" } } },
    }),
  );
  assert.throws(() =>
    configSchema.parse({
      ...base,
      pages: { about: { zh: { title: "ok", content: "x".repeat(20001) } } },
    }),
  );
  assert.throws(() =>
    configSchema.parse({
      ...base,
      pages: { cookies: { zh: { title: "Cookies", content: "nope" } } },
    }),
  );
});

test("P15 basic template uses the escaped fallback with canonical and hreflang", async () => {
  const body = await html(NOTES, "/zh/about");
  assert.match(body, /<h1>关于我们<\/h1>/);
  assert.match(body, /第一段 \*\*重点\*\* 与 &lt;script&gt;alert\(&quot;pages&quot;\)&lt;\/script&gt;。/);
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /noindex/);
  assert.match(body, new RegExp(`<link rel="canonical" href="${NOTES_ORIGIN}/zh/about"`));
  assert.match(body, new RegExp(`<link rel="alternate" hreflang="en" href="${NOTES_ORIGIN}/en/about"`));
});

test("P15 toolso renders configured Markdown with chrome, footer links and page SEO", async () => {
  const body = await html(ATLAS, "/zh/about");
  assert.match(body, /<h1[^>]*>关于我们<\/h1>/);
  assert.match(body, /<strong>重点<\/strong>/);
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /\sstyle="/);
  assert.match(body, /Atlas 工具/);
  assert.ok(body.includes('href="/zh/privacy"'));
  assert.equal(body.includes('href="/zh/contact"'), false);
  assert.match(body, new RegExp(`<link rel="canonical" href="${ATLAS_ORIGIN}/zh/about"`));
  assert.match(body, new RegExp(`hrefLang="en" href="${ATLAS_ORIGIN}/en/about"`));
  assert.match(body, new RegExp(`hrefLang="x-default" href="${ATLAS_ORIGIN}/zh/about"`));

  const english = await html(ATLAS, "/en/about");
  assert.match(english, /<h1[^>]*>About us<\/h1>/);
  assert.ok(english.includes('href="/en/contact"'));
  assert.equal(english.includes('href="/en/privacy"'), false);
});

test("P15 static pages are 404 when absent in the requested locale or key", async () => {
  await html(ATLAS, "/en/privacy", 404);
  await html(NOTES, "/en/privacy", 404);
  await html(ATLAS, "/zh/contact", 404);
  await html(ATLAS, "/zh/terms", 404);
  await html(ATLAS, "/zh/not-a-page", 404);
});

test("P15 sitemap lists only configured page locales with their alternates", async () => {
  const sitemap = await html(ATLAS, "/sitemap.xml");
  assert.ok(sitemap.includes(`<loc>${ATLAS_ORIGIN}/zh/about</loc>`));
  assert.ok(sitemap.includes(`<loc>${ATLAS_ORIGIN}/en/about</loc>`));
  assert.ok(sitemap.includes(`<loc>${ATLAS_ORIGIN}/zh/privacy</loc>`));
  assert.ok(sitemap.includes(`<loc>${ATLAS_ORIGIN}/en/contact</loc>`));
  assert.equal(sitemap.includes(`<loc>${ATLAS_ORIGIN}/en/privacy</loc>`), false);
  assert.equal(sitemap.includes(`<loc>${ATLAS_ORIGIN}/zh/contact</loc>`), false);
  assert.match(
    sitemap,
    new RegExp(`<loc>${ATLAS_ORIGIN}/zh/about</loc><xhtml:link rel="alternate" hreflang="zh" href="${ATLAS_ORIGIN}/zh/about"/><xhtml:link rel="alternate" hreflang="en" href="${ATLAS_ORIGIN}/en/about"/>`),
  );
});

test("P15 a catalog path matching a page key wins over the static page", async () => {
  await configure("notes", (config) => ({ ...config, catalogPath: "about" }));
  try {
    const body = await html(NOTES, "/zh/about");
    assert.match(body, /<form class="search"/);
    assert.doesNotMatch(body, /<h1>关于我们<\/h1>/);
    assert.match(body, new RegExp(`<link rel="canonical" href="${NOTES_ORIGIN}/zh/about"`));
  } finally {
    await configure("notes", (config) => ({ ...config, catalogPath: "tools" }));
  }
});

test("P15 a published config from before pages existed still serves public routes", async () => {
  const row = (
    await f.pool.query("SELECT config FROM site WHERE id='notes'")
  ).rows[0];
  await f.pool.query("UPDATE site SET config=config-'pages' WHERE id='notes'");
  f.app.catalog.invalidate("notes");
  try {
    const sitemap = await html(NOTES, "/sitemap.xml");
    assert.match(sitemap, /^<\?xml[^>]*><urlset /);
    assert.equal(sitemap.includes(`${NOTES_ORIGIN}/zh/about`), false);
    await html(NOTES, "/zh/about", 404);
  } finally {
    await f.pool.query("UPDATE site SET config=$1 WHERE id='notes'", [row.config]);
    f.app.catalog.invalidate("notes");
  }
});
