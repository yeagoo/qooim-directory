// M16: publication lookup by resource id, used by AI comparison drafting beyond the first page.
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;

before(async () => {
  f = await setup();
  // Push the pair past the first 100 listing rows.
  for (let i = 0; i < 105; i++) {
    const id = `aa-${String(i).padStart(3, "0")}`;
    await f.app.content.saveResource(f.admin, {
      id,
      expectedVersion: 0,
      public: true,
      data: {
        url: `https://example.com/${id}`,
        source: "manual",
        translations: { zh: { title: `${id} 标题`, description: `${id} 说明` } },
      },
    });
    await f.app.content.stage(f.admin, "atlas", id, "zh", {
      candidate: { resourceVersion: 1, slug: id },
      expected: { published: 0, draft: 0 },
    });
  }
  for (const id of ["zz-alpha", "zz-beta"]) {
    await f.app.content.saveResource(f.admin, {
      id,
      expectedVersion: 0,
      public: true,
      data: {
        url: `https://example.com/${id}`,
        source: "manual",
        translations: { zh: { title: `${id} 标题`, description: `${id} 说明` } },
      },
    });
    await f.app.content.stage(f.admin, "atlas", id, "zh", {
      candidate: { resourceVersion: 1, slug: id },
      expected: { published: 0, draft: 0 },
    });
    await f.app.content.publish(f.admin, "atlas", id, "zh", {
      expected: { published: 0, draft: 1 },
      operationId: randomUUID(),
    });
  }
});
after(async () => {
  await f?.close();
});

test("P16 publications can be looked up by id beyond the first page", async () => {
  const first = await f.app.content.publications(f.admin, "atlas", 1);
  assert.equal(first.length, 100);
  assert.equal(first.some((row) => row.id.startsWith("zz-")), false);
  const pair = await f.app.content.publications(f.admin, "atlas", 1, "zz-beta,zz-alpha");
  assert.deepEqual(pair.map((row) => row.id).sort(), ["zz-alpha", "zz-beta"]);
  assert.equal(pair[0].status, "published");
  assert.equal(pair[0].data.translations.zh.title, "zz-alpha 标题");
});

test("P16 the id lookup rejects malformed or oversized id lists", async () => {
  for (const ids of ["", "Bad", "a,,b", Array.from({ length: 21 }, (_, i) => `r${i}`).join(",")])
    await assert.rejects(f.app.content.publications(f.admin, "atlas", 1, ids));
  assert.deepEqual(await f.app.content.publications(f.admin, "atlas", 1, "no-such"), []);
});
