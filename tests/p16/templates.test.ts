// M16 in the basic and editorial templates: rich detail fields, sanitized Markdown, FAQPage
// JSON-LD, term pages, the alternatives page and A-vs-B comparison pages.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../../src/domain/config.js";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "../p12/helpers.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const CONTENT = [
  "## Getting started",
  "",
  "[bad](javascript:alert(1)) and [site](https://evil.example/x) and [b](/\\evil.example).",
  "",
  "<script>alert(1)</script>",
  "",
  "![pixel](https://evil.example/p.png)",
  "",
  "| Plan | Price |",
  "| --- | --- |",
  "| Starter | $0 |",
].join("\n");

let f: Fixture;
let logoId = "";
async function useTemplate(template: string) {
  const snapshot = await f.app.sites.export(f.admin, "atlas");
  snapshot.config = configSchema.parse({ ...snapshot.config, template, templateParams: {} });
  const { rows } = await f.pool.query("SELECT revision, draft_version FROM site WHERE id='atlas'");
  const { revision, draft_version: draftVersion } = rows[0];
  const next = await f.app.sites.save(f.admin, "atlas", snapshot, { revision, draftVersion });
  await f.app.sites.publish(f.admin, "atlas", { revision, draftVersion: typeof next === "number" ? next : draftVersion + 1 }, randomUUID());
  f.app.catalog.invalidate("atlas");
}
before(async () => {
  f = await setup();
  await seedToolso(f);
  await f.app.content.saveTag(f.admin, "atlas", { id: "collab", labels: { zh: "协作", en: "Collab" }, expectedVersion: 0 });
  await f.app.content.saveTag(f.admin, "atlas", { id: "bad", labels: { zh: XSS, en: XSS }, expectedVersion: 0 });
  const logo = await f.app.media.upload(f.editor, { site: "atlas", alt: "logo", filename: "logo.png", mime: "image/png", data: png.toString("base64") });
  logoId = logo.id;
  await f.app.content.saveResource(f.admin, {
    id: "rich",
    expectedVersion: 0,
    public: true,
    data: {
      url: "https://example.com/rich",
      source: "manual",
      pricing: "freemium",
      translations: {
        zh: {
          title: "富内容工具",
          description: "富内容工具的说明",
          tagline: "一句话介绍",
          features: ["实时协作", XSS],
          useCases: ["团队评审"],
          pros: ["上手快"],
          cons: ["离线有限"],
          content: CONTENT,
          faqs: [{ question: "可以免费使用吗？", answer: "有**免费**套餐。<b>x</b>" }],
        },
      },
    },
  });
  await f.app.content.stage(f.admin, "atlas", "rich", "zh", {
    candidate: { resourceVersion: 1, slug: "rich", categoryId: "design", tagIds: ["collab", "bad"], overrides: { logo: { mediaId: logoId, alt: "Rich logo" } } },
    expected: { published: 0, draft: 0 },
  });
  await f.app.content.publish(f.admin, "atlas", "rich", "zh", { expected: { published: 0, draft: 1 }, operationId: randomUUID() });
  await f.app.content.saveComparison(f.admin, "atlas", {
    locale: "zh", resourceA: "penpot", resourceB: "figma", title: "Figma vs Penpot：怎么选", content: CONTENT, published: true, expectedVersion: 0,
  });
  await f.app.content.saveComparison(f.admin, "atlas", {
    locale: "zh", resourceA: "figma", resourceB: "unsafe", title: XSS, content: "x", published: true, expectedVersion: 0,
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
const jsonLd = (body: string) =>
  [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
const safeMarkdown = (body: string) => {
  assert.doesNotMatch(body, /javascript:/);
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /<img[^>]*evil\.example/);
  assert.equal(body.includes(XSS), false);
  assert.match(body, /href="https:\/\/evil\.example\/x" target="_blank" rel="noopener noreferrer nofollow ugc"/);
  assert.match(body, /<table>[\s\S]*Starter/);
  assert.doesNotMatch(body, /\sstyle="/);
  assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)(?![^>]*application\/ld\+json)[^>]*>/);
};

for (const template of ["basic", "editorial"]) {
  test(`P16 ${template}: detail shows rich fields, safe Markdown and FAQPage JSON-LD`, async () => {
    await useTemplate(template);
    const body = await html("/zh/tools/rich");
    assert.match(body, new RegExp(`class="template-${template} `));
    assert.match(body, /^<!doctype html><html lang="zh">/);
    assert.match(body, new RegExp(`<img class="detail-logo" src="/media/${logoId}/1" alt="Rich logo"`));
    assert.match(body, /一句话介绍/);
    assert.match(body, /免费增值/);
    assert.match(body, /<time datetime="\d{4}-\d{2}-\d{2}T[^"]+">\d{4}-\d{2}-\d{2}<\/time>/);
    assert.ok(body.includes('href="/zh/tools/tag/collab"'));
    assert.ok(body.includes('href="/zh/tools/category/design"'));
    assert.match(body, /id="section-features"[\s\S]*实时协作/);
    assert.match(body, /团队评审/);
    assert.match(body, /上手快[\s\S]*离线有限/);
    assert.match(body, /<h2>概览<\/h2>[\s\S]*<h2>Getting started<\/h2>/);
    assert.match(body, /<strong>免费<\/strong>/);
    assert.doesNotMatch(body, /<b>x<\/b>/);
    safeMarkdown(body);
    const faq = jsonLd(body).find((d) => d["@type"] === "FAQPage");
    assert.equal(faq.mainEntity[0].name, "可以免费使用吗？");
    assert.ok(body.includes('href="/zh/tools/rich/alternatives"'));
    // Cards in the listing carry logo, tagline and pricing.
    const listing = await html("/zh/tools");
    assert.match(listing, new RegExp(`<img class="item-logo" src="/media/${logoId}/1"`));
    assert.match(listing, /一句话介绍/);
    assert.equal(listing.includes(XSS), false);
    const tag = await html("/zh/tools/tag/bad");
    assert.equal(tag.includes(XSS), false);
    // Term pages keep the normal intro/search and add the term header.
    const term = await html("/zh/tools/tag/collab");
    assert.match(term, /<form class="search"/);
    assert.match(term, /<input type="hidden" name="tag" value="collab">/);
    assert.match(term, /<h1>#协作<\/h1>/);
    if (template === "editorial") assert.match(term, /class="editorial-masthead"/);
  });

  test(`P16 ${template}: alternatives and comparison pages render and escape`, async () => {
    await useTemplate(template);
    const alternatives = await html("/zh/tools/figma/alternatives");
    assert.match(alternatives, /<h1>Figma 的替代品<\/h1>/);
    assert.ok(alternatives.includes('href="/zh/tools/penpot"'));
    assert.match(alternatives, /<title>Figma 的替代品 · Atlas 工具<\/title>/);
    const compare = await html("/zh/tools/compare/figma-vs-penpot");
    assert.match(compare, /<h1>Figma vs Penpot：怎么选<\/h1>/);
    assert.ok(compare.includes('href="/zh/tools/figma"') && compare.includes('href="/zh/tools/penpot"'));
    safeMarkdown(compare);
    const unsafe = await html("/zh/tools/compare/figma-vs-unsafe");
    assert.equal(unsafe.includes(XSS), false);
    assert.match(unsafe, /&lt;img src=x onerror=/);
    const detail = await html("/zh/tools/figma");
    assert.match(detail, /id="section-comparisons"/);
    assert.ok(detail.includes('href="/zh/tools/compare/figma-vs-penpot"'));
    assert.ok((await html("/sitemap.xml")).includes("/zh/tools/compare/figma-vs-penpot</loc>"));
  });
}
