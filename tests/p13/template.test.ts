// M13a in the toolso template: logo, tagline, pricing, dates, tags and tag pages, extra
// categories, the Markdown overview and the list/FAQ sections, plus their sanitizing.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "../p12/helpers.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const CONTENT = [
  "## Getting started",
  "",
  "Read the [docs](https://docs.example.com/start) first. A [bad link](javascript:alert(1)) stays inert.",
  "External: [a](//evil.example/x) and [b](/\\evil.example).",
  "",
  '<script>alert("x")</script>',
  "",
  "![remote pixel](https://evil.example.com/pixel.png)",
  "",
  "| Plan | Price |",
  "| --- | --- |",
  "| Starter | $0 |",
  "",
  "- first point",
  "- second point",
].join("\n");
const rich = (lang: "zh" | "en") => ({
  title: lang === "zh" ? "富内容工具" : "Rich tool",
  description: lang === "zh" ? "富内容工具的说明" : "Rich tool description",
  tagline: lang === "zh" ? "一句话介绍富内容工具" : "One-line pitch for the rich tool",
  features: [lang === "zh" ? "实时协作" : "Live collaboration", XSS],
  useCases: [lang === "zh" ? "团队评审" : "Team reviews"],
  pros: [lang === "zh" ? "上手快" : "Quick to learn"],
  cons: [lang === "zh" ? "离线功能有限" : "Limited offline mode"],
  content: CONTENT,
  faqs: [
    {
      question: lang === "zh" ? "可以免费使用吗？" : "Is it free?",
      answer: lang === "zh" ? "有**免费**套餐。" : "There is a **free** plan.",
    },
  ],
});

