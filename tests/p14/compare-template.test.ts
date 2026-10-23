// M14b in the toolso template: the A-vs-B comparison page and the detail page's comparisons section.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "../p12/helpers.js";

let f: Fixture;
const ORIGIN = "https://atlas.p6.test";
const MARKDOWN = [
  "Figma and Penpot are both design tools.",
  "",
  "| | Figma | Penpot |",
  "| --- | --- | --- |",
  "| Hosting | Cloud | Self-host |",
  "",
  "[bad](javascript:alert(1)) and [site](https://evil.example/x)",
  "",
  "<script>alert(1)</script>",
  "",
  "![img](https://evil.example/x.png)",
].join("\n");
const html = async (path: string, status = 200) => {
  const response = await get(f, path);
  assert.equal(response.status, status, path);
  return await response.text();
};
let id = "";
before(async () => {
  f = await setup();
  await seedToolso(f);
  const saved = await f.app.content.saveComparison(f.admin, "atlas", {
    locale: "zh",
    resourceA: "penpot",
    resourceB: "figma",
    title: "Figma vs Penpot：怎么选",
    content: MARKDOWN,
    published: true,
    expectedVersion: 0,
  });
  id = saved.id;
  // English: saved but not published.
  await f.app.content.saveComparison(f.admin, "atlas", {
    locale: "en",
    resourceA: "figma",
    resourceB: "penpot",
    title: "Figma vs Penpot",
    content: "Draft.",
    published: false,
    expectedVersion: 0,
  });
  // An XSS title on a comparison with the unsafe entry.
  await f.app.content.saveComparison(f.admin, "atlas", {
    locale: "zh",
    resourceA: "figma",
    resourceB: "unsafe",
    title: XSS,
    content: "x",
    published: true,
    expectedVersion: 0,
  });
});
after(async () => {
  await f?.close();
});

test("P14 comparison page: title, both entries, facts table and sanitized Markdown", async () => {
  assert.equal(id, "figma-vs-penpot");
  const body = await html(`/zh/tools/compare/${id}`);
  assert.match(body, /<h1[^>]*>Figma vs Penpot：怎么选<\/h1>/);
  assert.ok(body.includes('href="/zh/tools/figma"'));
  assert.ok(body.includes('href="/zh/tools/penpot"'));
  assert.match(body, /id="section-facts"/);
  assert.match(body, /<table[\s\S]*Self-host/);
  assert.doesNotMatch(body, /javascript:/);
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /<img[^>]*evil\.example/);
  assert.match(body, /href="https:\/\/evil\.example\/x" target="_blank" rel="noopener noreferrer nofollow ugc"/);
  assert.match(body, new RegExp(`<link rel="canonical" href="${ORIGIN}/zh/tools/compare/${id}"`));
  // The English version is a draft: no English alternate, and the English page is 404.
  assert.doesNotMatch(body, /hrefLang="en"/);
  await html(`/en/tools/compare/${id}`, 404);
  assert.match(body, /<title>Figma vs Penpot：怎么选 · Atlas 工具<\/title>/);
  assert.match(body, /"@type":"Article"/);
  assert.match(body, /<meta name="description" content="Figma and Penpot are both design tools\."/);
  assert.doesNotMatch(body, /\sstyle="/);
  assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)(?![^>]*application\/ld\+json)[^>]*>/);
});

test("P14 detail page lists comparisons and the sitemap includes them", async () => {
  const body = await html("/zh/tools/figma");
  assert.match(body, /id="section-comparisons"/);
  assert.ok(body.includes(`href="/zh/tools/compare/${id}"`));
  assert.match(body, /对比 Penpot/);
  assert.match(body, /href="#section-comparisons"/);
  assert.doesNotMatch(await html("/en/tools/figma"), /section-comparisons/);
  const sitemap = await html("/sitemap.xml");
  assert.ok(sitemap.includes(`<loc>${ORIGIN}/zh/tools/compare/${id}</loc>`));
  assert.equal(sitemap.includes(`/en/tools/compare/`), false);
});

test("P14 comparison pages escape untrusted titles and vanish with an unpublished entry", async () => {
  const body = await html("/zh/tools/compare/figma-vs-unsafe");
  assert.equal(body.includes(XSS), false);
  assert.match(body, /&lt;img src=x onerror=/);
  await f.pool.query("UPDATE publication SET status='draft' WHERE site_id='atlas' AND resource_id='penpot' AND locale='zh'");
  try {
    await html(`/zh/tools/compare/${id}`, 404);
    assert.doesNotMatch(await html("/zh/tools/figma"), new RegExp(`compare/${id}`));
  } finally {
    await f.pool.query("UPDATE publication SET status='published' WHERE site_id='atlas' AND resource_id='penpot' AND locale='zh'");
  }
  await html("/zh/tools/compare/no-such-pair", 404);
});
