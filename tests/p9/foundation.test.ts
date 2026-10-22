import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
test("P9 migration constrains prompt versions and monthly reports", async () => {
  // Version 1 is the built-in prompt; stored versions start at 2.
  await assert.rejects(
    f.pool.query("INSERT INTO ai_prompt(kind,version,instructions) VALUES('seo',1,'x')"),
  );
  await assert.rejects(
    f.pool.query("INSERT INTO ai_prompt(kind,version,instructions) VALUES('other',2,'x')"),
  );
  await assert.rejects(
    f.pool.query("INSERT INTO ai_prompt(kind,version,instructions) VALUES('seo',2,'')"),
  );
  await f.pool.query("INSERT INTO ai_prompt(kind,version,instructions) VALUES('seo',2,'x')");
  await assert.rejects(
    f.pool.query("INSERT INTO ai_prompt(kind,version,instructions) VALUES('seo',2,'y')"),
  );
  await f.pool.query("DELETE FROM ai_prompt");
  // Reports are keyed by calendar month.
  await assert.rejects(
    f.pool.query(
      "INSERT INTO ai_usage_report(site_id,month,tokens_in,tokens_out) VALUES('atlas','2026-09-15',1,1)",
    ),
  );
  await assert.rejects(
    f.pool.query(
      "INSERT INTO ai_usage_report(site_id,month,tokens_in,tokens_out) VALUES('atlas','2026-09-01',-1,1)",
    ),
  );
  await f.pool.query(
    "INSERT INTO ai_usage_report(site_id,month,tokens_in,tokens_out) VALUES('atlas','2026-09-01',1,1)",
  );
  await f.pool.query("DELETE FROM ai_usage_report");
  const config = (
    await f.pool.query(
      "SELECT column_default FROM information_schema.columns WHERE table_name='ai_config' AND column_name='prompt_versions'",
    )
  ).rows[0];
  assert.match(config.column_default, /'\{\}'::jsonb/);
});
test("P9 billing page asset is served to the admin console only", async () => {
  const admin = await f.app.respond(
    new Request("https://admin.p6.test/assets/ai-billing-admin.js", {
      headers: { host: "admin.p6.test" },
    }),
  );
  assert.equal(admin.status, 200);
  const site = await f.app.respond(
    new Request("https://atlas.p6.test/assets/ai-billing-admin.js", {
      headers: { host: "atlas.p6.test" },
    }),
  );
  assert.equal(site.status, 404);
});
