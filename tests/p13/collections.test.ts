// M13b collections: per-site curated lists, their public listing, filter and pages.
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../../src/domain/config.js";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;
let catalogPath = "";
const get = (path: string) =>
  f.app.respond(new Request(`https://atlas.p6.test${path}`, { headers: { host: "atlas.p6.test" } }));
const json = async (path: string) => {
  const response = await get(path);
  assert.equal(response.status, 200, path);
  return await response.json();
};
const save = (input: Record<string, unknown>) => f.app.content.saveCollection(f.admin, "atlas", input);
const slugs = (body: { items: { slug: string }[] }) => body.items.map((i) => i.slug);

before(async () => {
  f = await setup();
  const snapshot = await f.app.sites.export(f.admin, "atlas");
  snapshot.config = configSchema.parse({ ...snapshot.config, locales: ["zh", "en"] });
  await f.app.sites.save(f.admin, "atlas", snapshot, { revision: 0, draftVersion: 0 });
  await f.app.sites.publish(f.admin, "atlas", { revision: 0, draftVersion: 1 }, randomUUID());
  catalogPath = (await f.pool.query("SELECT config->>'catalogPath' AS p FROM site WHERE id='atlas'")).rows[0].p;
  // a, b and c in both languages; z only in Chinese; draft is never published.
  for (const [id, locales] of [
    ["a", ["zh", "en"]],
    ["b", ["zh", "en"]],
    ["c", ["zh", "en"]],
    ["z", ["zh"]],
    ["draft", []],
  ] as const) {
    await f.app.content.saveResource(f.admin, {
      id,
      expectedVersion: 0,
      public: true,
      data: {
        url: `https://example.com/${id}`,
        source: "manual",
        translations: {
          zh: { title: `${id} 标题`, description: `${id} 说明` },
          en: { title: `${id} title`, description: `${id} description` },
        },
      },
    });
    for (const locale of locales) {
      await f.app.content.stage(f.admin, "atlas", id, locale, {
        candidate: { resourceVersion: 1, slug: id },
        expected: { published: 0, draft: 0 },
      });
      await f.app.content.publish(f.admin, "atlas", id, locale, {
        expected: { published: 0, draft: 1 },
        operationId: randomUUID(),
      });
    }
  }
});
after(async () => {
  await f?.close();
});

test("P13 collections validate input, versions and permissions", async () => {
  assert.equal(
    await save({
      id: "hot",
      labels: { zh: "热门", en: "Hot" },
      descriptions: { zh: "最近最受欢迎" },
      items: ["c", "a", "z", "draft"],
      expectedVersion: 0,
    }),
    1,
  );
  await assert.rejects(save({ id: "hot", labels: { zh: "热门" }, items: [], expectedVersion: 0 }), /version changed/);
  await assert.rejects(
    save({ id: "bad", labels: { zh: "坏" }, items: ["no-such-resource"], expectedVersion: 0 }),
    /不存在的资源/,
  );
  await assert.rejects(save({ id: "dup", labels: { zh: "重复" }, items: ["a", "a"], expectedVersion: 0 }));
  await assert.rejects(
    f.app.content.saveCollection(f.viewer, "atlas", { id: "nope", labels: { zh: "不行" }, items: [], expectedVersion: 0 }),
  );
  const listed = await (await f.api("/content/atlas/collections")).json();
  assert.deepEqual(listed, [
    {
      id: "hot",
      labels: { zh: "热门", en: "Hot" },
      descriptions: { zh: "最近最受欢迎" },
      rank: 0,
      active: true,
      version: 1,
      items: ["c", "a", "z", "draft"],
    },
  ]);
});

test("P13 public collections keep the curated order and only show visible entries", async () => {
  assert.deepEqual(await json("/api/collections?locale=zh"), [
    { id: "hot", label: "热门", description: "最近最受欢迎", count: 3 },
  ]);
  // English: z has no English version; the description falls back to empty.
  assert.deepEqual(await json("/api/collections?locale=en"), [{ id: "hot", label: "Hot", description: "", count: 2 }]);
  assert.deepEqual(slugs(await json("/api/search?locale=zh&collection=hot")), ["c", "a", "z"]);
  assert.deepEqual(slugs(await json("/api/search?locale=en&collection=hot")), ["c", "a"]);
  // Reordering replaces the membership.
  await save({ id: "hot", labels: { zh: "热门", en: "Hot" }, items: ["a", "b"], expectedVersion: 1 });
  assert.deepEqual(slugs(await json("/api/search?locale=zh&collection=hot")), ["a", "b"]);
  // A collection without a label in a locale, or inactive, is hidden there.
  await save({ id: "zh-only", labels: { zh: "仅中文" }, items: ["a"], expectedVersion: 0 });
  await save({ id: "off", labels: { zh: "停用", en: "Off" }, active: false, items: ["a"], expectedVersion: 0 });
  await save({ id: "empty", labels: { zh: "空", en: "Empty" }, items: ["draft"], expectedVersion: 0 });
  assert.deepEqual(
    (await json("/api/collections?locale=zh")).map((c: { id: string }) => c.id),
    ["hot", "zh-only"],
  );
  assert.deepEqual(
    (await json("/api/collections?locale=en")).map((c: { id: string }) => c.id),
    ["hot"],
  );
  assert.deepEqual(slugs(await json("/api/search?locale=zh&collection=off")), []);
});

test("P13 collection pages are routed, indexable and list hreflang only where they have entries", async () => {
  const page = await get(`/zh/${catalogPath}/collection/hot`);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.doesNotMatch(body, /noindex/);
  assert.match(body, new RegExp(`rel="canonical" href="https://atlas\\.p6\\.test/zh/${catalogPath}/collection/hot"`));
  assert.match(body, new RegExp(`hreflang="en" href="https://atlas\\.p6\\.test/en/${catalogPath}/collection/hot"`));
  // Curated order: a before b.
  assert.ok(body.indexOf(`/zh/${catalogPath}/a"`) < body.indexOf(`/zh/${catalogPath}/b"`));
  const zhOnly = await (await get(`/zh/${catalogPath}/collection/zh-only`)).text();
  assert.doesNotMatch(zhOnly, /hreflang="en"/);
  for (const path of [
    `/en/${catalogPath}/collection/zh-only`,
    `/zh/${catalogPath}/collection/off`,
    `/zh/${catalogPath}/collection/empty`,
    `/zh/${catalogPath}/collection/missing`,
  ])
    assert.equal((await get(path)).status, 404, path);
});
