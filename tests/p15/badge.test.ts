// M15 public listing badges: SVG escaping, theme/accent, visibility and the toolso embed block.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "../p12/helpers.js";

const ORIGIN = "https://atlas.p6.test";
let f: Fixture;

before(async () => {
  f = await setup();
  await seedToolso(f);
});
after(async () => {
  await f?.close();
});

test("P15 badge serves an escaped, cacheable SVG for a visible entry", async () => {
  const response = await get(f, "/badge/zh/unsafe.svg");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("cache-control") ?? "", /public, max-age=3600/);
  assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /unsafe-inline/);
  const body = await response.text();
  assert.match(body, /^<svg /);
  assert.doesNotMatch(body, /<style/);
  assert.doesNotMatch(body, /<img/);
  assert.equal(body.includes(XSS), false);
  assert.match(body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(body, /收录于 Atlas 工具/);
});

test("P15 badge supports English, dark theme and the configured accent", async () => {
  const light = await get(f, "/badge/en/figma.svg");
  assert.equal(light.status, 200);
  const lightBody = await light.text();
  assert.match(lightBody, /Featured on Atlas 工具/);
  assert.match(lightBody, /fill="#ffffff"/);
  assert.match(lightBody, /fill="#4F46E5"/);

  const dark = await get(f, "/badge/en/figma.svg?theme=dark");
  assert.equal(dark.status, 200);
  const darkBody = await dark.text();
  assert.match(darkBody, /fill="#18181b"/);
  assert.match(darkBody, /fill="#f4f4f5"/);
  assert.equal((await get(f, "/badge/en/figma.svg?theme=sepia")).status, 400);
});

test("P15 badge is 404 for unknown, unpublished and unavailable locale entries", async () => {
  assert.equal((await get(f, "/badge/zh/no-such-entry.svg")).status, 404);
  assert.equal((await get(f, "/badge/fr/figma.svg")).status, 404);
  await f.pool.query(
    "UPDATE publication SET status='draft' WHERE site_id='atlas' AND resource_id='figma' AND locale='en'",
  );
  try {
    assert.equal((await get(f, "/badge/en/figma.svg")).status, 404);
    assert.equal((await get(f, "/badge/zh/figma.svg")).status, 200);
  } finally {
    await f.pool.query(
      "UPDATE publication SET status='published' WHERE site_id='atlas' AND resource_id='figma' AND locale='en'",
    );
  }
});

test("P15 toolso detail shows the badge preview, nav section and copyable embed", async () => {
  const response = await get(f, "/zh/tools/figma");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /id="section-badge"/);
  assert.match(body, /href="#section-badge"/);
  assert.match(body, /src="\/badge\/zh\/figma\.svg"/);
  assert.match(body, /src="\/badge\/zh\/figma\.svg\?theme=dark"/);
  assert.match(body, /data-copy="[^"]*atlas\.p6\.test\/badge\/zh\/figma\.svg/);
  assert.match(body, /atlas\.p6\.test\/zh\/tools\/figma/);
  assert.match(body, />徽章</);
});
