import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setup, password, type Fixture } from "../p6/helpers.js";
import { Media } from "../../src/server/media.js";
import { DEFAULT_RETENTION } from "../../src/server/retention.js";
import type { Operator } from "../../src/server/operators.js";

const basePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SIZE = 1000;
// The parser only reads the PNG header, so trailing bytes give distinct hashes of a fixed size.
function png(seed: number, size = SIZE) {
  const data = Buffer.alloc(size, 0);
  basePng.copy(data);
  data.writeUInt32BE(seed, size - 4);
  return data;
}
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const bodySha = async (response: Response) =>
  sha(Buffer.from(await response.arrayBuffer()));
const image = (seed: number, size = SIZE) => ({
  filename: `p${seed}.png`,
  mime: "image/png",
  data: png(seed, size).toString("base64"),
});

let f: Fixture, locale: string;
const ADMIN = "https://admin.p6.test";
const cookies = new Map<string, string>();
before(async () => {
  f = await setup();
  locale = (
    await f.pool.query("SELECT config->'locales'->>0 AS l FROM site WHERE id='atlas'")
  ).rows[0].l;
});
after(async () => {
  await f?.close();
});
beforeEach(async () => {
  await f.pool.query("DELETE FROM media");
  await f.pool.query("DELETE FROM site_limit");
  for (const entry of await readdir(f.mediaRoot))
    await rm(join(f.mediaRoot, entry), { recursive: true, force: true });
});
// Calls the admin API in-process as any operator, with a valid Origin for mutations.
async function as(
  operator: Operator,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  if (!cookies.has(operator.email))
    cookies.set(
      operator.email,
      "network_operator=" + (await f.app.sites.operators.login(operator.email, password)),
    );
  return f.app.respond(
    new Request(`${ADMIN}/admin/api${path}`, {
      method: init.method ?? "GET",
      headers: {
        host: "admin.p6.test",
        cookie: cookies.get(operator.email)!,
        origin: ADMIN,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}
const upload = (seed: number, site = "atlas", operator: Operator = f.editor) =>
  f.app.media.upload(operator, { site, alt: "原图", ...image(seed) });
const replace = async (id: string, seed: number, extra: Record<string, unknown> = {}) => {
  const response = await as(f.editor, `/media/${id}/replace`, {
    method: "POST",
    body: { ...image(seed), ...extra },
  });
  return { status: response.status, body: await response.json() };
};
const restore = async (id: string, version: number, operator: Operator = f.editor) => {
  const response = await as(operator, `/media/${id}/versions/${version}/restore`, {
    method: "POST",
    body: {},
  });
  return { status: response.status, body: await response.json() };
};
const removeVersion = (id: string, version: number, operator: Operator = f.editor) =>
  as(operator, `/media/${id}/versions/${version}`, { method: "DELETE" });
const history = async (id: string, operator: Operator = f.viewer) =>
  (await as(operator, `/media/${id}/versions`)).json();
const filesOnDisk = async (site = "atlas") =>
  (await readdir(join(f.mediaRoot, site)).catch(() => [] as string[]))
    .filter((name) => !name.startsWith("."))
    .sort();
const fileOf = (seed: number, site = "atlas") => join(f.mediaRoot, site, `${sha(png(seed))}.png`);
const exists = (path: string) => lstat(path).then(() => true, () => false);
const usage = async () => {
  const value = await f.app.media.usage(f.viewer, "atlas");
  return { files: value.files, bytes: value.bytes };
};
const limit = (values: Record<string, number | null>) =>
  f.app.limits.save(f.admin, { site: "atlas", ...values });
const old = async (path: string, minutes = 120) => {
  const time = new Date(Date.now() - minutes * 60_000);
  await utimes(path, time, time);
};

test("P8 media replace creates a new current version mirrored on the media row", async () => {
  const item = await upload(1);
  const replaced = await replace(item.id, 2, { filename: "new.png", alt: "新说明" });
  assert.equal(replaced.status, 201);
  assert.equal(replaced.body.id, item.id);
  assert.equal(replaced.body.version, 2);
  assert.equal(replaced.body.sha256, sha(png(2)));
  assert.equal(replaced.body.filename, "new.png");
  assert.equal(replaced.body.alt, "新说明");
  assert.equal(replaced.body.url, `/media/${item.id}/2`);
  const row = (
    await f.pool.query("SELECT version,sha256,filename,bytes FROM media WHERE id=$1", [item.id])
  ).rows[0];
  const current = (
    await f.pool.query(
      "SELECT version,sha256,filename,bytes,restored_from,created_by FROM media_version WHERE media_id=$1 ORDER BY version",
      [item.id],
    )
  ).rows;
  assert.equal(current.length, 2);
  assert.deepEqual(
    { version: row.version, sha256: row.sha256, filename: row.filename, bytes: row.bytes },
    {
      version: current[1].version,
      sha256: current[1].sha256,
      filename: current[1].filename,
      bytes: current[1].bytes,
    },
  );
  assert.equal(current[1].restored_from, null);
  assert.equal(current[1].created_by, f.editor.id);
  // Without alt the description is kept; both files stay on disk.
  const third = await replace(item.id, 3);
  assert.equal(third.body.version, 3);
  assert.equal(third.body.alt, "新说明");
  assert.deepEqual(await filesOnDisk(), [1, 2, 3].map((s) => `${sha(png(s))}.png`).sort());
  assert.deepEqual(await usage(), { files: 1, bytes: 3 * SIZE });
  // The list and the admin preview follow the current version.
  const list = await (await as(f.viewer, "/media?site=atlas")).json();
  assert.equal(list[0].version, 3);
  assert.equal(await bodySha(await as(f.viewer, `/media/${item.id}/file`)), sha(png(3)));

  const same = await replace(item.id, 3);
  assert.equal(same.status, 409);
  assert.match(same.body.error, /与当前版本内容相同/);
  const fake = await as(f.editor, `/media/${item.id}/replace`, {
    method: "POST",
    body: { filename: "x.png", mime: "image/png", data: Buffer.from("not an image").toString("base64") },
  });
  assert.equal(fake.status, 415);
  const mismatch = await replace(item.id, 4, { mime: "image/jpeg" });
  assert.equal(mismatch.status, 415);
  const extra = await replace(item.id, 4, { site: "atlas" });
  assert.equal(extra.status, 400);
  const missing = await as(f.editor, `/media/${randomUUID()}/replace`, {
    method: "POST",
    body: image(4),
  });
  assert.equal(missing.status, 404);
  assert.equal((await history(item.id)).versions.length, 3);
});

test("P8 media replace counts bytes once per stored content and never adds files", async () => {
  await limit({ mediaBytes: SIZE * 2 + SIZE / 2, mediaFiles: 2 });
  const a = await upload(1),
    b = await upload(2);
  assert.deepEqual(await usage(), { files: 2, bytes: 2 * SIZE });
  const over = await replace(a.id, 3);
  assert.equal(over.status, 413);
  assert.match(over.body.error, /媒体存储空间不足/);
  assert.equal(await exists(fileOf(3)), false);
  assert.equal((await history(a.id)).versions.length, 1);
  // B's content is already stored: replacing A with it is free and shares the file.
  const shared = await replace(a.id, 2);
  assert.equal(shared.status, 201);
  assert.deepEqual(await usage(), { files: 2, bytes: 2 * SIZE });
  // Content that survives only as A's v1 is also free, even at the file-count limit.
  const back = await replace(b.id, 1);
  assert.equal(back.status, 201);
  assert.deepEqual(await usage(), { files: 2, bytes: 2 * SIZE });
  assert.equal((await filesOnDisk()).length, 2);
  // A smaller new image still fits in the remaining space.
  const small = await as(f.editor, `/media/${a.id}/replace`, {
    method: "POST",
    body: image(4, SIZE / 2),
  });
  assert.equal(small.status, 201);
  assert.deepEqual(await usage(), { files: 2, bytes: 2 * SIZE + SIZE / 2 });
  const response = await f.api("/media/usage?site=atlas");
  assert.equal((await response.json()).bytes, 2 * SIZE + SIZE / 2);
});

test("P8 media version history, restore and per-version previews", async () => {
  const item = await upload(1, "atlas", f.admin);
  await replace(item.id, 2);
  const restored = await restore(item.id, 1);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.version, 3);
  assert.equal(restored.body.sha256, sha(png(1)));
  assert.equal(restored.body.filename, "p1.png");
  // Restore never writes a file nor uses quota.
  assert.deepEqual(await usage(), { files: 1, bytes: 2 * SIZE });

  const response = await as(f.viewer, `/media/${item.id}/versions`);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.media.id, item.id);
  assert.equal(value.media.version, 3);
  assert.deepEqual(
    value.versions.map((v: Record<string, unknown>) => [
      v.version,
      v.sha256,
      v.restoredFrom,
      v.createdBy,
      v.current,
      v.published,
      v.pinned,
      v.adminUrl,
    ]),
    [
      [3, sha(png(1)), 1, f.editor.email, true, false, false, `/admin/api/media/${item.id}/versions/3/file`],
      [2, sha(png(2)), null, f.editor.email, false, false, false, `/admin/api/media/${item.id}/versions/2/file`],
      [1, sha(png(1)), null, f.admin.email, false, false, false, `/admin/api/media/${item.id}/versions/1/file`],
    ],
  );
  const first = value.versions[2];
  assert.deepEqual(
    { filename: first.filename, mime: first.mime, bytes: first.bytes, width: first.width, height: first.height },
    { filename: "p1.png", mime: "image/png", bytes: SIZE, width: 1, height: 1 },
  );
  assert.ok(!Number.isNaN(Date.parse(first.createdAt)));

  const preview = await as(f.viewer, `/media/${item.id}/versions/2/file`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await bodySha(preview), sha(png(2)));
  assert.equal((await as(f.viewer, `/media/${item.id}/versions/9/file`)).status, 404);
  assert.equal((await as(f.viewer, `/media/${item.id}/versions/0/file`)).status, 404);

  const current = await restore(item.id, 3);
  assert.equal(current.status, 409);
  assert.match(current.body.error, /已是当前版本/);
  const absent = await restore(item.id, 9);
  assert.equal(absent.status, 404);
  const body = await as(f.editor, `/media/${item.id}/versions/2/restore`, {
    method: "POST",
    body: { force: true },
  });
  assert.equal(body.status, 400);
  // A version whose file went missing cannot become current.
  await rm(fileOf(2));
  const lost = await restore(item.id, 2);
  assert.equal(lost.status, 409);
  assert.equal((await history(item.id)).versions.length, 3);
});

test("P8 media version delete protects current and removes only unshared files", async () => {
  const a = await upload(1),
    b = await upload(5);
  await replace(a.id, 2);
  await replace(a.id, 3);
  await restore(a.id, 1); // a: v1=1 v2=2 v3=3 v4=1(current)
  await replace(b.id, 2); // b: v1=5 v2=2(current), shares 2 with a v2
  const current = await removeVersion(a.id, 4);
  assert.equal(current.status, 409);
  assert.match((await current.json()).error, /当前版本/);
  assert.equal((await removeVersion(a.id, 9)).status, 404);

  assert.deepEqual(await (await removeVersion(a.id, 2)).json(), { ok: true });
  assert.equal(await exists(fileOf(2)), true, "still b's current version");
  assert.equal((await removeVersion(a.id, 1)).status, 200);
  assert.equal(await exists(fileOf(1)), true, "still a's current version");
  assert.equal((await removeVersion(a.id, 3)).status, 200);
  assert.equal(await exists(fileOf(3)), false);
  assert.equal((await removeVersion(a.id, 3)).status, 404);
  assert.deepEqual(
    (await history(a.id)).versions.map((v: { version: number }) => v.version),
    [4],
  );
  assert.deepEqual(await usage(), { files: 2, bytes: 3 * SIZE });

  // Deleting a media removes each of its files unless another media still uses it.
  const c = await upload(6);
  await replace(c.id, 5); // c v2 shares b's v1 file
  assert.equal((await as(f.editor, `/media/${b.id}`, { method: "DELETE" })).status, 200);
  assert.equal(await exists(fileOf(5)), true);
  assert.equal(await exists(fileOf(2)), false);
  await f.app.media.remove(f.editor, c.id);
  assert.equal(await exists(fileOf(5)), false);
  assert.equal(await exists(fileOf(6)), false);
  assert.deepEqual(await filesOnDisk(), [`${sha(png(1))}.png`]);
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM media_version")).rows[0].n,
    1,
  );
});

test("P8 media version routes enforce site permissions and write audit rows", async () => {
  const item = await upload(1);
  const other = await upload(9, "notes", f.admin);
  // Viewers read history and previews but cannot change anything.
  assert.equal((await as(f.viewer, `/media/${item.id}/versions`)).status, 200);
  assert.equal((await as(f.viewer, `/media/${item.id}/versions/1/file`)).status, 200);
  const denied = await as(f.viewer, `/media/${item.id}/replace`, {
    method: "POST",
    body: image(2),
  });
  assert.equal(denied.status, 403);
  const created = await replace(item.id, 2);
  assert.equal(created.status, 201);
  assert.equal((await restore(item.id, 1, f.viewer)).status, 403);
  assert.equal((await removeVersion(item.id, 1, f.viewer)).status, 403);
  assert.equal((await as(f.viewer, `/media/${item.id}`, { method: "DELETE" })).status, 403);
  // No grant on notes: every route is refused for the editor.
  assert.equal((await as(f.editor, `/media/${other.id}/versions`)).status, 403);
  assert.equal((await as(f.editor, `/media/${other.id}/versions/1/file`)).status, 403);
  assert.equal(
    (await as(f.editor, `/media/${other.id}/replace`, { method: "POST", body: image(3) })).status,
    403,
  );
  assert.equal((await restore(other.id, 1)).status, 403);
  assert.equal((await removeVersion(other.id, 1)).status, 403);
  // Mutations need the admin Origin.
  const noOrigin = await f.app.respond(
    new Request(`${ADMIN}/admin/api/media/${item.id}/versions/1`, {
      method: "DELETE",
      headers: { host: "admin.p6.test", cookie: cookies.get(f.editor.email)! },
    }),
  );
  assert.equal(noOrigin.status, 403);
  assert.equal((await history(item.id)).versions.length, 2);

  assert.equal((await restore(item.id, 1)).status, 200);
  assert.equal((await removeVersion(item.id, 2)).status, 200);
  const audit = (
    await f.pool.query(
      "SELECT actor_id,site_id,action,detail FROM audit_event WHERE action LIKE 'media.%' AND detail->>'mediaId'=$1 ORDER BY id",
      [item.id],
    )
  ).rows;
  assert.deepEqual(
    audit.map((row) => [row.actor_id, row.site_id, row.action]),
    [
      [f.editor.id, "atlas", "media.replace"],
      [f.editor.id, "atlas", "media.restore"],
      [f.editor.id, "atlas", "media.version.delete"],
    ],
  );
  assert.deepEqual(
    { version: audit[0].detail.version, previousVersion: audit[0].detail.previousVersion, sha256: audit[0].detail.sha256 },
    { version: 2, previousVersion: 1, sha256: sha(png(2)) },
  );
  assert.deepEqual(
    { version: audit[1].detail.version, restoredFrom: audit[1].detail.restoredFrom },
    { version: 3, restoredFrom: 1 },
  );
  assert.deepEqual(
    { version: audit[2].detail.version, fileRemoved: audit[2].detail.fileRemoved },
    { version: 2, fileRemoved: true },
  );
});

test("P8 media upload dedupes against current versions only", async () => {
  await limit({ mediaBytes: SIZE * 2, mediaFiles: 3 });
  const a = await upload(1);
  await replace(a.id, 2);
  const historical = fileOf(1);
  await old(historical);
  const before = (await stat(historical)).mtimeMs;
  // Current content returns the existing media.
  const again = await upload(2);
  assert.equal(again.id, a.id);
  assert.equal(again.version, 2);
  // Content kept only in history becomes a new media, reusing the stored file and bytes.
  const fresh = await upload(1);
  assert.notEqual(fresh.id, a.id);
  assert.equal(fresh.version, 1);
  assert.equal((await stat(historical)).mtimeMs, before);
  assert.deepEqual(await usage(), { files: 2, bytes: 2 * SIZE });
  // Now that it is current somewhere, it dedupes to that media.
  assert.equal((await upload(1)).id, fresh.id);
  // Genuinely new content is still held to the byte quota.
  await assert.rejects(upload(3), { status: 413 });
  // Removing the new media keeps the file a's history still uses.
  await f.app.media.remove(f.editor, fresh.id);
  assert.equal(await exists(historical), true);
});

test("P8 media orphan cleanup keeps files referenced only by history", async () => {
  const item = await upload(1);
  await replace(item.id, 2);
  const orphan = fileOf(7);
  await writeFile(orphan, png(7));
  for (const path of [fileOf(1), fileOf(2), orphan]) await old(path);
  const media = new Media(f.pool, f.mediaRoot);
  const result = await media.cleanupOrphans(DEFAULT_RETENTION);
  assert.equal(result.removedOrphans, 1);
  assert.equal(result.missingFiles, 0);
  assert.equal(await exists(orphan), false);
  assert.deepEqual(await readFile(fileOf(1)), png(1));
  assert.equal(await exists(fileOf(2)), true);
  // A missing historical file is reported, never fixed by deleting rows.
  await rm(fileOf(1));
  assert.equal((await media.cleanupOrphans(DEFAULT_RETENTION)).missingFiles, 1);
  assert.equal((await history(item.id)).versions.length, 2);
  // Once the version is deleted, its file is no longer expected.
  assert.equal((await removeVersion(item.id, 1)).status, 200);
  assert.equal((await media.cleanupOrphans(DEFAULT_RETENTION)).missingFiles, 0);
});

async function publishWith(resource: string, mediaId: string) {
  const version = async (table: string) =>
    Number(
      (
        await f.pool.query(
          `SELECT version FROM ${table} WHERE site_id='atlas' AND resource_id=$1 AND locale=$2`,
          [resource, locale],
        )
      ).rows[0]?.version ?? 0,
    );
  const published = await version("publication");
  const draft = await f.app.content.stage(f.admin, "atlas", resource, locale, {
    candidate: {
      resourceVersion: 1,
      slug: resource,
      overrides: { image: { mediaId, alt: "资源封面" } },
    },
    expected: { published, draft: await version("content_draft") },
  });
  await f.app.content.publish(f.admin, "atlas", resource, locale, {
    expected: { published, draft },
    operationId: randomUUID(),
  });
}
const fetchPublic = (path: string) =>
  f.app.respond(new Request(`https://atlas.p6.test${path}`, { headers: { host: "atlas.p6.test" } }));

test("P8 media end-to-end: replace keeps published version until republish", async () => {
  await f.app.content.saveResource(f.admin, {
    id: "versioned",
    expectedVersion: 0,
    data: {
      url: "https://example.com/versioned",
      source: "manual",
      translations: { [locale]: { title: "Versioned", description: "Versioned item" } },
    },
    public: true,
  });
  const item = await upload(1);
  await publishWith("versioned", item.id);
  assert.equal((await replace(item.id, 2)).status, 201);

  const v1 = await fetchPublic(`/media/${item.id}/1`);
  assert.equal(v1.status, 200);
  assert.equal(await bodySha(v1), sha(png(1)));
  assert.equal((await fetchPublic(`/media/${item.id}/2`)).status, 404);
  let value = await history(item.id);
  assert.deepEqual(
    value.versions.map((v: Record<string, unknown>) => [v.version, v.current, v.published, v.pinned]),
    [
      [2, true, false, false],
      [1, false, true, true],
    ],
  );
  const pinned = await removeVersion(item.id, 1);
  assert.equal(pinned.status, 409);
  assert.match((await pinned.json()).error, /发布记录引用/);
  assert.equal((await as(f.editor, `/media/${item.id}`, { method: "DELETE" })).status, 409);

  await publishWith("versioned", item.id);
  const v2 = await fetchPublic(`/media/${item.id}/2`);
  assert.equal(v2.status, 200);
  assert.equal(await bodySha(v2), sha(png(2)));
  assert.equal((await fetchPublic(`/media/${item.id}/1`)).status, 404);
  value = await history(item.id);
  assert.deepEqual(
    value.versions.map((v: Record<string, unknown>) => [v.version, v.published, v.pinned]),
    [
      [2, true, true],
      [1, false, false],
    ],
  );
  // v1 is no longer referenced by any publication: deleting it frees its unshared file.
  assert.equal((await removeVersion(item.id, 1)).status, 200);
  assert.equal(await exists(fileOf(1)), false);
  assert.equal(await exists(fileOf(2)), true);

  // A shared historical file survives deleting the version that used it.
  const other = await upload(3);
  await replace(item.id, 3); // item v3 shares other's file
  await publishWith("versioned", item.id);
  assert.equal((await fetchPublic(`/media/${item.id}/3`)).status, 200);
  await replace(item.id, 4); // v4 is current but unpublished
  await publishWith("versioned", item.id);
  assert.equal((await removeVersion(item.id, 3)).status, 200);
  assert.equal(await exists(fileOf(3)), true);
  assert.equal((await f.app.media.adminFile(f.viewer, other.id)).data.length, SIZE);

  // Unpublished rows still pin their version, so the media itself stays protected.
  const publication = (
    await f.pool.query(
      "SELECT version FROM publication WHERE site_id='atlas' AND resource_id='versioned' AND locale=$1",
      [locale],
    )
  ).rows[0].version;
  await f.app.content.unpublish(f.admin, "atlas", "versioned", locale, publication);
  assert.deepEqual(await f.app.content.mediaUsage("atlas", item.id), {
    published: false,
    draft: false,
  });
  const blocked = await as(f.editor, `/media/${item.id}`, { method: "DELETE" });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /第 4 版/);
  // Media nobody publishes can still be deleted with all of its versions.
  assert.equal((await as(f.editor, `/media/${other.id}`, { method: "DELETE" })).status, 200);
  assert.equal(await exists(fileOf(3)), false);
});
