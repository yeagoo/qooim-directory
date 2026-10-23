// M15 public listing badges: SVG escaping, theme/accent, visibility and the toolso embed block.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { XSS, get, seedToolso } from "../p12/helpers.js";
import { badgeSvg } from "../../src/server/badge.js";

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
  // The title is escaped (and truncated to the badge width).
  assert.match(body, /&lt;img src=x onerror=&quot;/);
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

test("P15 badge truncates long ASCII and CJK titles to the display width budget", () => {
  const wide = /[\u1100-\u115f\u2e80-\u303e\u3040-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f000}-\u{1faff}]/u;
  const width = (value: string) =>
    Array.from(value).reduce((total, character) => total + (wide.test(character) ? 2 : 1), 0);
  const titleOf = (svg: string) => /<text x="20"[^>]*>(.*?)<\/text>/.exec(svg)?.[1] ?? "";
  const render = (title: string) =>
    badgeSvg({ locale: "zh", siteName: "站点", title, theme: "light" });

  const ascii = titleOf(render("A".repeat(80)));
  assert.equal(ascii, "A".repeat(22));
  assert.equal(width(ascii), 22);

  const cjk = titleOf(render("界".repeat(80)));
  assert.equal(cjk, "界".repeat(11));
  assert.equal(width(cjk), 22);
});
