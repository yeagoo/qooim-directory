// M16: the admin origin's root leads to the console (and from there to login).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});

test("P16 the admin root redirects to the console, then to login when signed out", async () => {
  const root = await f.app.respond(
    new Request("https://admin.p6.test/", { headers: { host: "admin.p6.test" } }),
  );
  assert.equal(root.status, 303);
  assert.equal(root.headers.get("location"), "https://admin.p6.test/admin");
  const console = await f.app.respond(
    new Request("https://admin.p6.test/admin", { headers: { host: "admin.p6.test" } }),
  );
  assert.equal(console.status, 303);
  assert.equal(console.headers.get("location"), "https://admin.p6.test/admin/login");
});
