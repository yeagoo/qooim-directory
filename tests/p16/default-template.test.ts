// M17: new sites default to the toolso template; callers may still choose another default.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Sites } from "../../src/server/sites.js";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});

test("P16 new sites use the toolso template by default", async () => {
  const sites = new Sites(f.pool, f.key, "https://admin.p6.test", true);
  await sites.create(f.admin, {
    id: "fresh",
    name: "Fresh",
    origin: "https://fresh.p6.test",
    centerSite: null,
  });
  const row = (await f.pool.query("SELECT config->>'template' AS t FROM site WHERE id='fresh'")).rows[0];
  assert.equal(row.t, "toolso");
  // The shared fixture opts into basic.
  const atlas = (await f.pool.query("SELECT config->>'template' AS t FROM site WHERE id='atlas'")).rows[0];
  assert.equal(atlas.t, "basic");
});
