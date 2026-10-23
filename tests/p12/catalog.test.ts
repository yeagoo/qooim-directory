import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "./helpers.js";

let f: Fixture;
const DEV_COUNT = 26; // more than one page (24 per page)

async function publish(
  id: string,
  data: Record<string, unknown>,
  locales: ("zh" | "en")[],
  categoryId?: string,
) {
  await f.app.content.saveResource(f.admin, { id, expectedVersion: 0, data, public: true });
  for (const locale of locales) {
    await f.app.content.stage(f.admin, "atlas", id, locale, {
      candidate: { resourceVersion: 1, slug: id, ...(categoryId ? { categoryId } : {}) },
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
  await seedToolso(f);
  // Repository resources publish through the open-source module.
  await f.pool.query("UPDATE site SET modules=ARRAY['directory','opensource'] WHERE id='atlas'");
  // A GitHub project in the design category.
  await publish(
    "penpot-repo",
    {
      kind: "repository",
      url: "https://github.com/penpot/penpot",
      source: "manual",
      translations: {
        zh: { title: "Penpot 仓库", description: "开源设计工具的源码" },
        en: { title: "Penpot repo", description: "Source of the open design tool" },
      },
      project: {
        provider: "github",
        repoId: "123456",
        fullName: "penpot/penpot",
        stars: 34567,
        forks: 1890,
        openIssues: 512,
        language: "Clojure",
        license: "MPL-2.0",
        topics: ["design", "prototyping"],
        archived: false,
        pushedAt: "2026-09-01T00:00:00.000Z",
      },
    },
    ["zh", "en"],
    "design",
  );
  // A second, zh-only category large enough to paginate.
  await f.app.content.saveCategory(f.admin, "atlas", {
    id: "dev",
    labels: { zh: "开发", en: "Dev" },
    expectedVersion: 0,
  });
  for (let i = 1; i <= DEV_COUNT; i++) {
    const id = `devtool-${String(i).padStart(2, "0")}`;
    await publish(
      id,
      {
        url: `https://example.com/${id}`,
        source: "manual",
        translations: { zh: { title: `开发工具 ${i}`, description: `第 ${i} 个开发工具` } },
      },
      ["zh"],
      "dev",
    );
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

test("P12 catalog lists cards linking to details, with search, category chips and the sidebar", async () => {
  const body = await html("/zh/tools");
  // 30 items: 24 cards on page 1, the rest on page 2; every card links to its detail page.
  assert.equal(body.match(/class="surface-card group flex/g)?.length, 24);
  const page2 = await html("/zh/tools?page=2");
  const both = [...hrefs(body), ...hrefs(page2)];
  for (const slug of ["figma", "penpot", "penpot-repo", "unsafe", "devtool-01", "devtool-26"])
    assert.ok(both.includes(`/zh/tools/${slug}`), slug);
  assert.match(body, /<h1 class="type-display[^"]*">全部产品<\/h1>/);
  assert.match(body, /<form role="search"[^>]* action="\/zh\/tools" method="get">/);
  assert.match(body, /<input type="search"[^>]* name="q" value=""/);
  // Category chips and the sidebar drawer link to category pages.
  assert.ok(hrefs(body).includes("/zh/tools/category/design"));
  assert.ok(hrefs(body).includes("/zh/tools/category/dev"));
  assert.match(body, /data-toggle="category-drawer-[^"]+" aria-controls="category-drawer-[^"]+" aria-expanded="false"/);
  assert.match(body, /<div id="category-drawer-[^"]+" hidden=""/);
  assert.match(body, /<div data-spotlight="true" class="grid/);
  assert.match(body, /class="surface-card group/);
  // GitHub stars show on the card of the resource with a project.
  assert.match(await html("/zh/tools/category/design"), /3\.5万/);
  // Untrusted titles stay escaped.
  assert.equal((body + page2).includes(XSS), false);
  assert.match(body + page2, /&lt;img src=x onerror=/);
});

test("P12 catalog search filters with ?q=", async () => {
  const body = await html("/zh/tools?q=Figma");
  assert.ok(hrefs(body).includes("/zh/tools/figma"));
  assert.equal(hrefs(body).includes("/zh/tools/penpot"), false);
  assert.match(body, /value="Figma"/);
  assert.match(body, /找到 1 个工具/);
  const none = await html("/zh/tools?q=nothing-matches-this");
  assert.match(none, /未找到工具/);
});

test("P12 pagination links keep q and category", async () => {
  const first = await html("/zh/tools?category=dev");
  assert.ok(hrefs(first).includes("/zh/tools?category=dev&page=2"), "filter kept");
  assert.match(first, /<input type="hidden" name="category" value="dev"/);
  const searched = await html("/zh/tools?q=%E5%BC%80%E5%8F%91&page=2");
  assert.ok(hrefs(searched).includes("/zh/tools?q=%E5%BC%80%E5%8F%91"), "page 1 is the bare query");
  assert.match(searched, /aria-current="page"[^>]*>2</);
  const category = await html("/zh/tools/category/dev");
  assert.ok(hrefs(category).includes("/zh/tools/category/dev?page=2"));
  assert.match(category, /rel="next"/);
  const second = await html("/zh/tools/category/dev?page=2");
  assert.ok(hrefs(second).includes("/zh/tools/category/dev"));
  assert.match(second, /rel="prev"/);
});

test("P12 category page shows only its items with a heading and breadcrumb", async () => {
  const body = await html("/zh/tools/category/design");
  assert.match(body, /<h1 class="type-display[^"]*">设计<\/h1>/);
  assert.match(body, /<nav aria-label="面包屑导航"[\s\S]*?href="\/zh\/tools"[^>]*>全部产品<\/a>[\s\S]*?aria-current="page"[^>]*>设计</);
  for (const slug of ["figma", "penpot", "penpot-repo"]) assert.ok(hrefs(body).includes(`/zh/tools/${slug}`), slug);
  assert.equal(hrefs(body).includes("/zh/tools/unsafe"), false);
  assert.equal(hrefs(body).includes("/zh/tools/devtool-01"), false);
  // Sibling categories.
  assert.match(body, /浏览其他分类/);
  assert.ok(hrefs(body).includes("/zh/tools/category/dev"));
  assert.match(await html("/en/tools/category/design"), />Design<\/h1>/);
});

test("P12 category hreflang only includes locales with public items; page>1 has no alternates", async () => {
  const design = await html("/zh/tools/category/design");
  assert.match(
    design,
    /hrefLang="zh" href="https:\/\/atlas\.p6\.test\/zh\/tools\/category\/design"/,
  );
  assert.match(
    design,
    /hrefLang="en" href="https:\/\/atlas\.p6\.test\/en\/tools\/category\/design"/,
  );

  const dev = await html("/zh/tools/category/dev");
  assert.match(
    dev,
    /hrefLang="zh" href="https:\/\/atlas\.p6\.test\/zh\/tools\/category\/dev"/,
  );
  assert.doesNotMatch(dev, /hrefLang="en"/);
  assert.doesNotMatch(
    dev,
    /href="https:\/\/atlas\.p6\.test\/en\/tools\/category\/dev"/,
  );

  const categoryPage2 = await html("/zh/tools/category/dev?page=2");
  assert.doesNotMatch(categoryPage2, /<link rel="alternate"/);
  assert.match(
    categoryPage2,
    /<link rel="canonical" href="https:\/\/atlas\.p6\.test\/zh\/tools\/category\/dev\?page=2"/,
  );
  const catalogPage2 = await html("/zh/tools?page=2");
  assert.doesNotMatch(catalogPage2, /<link rel="alternate"/);
});

test("P12 detail page: title, description, visit link, favorite, share, breadcrumb, related", async () => {
  const body = await html("/zh/tools/figma");
  assert.match(body, /<h1[^>]*>Figma<\/h1>/);
  assert.match(body, /Figma 的中文介绍/);
  assert.match(body, /<a href="https:\/\/example\.com\/figma" target="_blank" rel="noopener noreferrer"[^>]*>访问网站/);
  assert.match(body, /<button type="button" data-id="[^"]+"[^>]*class="favorite /);
  assert.match(body, /data-toggle="share-menu"/);
  assert.match(body, /data-copy="https:\/\/atlas\.p6\.test\/zh\/tools\/figma"/);
  assert.match(body, /href="https:\/\/twitter\.com\/intent\/tweet\?text=Figma&amp;url=https%3A%2F%2Fatlas\.p6\.test%2Fzh%2Ftools%2Ffigma"/);
  assert.match(body, /data-reading-progress="true"/);
  assert.match(body, /data-reading-target="true"/);
  // Breadcrumb: home → catalog → category → item.
  assert.match(body, /href="\/zh\/tools\/category\/design"[^>]*>设计<\/a>/);
  // Related: other items of the same category.
  assert.match(body, /相关工具/);
  assert.ok(hrefs(body).includes("/zh/tools/penpot"));
  assert.match(body, /data-section-nav="true"/);
  assert.match(body, /href="#section-related"/);
  // No GitHub section without a project.
  assert.doesNotMatch(body, /GitHub 仓库/);
});

test("P12 detail page renders GitHub stats when the resource has a project", async () => {
  const body = await html("/zh/tools/penpot-repo");
  assert.match(body, /id="section-github"/);
  assert.match(body, /GitHub 仓库/);
  assert.match(body, /34,567/);
  assert.match(body, /1,890/);
  assert.match(body, />Clojure</);
  assert.match(body, />MPL-2\.0</);
  assert.match(body, /#prototyping/);
  assert.match(body, /href="https:\/\/github\.com\/penpot\/penpot" target="_blank" rel="noopener noreferrer"/);
  const en = await html("/en/tools/penpot-repo");
  assert.match(en, /GitHub repository/);
  assert.match(en, /Stars/);
});

test("P12 missing page is a 404 that lists the other-language versions", async () => {
  const body = await html("/en/tools/devtool-01", 404);
  assert.match(body, /noindex/);
  assert.match(body, /The page you are looking for doesn&#x27;t exist\.|The page you are looking for doesn't exist\./);
  assert.match(body, /href="https:\/\/atlas\.p6\.test\/zh\/tools\/devtool-01" hrefLang="zh" lang="zh"[^>]*>中文/);
  const plain = await html("/zh/tools/never-existed", 404);
  assert.doesNotMatch(plain, /该页面有以下语言版本/);
});

test("P12 catalog, category, detail and 404 pages escape the XSS title and have no inline style", async () => {
  for (const [path, status] of [
    ["/zh/tools", 200],
    ["/zh/tools?q=img", 200],
    ["/zh/tools/unsafe", 200],
    ["/zh/tools/figma", 200],
    ["/zh/tools/penpot-repo", 200],
    ["/zh/tools/category/design", 200],
    ["/zh/tools/category/dev?page=2", 200],
    ["/en/tools/devtool-01", 404],
  ] as const) {
    const body = await html(path, status);
    assert.equal(body.includes(XSS), false, path);
    assert.doesNotMatch(body, /\sstyle="/, path);
    assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)(?![^>]*application\/ld\+json)[^>]*>/, path);
  }
});
