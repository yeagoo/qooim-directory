// Upgrading an M12 database (migrations up to 014) to the M13a content model (015).
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";

let pool: Pool;
before(async () => {
  pool = await database();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const dir = await mkdtemp(join(tmpdir(), "p13-migrate-"));
  try {
    for (const file of await readdir("migrations"))
      if (/^0(0\d|1[0-4])-/.test(file)) await cp(join("migrations", file), join(dir, file));
    await migrate(pool, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await pool.query("INSERT INTO site(id,host,config,modules) VALUES('atlas','atlas.test',$1,ARRAY['directory'])", [
    { name: "Atlas", template: "basic", locales: ["zh"], navigation: [], catalogPath: "tools", tagline: "" },
  ]);
  await pool.query(
    "INSERT INTO resource(id,internal_note,public,version,data) VALUES('a','',true,1,'{}'),('b','',true,1,'{}'),('c','',true,1,'{}'),('d','',true,1,'{}')",
  );
  await pool.query("INSERT INTO category(site_id,id,labels) VALUES('atlas','design','{\"zh\":\"设计\"}')");
  await pool.query(
    `INSERT INTO publication(site_id,resource_id,locale,slug,title,status,category_id,version) VALUES
     ('atlas','a','zh','a','A','published','design',2),
     ('atlas','b','zh','b','B','published',NULL,1),
     ('atlas','c','zh','c','C','draft',NULL,1),
     ('atlas','d','zh','d','D','draft',NULL,2)`,
  );
  await pool.query(
    `INSERT INTO audit_event(site_id,action,detail,created_at) VALUES
     ('atlas','publication.publish','{"resource":"a","locale":"zh","version":1}','2026-01-01T00:00:00Z'),
     ('atlas','publication.publish','{"resource":"a","locale":"zh","version":2}','2026-02-01T00:00:00Z'),
     ('atlas','publication.publish','{"resource":"a","locale":"en","version":1}','2026-03-01T00:00:00Z'),
     ('atlas','publication.publish','{"resource":"d","locale":"zh","version":1}','2026-04-01T00:00:00Z'),
     ('atlas','publication.publish','{"resource":"d","locale":"zh","version":2}','2026-05-01T00:00:00Z')`,
  );
  await migrate(pool);
});
after(async () => {
  await pool?.end();
});

test("P13 migration backfills category_ids and publish times from the audit log", async () => {
  const rows = (
    await pool.query(
      "SELECT resource_id,category_ids,tag_ids,details,logo,first_published_at,published_at FROM publication ORDER BY resource_id",
    )
  ).rows;
  const [a, b, c, d] = rows;
  assert.deepEqual(a.category_ids, ["design"]);
  assert.deepEqual(a.tag_ids, []);
  assert.deepEqual(a.details, {});
  assert.equal(a.logo, null);
  // Only this locale's events count.
  assert.equal(a.first_published_at.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(a.published_at.toISOString(), "2026-02-01T00:00:00.000Z");
  // Published without an audit trail: the migration time.
  assert.deepEqual(b.category_ids, []);
  assert.ok(b.first_published_at instanceof Date);
  assert.equal(b.first_published_at.getTime(), b.published_at.getTime());
  // Never published: no times.
  assert.equal(c.first_published_at, null);
  assert.equal(c.published_at, null);
  // Unpublished after publishing keeps the true first/last publish times.
  assert.equal(d.first_published_at.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(d.published_at.toISOString(), "2026-05-01T00:00:00.000Z");
  const listing = (await pool.query("SELECT slug,published_at,updated_at,category_ids FROM public_listing ORDER BY slug")).rows;
  assert.deepEqual(
    listing.map((r) => r.slug),
    ["a", "b"],
  );
  assert.equal(listing[0].published_at.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(listing[0].updated_at.toISOString(), "2026-02-01T00:00:00.000Z");
});
