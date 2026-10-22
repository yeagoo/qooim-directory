import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, password, type Fixture } from "./helpers.js";
import { Media } from "../../src/server/media.js";
import { runMaintenance } from "../../src/server/maintenance.js";
import { DEFAULT_RETENTION } from "../../src/server/retention.js";
import { DEFAULT_LIMITS } from "../../src/server/limits.js";

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
const body = (seed: number, size = SIZE, site = "atlas") => ({
  site,
  filename: `p${seed}.png`,
  mime: "image/png",
  alt: "测试图片",
  data: png(seed, size).toString("base64"),
});

let f: Fixture;
before(async () => {
  f = await setup();
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
const limit = (values: Record<string, number | null>) =>
  f.app.limits.save(f.admin, { site: "atlas", ...values });
const rows = async (site = "atlas") =>
  (
    await f.pool.query("SELECT count(*)::int AS n FROM media WHERE site_id=$1", [site])
  ).rows[0].n as number;
const filesOnDisk = async (site = "atlas") =>
  (await readdir(join(f.mediaRoot, site)).catch(() => [] as string[])).sort();
const upload = (seed: number, size = SIZE) =>
  f.app.media.upload(f.editor, body(seed, size));
const old = async (path: string, minutes = 120) => {
  const time = new Date(Date.now() - minutes * 60_000);
  await utimes(path, time, time);
};
async function viewerApi(path: string) {
  const host = "admin.p6.test";
  const cookie =
    "network_operator=" +
    (await f.app.sites.operators.login(f.viewer.email, password));
  return f.app.respond(
    new Request(`https://${host}/admin/api${path}`, { headers: { host, cookie } }),
  );
}

test("P6 media bytes quota rejects uploads that would exceed the limit", async () => {
  await limit({ mediaBytes: SIZE * 2 + SIZE / 2 });
  await upload(1);
  await upload(2);
  const response = await f.api("/media", { method: "POST", body: body(3) });
  assert.equal(response.status, 413);
  const { error } = await response.json();
  assert.match(error, /媒体存储空间不足/);
  assert.match(error, /2\.4 KiB/);
  // A smaller image that fits in the remaining space is still accepted.
  await upload(4, SIZE / 2);
  await assert.rejects(upload(5, 100), { status: 413 });
  assert.equal(await rows(), 3);
  assert.equal((await filesOnDisk()).length, 3);
});

test("P6 media file-count quota and dedupe without consuming quota", async () => {
  await limit({ mediaFiles: 2 });
  const first = await upload(1);
  await upload(2);
  await assert.rejects(upload(3), (error: { status: number; message: string }) => {
    assert.equal(error.status, 413);
    assert.match(error.message, /最多 2 个文件/);
    return true;
  });
  // Same content again at the limit: returns the stored row, no new quota used.
  const again = await f.app.media.upload(f.editor, { ...body(1), filename: "copy.png" });
  assert.equal(again.id, first.id);
  assert.equal(again.filename, "p1.png");
  assert.equal(await rows(), 2);
  // A re-upload also restores a file that went missing on disk.
  await rm(join(f.mediaRoot, "atlas", `${first.sha256}.png`));
  await upload(1);
  assert.deepEqual(
    await readFile(join(f.mediaRoot, "atlas", `${first.sha256}.png`)),
    png(1),
  );
  // Other sites are unaffected by atlas' limit.
  await f.app.media.upload(f.admin, body(3, SIZE, "notes"));
  assert.equal(await rows("notes"), 1);
  const usage = await f.app.media.usage(f.viewer, "atlas");
  assert.deepEqual(
    { files: usage.files, bytes: usage.bytes },
    { files: 2, bytes: SIZE * 2 },
  );
});

test("P6 media concurrent uploads at the boundary admit exactly the limit", async () => {
  await limit({ mediaFiles: 3 });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => upload(100 + i)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  for (const r of results.filter((r) => r.status === "rejected"))
    assert.equal((r as PromiseRejectedResult).reason.status, 413);
  assert.equal(await rows(), 3);
  assert.equal((await filesOnDisk()).length, 3);

  await f.pool.query("DELETE FROM media");
  await rm(join(f.mediaRoot, "atlas"), { recursive: true });
  await limit({ mediaFiles: null, mediaBytes: SIZE * 4 });
  const bytes = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => upload(200 + i)),
  );
  assert.equal(bytes.filter((r) => r.status === "fulfilled").length, 4);
  assert.equal(await rows(), 4);
  // No temporary files survive rejected or accepted uploads.
  assert.deepEqual(
    (await filesOnDisk()).filter((name) => name.startsWith(".tmp-")),
    [],
  );
});

