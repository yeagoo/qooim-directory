import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { get, seedToolso } from "./helpers.js";

let f: Fixture;
before(async () => {
  f = await setup();
  await seedToolso(f);
});
after(async () => {
  await f?.close();
});
const html = async (path: string) => {
  const response = await get(f, path);
  assert.equal(response.status, 200, path);
  return response.text();
};

test("P12 toolso chrome: navbar, footer and client hooks on home and catalog pages", async () => {
  for (const path of ["/", "/zh/tools", "/zh/tools/category/design", "/zh/tools/figma"]) {
    const body = await html(path);
    assert.match(body, /<nav[^>]*data-navbar=""[^>]*aria-label="主导航"/, path);
    assert.match(body, /<footer class="relative overflow-hidden bg-background">/, path);
    assert.match(body, /class="footer-wordmark [^"]*">Atlas 工具</, path);
    assert.match(body, /data-theme-toggle=""/, path);
    for (const id of ["mobile-nav", "categories-menu", "language-menu", "user-menu"]) {
      assert.match(body, new RegExp(`data-toggle="${id}" aria-controls="${id}"[^>]*aria-expanded="false"`), `${path} ${id}`);
      assert.match(body, new RegExp(`id="${id}" hidden=""`), `${path} ${id} panel`);
    }
    // Signed-out account area visible, signed-in variant hidden until /assets/toolso.js swaps them.
    assert.match(body, /data-session=""/, path);
    assert.match(body, /<div data-when="signed-out">/, path);
    assert.match(body, /<div data-when="signed-in" hidden="">/, path);
    assert.match(body, /data-email=""/, path);
    assert.match(body, /data-sign-out=""/, path);
    assert.match(body, /<a href="\/login"[^>]*>登录<\/a>/, path);
    assert.match(body, /href="\/me"/, path);
    // Navbar categories dropdown and language alternates.
    assert.match(body, /href="\/zh\/tools\/category\/design"[^>]*role="menuitem"/, path);
    assert.match(body, /hrefLang="en"/, path);
    assert.doesNotMatch(body, /\sstyle="/, path);
  }
});

test("P12 toolso home: hero, featured cards, categories grid and CTA", async () => {
  const body = await html("/");
  assert.match(body, /<main class="relative">/);
  assert.equal(body.match(/<main\b/g)?.length, 1);
  // Hero: brand eyebrow, tagline title, stats.
  assert.match(body, /<span class="text-foreground">Atlas 工具<\/span>/);
  assert.match(body, /<h1 class="site-reveal [^"]*site-reveal-visible[^"]*">发现好用的工具<\/h1>/);
  assert.match(body, /<dd[^>]*>3<\/dd>/);
  // Featured cards link to the detail pages; untrusted titles stay escaped.
  assert.match(body, /data-spotlight=""/);
  for (const slug of ["figma", "penpot", "unsafe"])
    assert.match(body, new RegExp(`<a href="/zh/tools/${slug}" class="surface-card`), slug);
  assert.match(body, /<h3[^>]*>Figma<\/h3>/);
  assert.match(body, /example\.com/);
  assert.doesNotMatch(body, /<img src=x/);
  // Categories grid and CTA.
  assert.match(body, /<h2 class="type-title text-foreground">所有分类<\/h2>/);
  assert.match(body, /<a href="\/zh\/tools\/category\/design" class="group relative flex/);
  assert.match(body, /<h2 class="type-display[^"]*">找到最合适的那一个<\/h2>/);
  assert.match(body, /href="\/zh\/tools" class="group mt-10/);
  assert.match(body, /版权所有 © \d{4} Atlas 工具/);
});

test("P12 toolso English home uses English strings and /en links", async () => {
  const body = await html("/en");
  assert.match(body, /<html lang="en"/);
  assert.match(body, /aria-label="Primary navigation"/);
  assert.match(body, />All Tools</);
  assert.match(body, />Featured Tools</);
  assert.match(body, />All Categories</);
  assert.match(body, />Sign in</);
  assert.match(body, /<a href="\/en\/tools\/figma" class="surface-card/);
  assert.match(body, /<a href="\/en\/tools\/category\/design" class="group relative flex/);
  assert.match(body, /<a href="\/en"[^>]*aria-label="Atlas 工具"/);
  assert.doesNotMatch(body, /全部产品|精选工具|登录/);
});
