import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "./helpers.js";

let f: Fixture;
before(async () => {
  f = await setup();
  await seedToolso(f);
});
after(async () => {
  await f?.close();
});
const html = async (path: string, status = 200) => {
  const response = await get(f, path);
  assert.equal(response.status, status, path);
  return { response, body: await response.text() };
};

test("P12 toolso serves home, locale home, catalog, category and detail pages", async () => {
  for (const path of ["/", "/en", "/zh/tools", "/zh/tools/category/design", "/zh/tools/figma"]) {
    const { body } = await html(path);
    assert.match(body, /^<!doctype html><html lang="(zh|en)"/, path);
    assert.match(body, /href="\/assets\/toolso\.css"/, path);
    assert.match(body, /获取本部署源码 · AGPL-3\.0/, path);
  }
  assert.match((await html("/zh/tools/category/design")).body, /Figma/);
  assert.doesNotMatch((await html("/zh/tools/category/design")).body, /onerror/);
  await html("/zh/tools/category/unknown", 404);
  await html("/fr", 404);
  const missing = await html("/zh/tools/does-not-exist", 404);
  assert.match(missing.body, /noindex/);
});

test("P12 pages keep the CSP: no inline styles, no inline executable scripts", async () => {
  for (const path of ["/", "/zh/tools", "/zh/tools/category/design", "/zh/tools/figma", "/zh/tools/nope"]) {
    const response = await get(f, path);
    const body = await response.text();
    assert.match(response.headers.get("content-security-policy") ?? "", /style-src 'self';/);
    assert.doesNotMatch(body, /\sstyle="/, `${path} has an inline style attribute`);
    for (const script of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      const [, attrs, content] = script;
      if (/type="application\/ld\+json"/.test(attrs!)) continue;
      assert.match(attrs!, /\ssrc="\/assets\//, `${path} inline script`);
      assert.equal(content, "", `${path} script body`);
    }
  }
});

test("P12 untrusted titles stay escaped in markup and JSON-LD", async () => {
  const { body } = await html("/zh/tools/unsafe");
  assert.equal(body.includes(XSS), false);
  assert.match(body, /&lt;img src=x onerror=/);
  for (const [, json] of body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g))
    assert.doesNotMatch(json!, /</);
});

test("P12 SEO head: canonical, hreflang with x-default, og tags; category pages are indexable", async () => {
  const home = (await html("/en")).body;
  assert.match(home, /<link rel="canonical" href="https:\/\/atlas\.p6\.test\/en"/);
  assert.match(home, /hrefLang="x-default" href="https:\/\/atlas\.p6\.test\/"|hreflang="x-default" href="https:\/\/atlas\.p6\.test\/"/i);
  const category = (await html("/zh/tools/category/design")).body;
  assert.match(category, /<link rel="canonical" href="https:\/\/atlas\.p6\.test\/zh\/tools\/category\/design"/);
  assert.doesNotMatch(category, /noindex/);
  assert.match((await html("/zh/tools?category=design")).body, /noindex/);
  assert.match((await html("/zh/tools/figma")).body, /<meta property="og:type" content="article"/);
});

test("P12 theme, font and stylesheet assets", async () => {
  const theme = await get(f, "/assets/theme/4f46e5.css");
  assert.equal(theme.status, 200);
  assert.equal(theme.headers.get("content-type"), "text/css");
  assert.match(await theme.text(), /--brand-h:\d+;.*--primary:\d+ \d+% \d+%/);
  for (const bad of ["/assets/theme/4F46E5.css", "/assets/theme/zzzzzz.css", "/assets/theme/4f46e5;x.css"])
    assert.equal((await get(f, bad)).status, 404, bad);
  const css = await get(f, "/assets/toolso.css");
  assert.equal(css.headers.get("content-type"), "text/css");
  assert.match(css.headers.get("cache-control") ?? "", /public/);
  const font = await get(f, "/assets/fonts/Geist-Variable.woff2");
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), "wOF2");
  // Template assets are public-site only.
  assert.equal((await get(f, "/assets/toolso.css", "admin.p6.test")).status, 404);
  assert.match((await html("/")).body, /href="\/assets\/theme\/4f46e5\.css"/);
});

test("P12 other templates keep their routes: no locale home, root stays the directory", async () => {
  const notes = await get(f, "/", "notes.p6.test");
  assert.equal(notes.status, 200);
  assert.doesNotMatch(await notes.text(), /toolso\.css/);
  assert.equal((await get(f, "/zh", "notes.p6.test")).status, 404);
});