test("P6 media lowered limit blocks new uploads but keeps existing files", async () => {
  const items = [await upload(1), await upload(2), await upload(3)];
  await limit({ mediaFiles: 1, mediaBytes: SIZE });
  await assert.rejects(upload(4), { status: 413 });
  assert.equal(await rows(), 3);
  for (const item of items) {
    const { data } = await f.app.media.adminFile(f.viewer, item.id);
    assert.equal(data.length, SIZE);
  }
  // Re-uploading stored content still succeeds; deleting frees quota.
  assert.equal((await upload(2)).id, items[1]!.id);
  await f.app.media.remove(f.editor, items[0]!.id);
  await f.app.media.remove(f.editor, items[1]!.id);
  await assert.rejects(upload(4), { status: 413 });
  await f.app.media.remove(f.editor, items[2]!.id);
  await upload(4);
  assert.equal(await rows(), 1);
  assert.equal((await filesOnDisk()).length, 1);
});

test("P6 media failed insert removes the placed file", async () => {
  await f.pool.query(`CREATE FUNCTION p6_media_boom() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.filename='boom.png' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
  await f.pool.query(
    "CREATE TRIGGER p6_media_boom BEFORE INSERT ON media FOR EACH ROW EXECUTE FUNCTION p6_media_boom()",
  );
  try {
    await assert.rejects(
      f.app.media.upload(f.editor, { ...body(7), filename: "boom.png" }),
      /boom/,
    );
    assert.deepEqual(await filesOnDisk(), []);
    await upload(7);
    assert.deepEqual(await filesOnDisk(), [`${sha(png(7))}.png`]);
  } finally {
    await f.pool.query("DROP TRIGGER p6_media_boom ON media");
    await f.pool.query("DROP FUNCTION p6_media_boom()");
  }
});

test("P6 media usage endpoint reports usage, limits and enforces permissions", async () => {
  await upload(1);
  await upload(2, 500);
  await limit({ mediaFiles: 10 });
  const response = await f.api("/media/usage?site=atlas");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    site: "atlas",
    bytes: SIZE + 500,
    files: 2,
    limitBytes: DEFAULT_LIMITS.mediaBytes,
    limitFiles: 10,
  });
  const empty = await (await f.api("/media/usage?site=notes")).json();
  assert.equal(empty.files, 0);
  assert.equal(empty.bytes, 0);
  assert.equal((await viewerApi("/media/usage?site=atlas")).status, 200);
  assert.equal((await viewerApi("/media/usage?site=notes")).status, 403);
  assert.equal((await f.api("/media/usage?site=Bad")).status, 400);
  assert.equal((await f.api("/media/usage", { method: "POST", body: {} })).status, 405);
  // Existing id routes are unaffected by the usage route.
  const list = await (await f.api("/media?site=atlas")).json();
  assert.equal(list.length, 2);
  assert.equal((await f.api(`/media/${list[0].id}/file`)).status, 200);
});

test("P6 media orphan cleanup removes stale files only", async () => {
  const site = join(f.mediaRoot, "atlas");
  const kept = await upload(1);
  const keptPath = join(site, `${kept.sha256}.png`);
  await old(keptPath);
  const write = async (name: string, data: Buffer | string = png(9), age = 120) => {
    const path = join(site, name);
    await writeFile(path, data);
    if (age) await old(path, age);
    return path;
  };
  const oldTmp = await write(".tmp-old");
  const newTmp = await write(".tmp-new", png(9), 0);
  const oldOrphan = await write(`${sha(png(10))}.png`, png(10));
  const newOrphan = await write(`${sha(png(11))}.png`, png(11), 30);
  // Same hash as a stored row but another extension: not referenced.
  const wrongExt = await write(`${kept.sha256}.jpg`, png(1));
  const unknown = await write("notes.txt", "keep me");
  const upper = await write(`${sha(png(12)).toUpperCase()}.png`, png(12));
  // Symlinks are never followed nor removed, including site directories.
  const outside = await mkdtemp(join(tmpdir(), "p6-outside-"));
  try {
    const target = join(outside, "target.png");
    await writeFile(target, png(13));
    await old(target);
    const link = join(site, `${sha(png(13))}.png`);
    await symlink(target, link);
    await writeFile(join(outside, `${sha(png(14))}.png`), png(14));
    await old(join(outside, `${sha(png(14))}.png`));
    await symlink(outside, join(f.mediaRoot, "linked"));
    await mkdir(join(f.mediaRoot, "Bad_Dir"));
    const badDirFile = join(f.mediaRoot, "Bad_Dir", `${sha(png(15))}.png`);
    await writeFile(badDirFile, png(15));
    await old(badDirFile);
    await mkdir(join(site, "nested"));
    // A row whose file is gone is reported, never deleted.
    const gone = await upload(2);
    await rm(join(site, `${gone.sha256}.png`));

    const result = await new Media(f.pool, f.mediaRoot).cleanupOrphans(DEFAULT_RETENTION);
    assert.deepEqual(result, {
      scanned: 10,
      removedTemp: 1,
      removedOrphans: 2,
      missingFiles: 1,
      skipped: 5,
    });
    const exists = (path: string) => lstat(path).then(() => true, () => false);
    assert.equal(await exists(oldTmp), false);
    assert.equal(await exists(newTmp), true);
    assert.equal(await exists(oldOrphan), false);
    assert.equal(await exists(newOrphan), true);
    assert.equal(await exists(wrongExt), false);
    assert.equal(await exists(keptPath), true);
    assert.equal(await exists(unknown), true);
    assert.equal(await exists(upper), true);
    assert.equal(await exists(link), true);
    assert.deepEqual(await readFile(target), png(13));
    assert.equal(await exists(join(outside, `${sha(png(14))}.png`)), true);
    assert.equal(await exists(badDirFile), true);
    assert.equal(await rows(), 2);
    assert.equal((await f.app.media.adminFile(f.viewer, kept.id)).data.length, SIZE);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("P6 media cleanup waits for the per-site upload lock", async () => {
  const data = png(20);
  const path = join(f.mediaRoot, "atlas", `${sha(data)}.png`);
  await mkdir(join(f.mediaRoot, "atlas"), { recursive: true });
  await writeFile(path, data);
  await old(path);
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('media:'||$1))", ["atlas"]);
    let settled = false;
    const cleanup = new Media(f.pool, f.mediaRoot)
      .cleanupOrphans(DEFAULT_RETENTION)
      .finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false);
    // The lock holder commits a row for the file: cleanup must then keep it.
    await client.query(
      `INSERT INTO media(site_id,filename,mime,bytes,width,height,sha256,alt,created_by)
       VALUES('atlas','late.png','image/png',$1,1,1,$2,'late',$3)`,
      [data.length, sha(data), f.editor.id],
    );
    await client.query("COMMIT");
    const result = await cleanup;
    assert.equal(result.removedOrphans, 0);
    assert.deepEqual(await readFile(path), data);
  } finally {
    client.release();
  }
});

test("P6 media cleanup tolerates a missing root and runs from maintenance", async () => {
  const missing = await new Media(f.pool, join(f.mediaRoot, "absent")).cleanupOrphans(
    DEFAULT_RETENTION,
  );
  assert.deepEqual(missing, {
    scanned: 0,
    removedTemp: 0,
    removedOrphans: 0,
    missingFiles: 0,
    skipped: 0,
  });
  await upload(1);
  const orphan = join(f.mediaRoot, "atlas", `${sha(png(30))}.png`);
  await writeFile(orphan, png(30));
  await old(orphan);
  const result = await runMaintenance(f.pool, { mediaRoot: f.mediaRoot, force: true });
  assert.ok(result);
  assert.equal(result.media!.removedOrphans, 1);
  assert.equal(result.media!.missingFiles, 0);
  assert.equal(await lstat(orphan).then(() => true, () => false), false);
  assert.equal((await filesOnDisk()).length, 1);
  const status = (
    await f.pool.query("SELECT detail FROM maintenance_status WHERE name='retention'")
  ).rows[0].detail;
  assert.equal(status.media.removedOrphans, 1);
});

test("P6 media page shows usage against limits and surfaces quota errors", async () => {
  await limit({ mediaFiles: 1 });
  await upload(1);
  const editor = await f.browse(f.editor, "#media/atlas");
  try {
    const { page } = editor;
    await page.waitForSelector("#media-usage");
    const text = (await page.textContent("#media-usage")) ?? "";
    assert.match(text, /文件数量：1 \/ 1（100%）/);
    assert.match(text, /存储空间：1 KiB \/ 1\.00 GiB/);
    assert.match(text, /已达到配额上限/);
    await page.setInputFiles("#media-file", {
      name: "next.png",
      mimeType: "image/png",
      buffer: png(2),
    });
    await page.fill("#media-alt", "新图片");
    await page.click("#upload-media");
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("媒体文件数量已达上限"),
    );
    assert.match(
      (await page.getAttribute("#message", "class")) ?? "",
      /error/,
    );
    assert.equal(await rows(), 1);
  } finally {
    await editor.close();
  }
});
