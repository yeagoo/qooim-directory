// M20 stable-release hardening: review fixes from docs/CODE-REVIEW-20261025.md.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { parseRss } from "../../src/server/collector-adapters.js";
import { gate, personaSchema } from "../../src/server/distribution.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
const get = (url: string, headers: Record<string, string> = {}) =>
  f.app.respond(new Request(url, { headers: { host: new URL(url).host, ...headers } }));

test("P20 L8 out-of-range character references do not fail a feed", () => {
  const items = parseRss(
    `<rss><channel><item><title>Bad &#xFFFFFF; &#55296; ok &#x41;</title><link>https://example.com/a</link><guid>a</guid></item></channel></rss>`,
    "https://example.com/feed",
    "en",
  );
  assert.equal(items.length, 1);
  const title = JSON.stringify(items[0].data);
  assert.match(title, /&#xFFFFFF;/);
  assert.match(title, /ok A/);
});

test("P20 M6 bare tech names are not new links; explicit links still are", () => {
  const persona = personaSchema.parse({});
  const base = { title: "Vite", description: "Vite 构建工具", content: "## 概述\n基于 Node.js 与 Vue.js，读取 vite.config.json。" };
  assert.ok(!gate(base, { name: "Vite" }, persona).includes("new_url"));
  for (const content of ["访问 www.evil.example", "见 https://evil.example/x", "镜像在 evil.com"])
    assert.ok(gate({ ...base, content }, { name: "Vite" }, persona).includes("new_url"), content);
});

test("P20 L1/L7 security headers, favicon and the admin theme-init script", async () => {
  const page = await get("https://atlas.p6.test/");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /object-src 'none'/);
  assert.match(page.headers.get("permissions-policy") ?? "", /camera=\(\)/);
  assert.equal(page.headers.get("strict-transport-security"), "max-age=31536000");
  const plain = await f.app.respond(
    new Request("http://atlas.p6.test/", { headers: { host: "atlas.p6.test" } }),
  );
  assert.equal(plain.headers.get("strict-transport-security"), null);
  for (const path of ["/favicon.ico", "/favicon.svg"]) {
    const icon = await get("https://atlas.p6.test" + path);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/svg+xml");
  }
  const login = await (await get("https://admin.p6.test/admin/login")).text();
  assert.match(login, /<script src="\/assets\/admin-theme-init.js"><\/script>/);
  assert.match(login, /<noscript>/);
  const init = await get("https://admin.p6.test/assets/admin-theme-init.js");
  assert.equal(init.status, 200);
  assert.match(await init.text(), /admin-theme/);
  // Admin-only asset is not served on a site host.
  assert.equal((await get("https://atlas.p6.test/assets/admin-theme-init.js")).status, 404);
});

test("P20 H4 migration 021 adds the resource and media-reference indexes", async () => {
  const names = (
    await f.pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('publication','content_draft')",
    )
  ).rows.map((r) => r.indexname);
  for (const name of [
    "publication_resource",
    "content_draft_resource",
    "publication_image_media",
    "publication_logo_media",
  ])
    assert.ok(names.includes(name), name);
});