let f: Fixture;
let logoId = "";
before(async () => {
  f = await setup();
  await seedToolso(f);
  await f.app.content.saveCategory(f.admin, "atlas", {
    id: "ai",
    labels: { zh: "人工智能", en: "AI" },
    expectedVersion: 0,
  });
  await f.app.content.saveTag(f.admin, "atlas", {
    id: "collab",
    labels: { zh: "协作", en: "Collaboration" },
    expectedVersion: 0,
  });
  await f.app.content.saveTag(f.admin, "atlas", {
    id: "unsafe-tag",
    labels: { zh: XSS, en: XSS },
    expectedVersion: 0,
  });
  const logo = await f.app.media.upload(f.editor, {
    site: "atlas",
    alt: "logo",
    filename: "logo.png",
    mime: "image/png",
    data: png.toString("base64"),
  });
  logoId = logo.id;
  await f.app.content.saveResource(f.admin, {
    id: "rich",
    expectedVersion: 0,
    data: {
      url: "https://example.com/rich",
      source: "manual",
      pricing: "freemium",
      translations: { zh: rich("zh"), en: rich("en") },
    },
    public: true,
  });
  for (const locale of ["zh", "en"] as const) {
    await f.app.content.stage(f.admin, "atlas", "rich", locale, {
      candidate: {
        resourceVersion: 1,
        slug: "rich",
        categoryId: "design",
        extraCategoryIds: ["ai"],
        tagIds: ["collab", "unsafe-tag"],
        overrides: { logo: { mediaId: logoId, alt: "Rich logo" } },
      },
      expected: { published: 0, draft: 0 },
    });
    await f.app.content.publish(f.admin, "atlas", "rich", locale, {
      expected: { published: 0, draft: 1 },
      operationId: randomUUID(),
    });
  }
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
const jsonLd = (body: string) =>
  [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));

test("P13 card shows the logo, tagline and pricing badge", async () => {
  const body = await html("/zh/tools");
  const logo = `/media/${logoId}/1`;
  assert.match(body, new RegExp(`<img[^>]* alt="Rich logo"[^>]*src="${logo}"|<img[^>]*src="${logo}"[^>]* alt="Rich logo"`));
  assert.match(body, /一句话介绍富内容工具/);
  assert.match(body, /免费增值/);
  // Cards without a logo keep the initial-letter avatar.
  assert.match(body, />F<\/span>/);
  assert.match(await html("/en/tools"), /Freemium/);
});

test("P13 detail hero and sidebar: logo, pricing, publish date, categories and tag links", async () => {
  const body = await html("/zh/tools/rich");
  assert.match(body, new RegExp(`<img[^>]*src="/media/${logoId}/1"`));
  assert.match(body, /免费增值/);
  assert.match(body, /<time dateTime="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z">\d{4}年\d{1,2}月\d{1,2}日<\/time>/);
  const links = hrefs(body);
  assert.ok(links.includes("/zh/tools/tag/collab"));
  assert.ok(links.includes("/zh/tools/tag/unsafe-tag"));
  assert.match(body, />#协作</);
  // Primary and extra category both listed in the sidebar.
  assert.ok(links.includes("/zh/tools/category/design"));
  assert.ok(links.includes("/zh/tools/category/ai"));
  assert.match(body, />人工智能</);
});

test("P13 detail sections: overview, features, use cases, pros/cons and FAQ in the contents list", async () => {
  const body = await html("/zh/tools/rich");
  for (const slug of ["overview", "features", "use-cases", "pros-cons", "faq"]) {
    assert.match(body, new RegExp(`id="section-${slug}"`), slug);
    assert.match(body, new RegExp(`href="#section-${slug}"`), slug);
  }
  assert.match(body, /概览/);
  assert.match(body, /主要功能/);
  assert.match(body, /实时协作/);
  assert.match(body, /团队评审/);
  assert.match(body, /上手快/);
  assert.match(body, /离线功能有限/);
  assert.match(body, /<details[^>]*>[\s\S]*?可以免费使用吗？[\s\S]*?<strong>免费<\/strong>/);
  // Detail pages of entries without rich fields keep the earlier layout.
  const plain = await html("/zh/tools/figma");
  assert.doesNotMatch(plain, /id="section-overview"|id="section-faq"/);
});

test("P13 Markdown overview renders GFM and is sanitized", async () => {
  const body = await html("/zh/tools/rich");
  const overview = body.slice(body.indexOf('id="section-overview"'), body.indexOf('id="section-features"'));
  assert.match(overview, /<article class="prose[^"]*">/);
  assert.match(overview, /<h2>Getting started<\/h2>/);
  assert.match(overview, /<table>[\s\S]*<th>Plan<\/th>[\s\S]*<td>Starter<\/td>/);
  assert.match(overview, /<li>first point<\/li>/);
  assert.match(
    overview,
    /<a href="https:\/\/docs\.example\.com\/start" target="_blank" rel="noopener noreferrer nofollow ugc">docs<\/a>/,
  );
  assert.match(
    overview,
    /<a href="\/\/evil\.example\/x" target="_blank" rel="noopener noreferrer nofollow ugc">a<\/a>/,
  );
  assert.match(
    overview,
    /<a href="\/%5Cevil\.example" target="_blank" rel="noopener noreferrer nofollow ugc">b<\/a>/,
  );
  // Raw HTML, unsafe link schemes and external images never reach the page.
  assert.doesNotMatch(overview, /<script/);
  assert.doesNotMatch(overview, /alert\("x"\)/);
  assert.doesNotMatch(body, /javascript:/i);
  assert.doesNotMatch(body, /evil\.example\.com/);
  assert.doesNotMatch(body, /<img[^>]*src="https?:/);
  assert.match(overview, /bad link/);
});

test("P13 detail JSON-LD includes FAQPage; SoftwareApplication uses the logo", async () => {
  const items = jsonLd(await html("/en/tools/rich"));
  const faq = items.find((i) => i["@type"] === "FAQPage");
  assert.ok(faq);
  assert.equal(faq.mainEntity[0].name, "Is it free?");
  assert.equal(faq.mainEntity[0].acceptedAnswer.text, "There is a **free** plan.");
  const app = items.find((i) => i["@type"] === "SoftwareApplication");
  assert.equal(app.image, `https://atlas.p6.test/media/${logoId}/1`);
  assert.equal(jsonLd(await html("/en/tools/figma")).some((i) => i["@type"] === "FAQPage"), false);
});

test("P13 tag page lists only tagged entries; unknown tags are 404", async () => {
  const body = await html("/zh/tools/tag/collab");
  assert.match(body, /<h1 class="type-display[^"]*">#协作<\/h1>/);
  assert.match(body, /<nav aria-label="面包屑导航"[\s\S]*?href="\/zh\/tools"[^>]*>全部产品<\/a>[\s\S]*?aria-current="page"[^>]*>#协作</);
  assert.ok(hrefs(body).includes("/zh/tools/rich"));
  assert.equal(hrefs(body).includes("/zh/tools/figma"), false);
  // Sibling tags.
  assert.match(body, /浏览其他标签/);
  assert.ok(hrefs(body).includes("/zh/tools/tag/unsafe-tag"));
  assert.match(body, /<title>标签为 #协作 的工具 · Atlas 工具<\/title>/);
  assert.match(body, /<link rel="canonical" href="https:\/\/atlas\.p6\.test\/zh\/tools\/tag\/collab"/);
  assert.match(await html("/en/tools/tag/collab"), />#Collaboration<\/h1>/);
  await html("/zh/tools/tag/no-such-tag", 404);
});

test("P13 a ?tag= filter on the catalog is noindex and kept by the search form", async () => {
  const body = await html("/zh/tools?tag=collab");
  assert.match(body, /noindex/);
  assert.ok(hrefs(body).includes("/zh/tools/rich"));
  assert.equal(hrefs(body).includes("/zh/tools/figma"), false);
  assert.match(body, /<input type="hidden" name="tag" value="collab"/);
});

test("P13 an extra category lists the entry on its category page", async () => {
  const body = await html("/zh/tools/category/ai");
  assert.match(body, /<h1 class="type-display[^"]*">人工智能<\/h1>/);
  assert.ok(hrefs(body).includes("/zh/tools/rich"));
  assert.equal(hrefs(body).includes("/zh/tools/figma"), false);
  // The primary category still lists it too.
  assert.ok(hrefs(await html("/zh/tools/category/design")).includes("/zh/tools/rich"));
});

test("P13 pages keep the CSP and escape untrusted text", async () => {
  for (const path of ["/zh/tools", "/zh/tools/rich", "/en/tools/rich", "/zh/tools/tag/collab", "/zh/tools/tag/unsafe-tag", "/zh/tools/category/ai"]) {
    const body = await html(path);
    assert.equal(body.includes(XSS), false, path);
    assert.doesNotMatch(body, /\sstyle="/, path);
    assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)(?![^>]*application\/ld\+json)[^>]*>/, path);
  }
  assert.match(await html("/zh/tools/rich"), /#&lt;img src=x onerror=/);
});
