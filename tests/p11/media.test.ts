import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setup, type Fixture } from "../p6/helpers.js";
import { Media } from "../../src/server/media.js";

const basePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SIZE = 1000;
// The parser only reads the PNG header, so trailing bytes give distinct hashes of a fixed size.
function png(seed: number) {
  const data = Buffer.alloc(SIZE, 0);
  basePng.copy(data);
  data.writeUInt32BE(seed, SIZE - 4);
  return data;
}
const sha = (seed: number) => createHash("sha256").update(png(seed)).digest("hex");
const image = (seed: number, filename = `p${seed}.png`) => ({
  filename,
  mime: "image/png",
  data: png(seed).toString("base64"),
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
  await f.pool.query("DELETE FROM audit_event WHERE action LIKE 'media.%'");
  await f.pool.query("DELETE FROM site_limit");
  for (const entry of await readdir(f.mediaRoot))
    await rm(join(f.mediaRoot, entry), { recursive: true, force: true });
});

const upload = (seed: number, media: Media = f.app.media, filename?: string) =>
  media.upload(f.editor, { site: "atlas", alt: "图片", ...image(seed, filename) });
const replace = (id: string, seed: number) => f.app.media.replace(f.editor, id, image(seed));
const fileOf = (seed: number) => join(f.mediaRoot, "atlas", `${sha(seed)}.png`);
const exists = (path: string) => lstat(path).then(() => true, () => false);
const filesOnDisk = async () =>
  (await readdir(join(f.mediaRoot, "atlas")).catch(() => [] as string[]))
    .filter((name) => !name.startsWith("."))
    .sort();
const mediaCount = async () =>
  (await f.pool.query("SELECT count(*)::int AS n FROM media")).rows[0].n as number;
const audits = async (action: string) =>
  (
    await f.pool.query(
      "SELECT actor_id,site_id,detail FROM audit_event WHERE action=$1 ORDER BY id",
      [action],
    )
  ).rows;
// Every current and historical version still has its file on disk.
async function assertNoMissingFiles(context: string) {
  const { rows } = await f.pool.query(
    `SELECT m.site_id,m.sha256,m.mime FROM media m
     UNION SELECT m.site_id,v.sha256,v.mime FROM media_version v JOIN media m ON m.id=v.media_id`,
  );
  for (const row of rows)
    assert.equal(
      await exists(join(f.mediaRoot, row.site_id, `${row.sha256}.png`)),
      true,
      `${context}: file of ${row.sha256} is missing`,
    );
}
// Fails the COMMIT (not the statement) of any transaction that writes this audit action.
async function failCommitOn(action: string, work: () => Promise<void>) {
  await f.pool.query(`CREATE FUNCTION p11_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action=TG_ARGV[0] THEN RAISE EXCEPTION 'p11 injected commit failure'; END IF; RETURN NULL; END $$`);
  await f.pool.query(
    `CREATE CONSTRAINT TRIGGER p11_fail_commit AFTER INSERT ON audit_event
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION p11_fail_commit('${action}')`,
  );
  try {
    await work();
  } finally {
    await f.pool.query("DROP TRIGGER p11_fail_commit ON audit_event");
    await f.pool.query("DROP FUNCTION p11_fail_commit()");
  }
}
async function failInsertOf(filename: string, work: () => Promise<void>) {
  await f.pool.query(`CREATE FUNCTION p11_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.filename=TG_ARGV[0] THEN RAISE EXCEPTION 'p11 injected insert failure'; END IF; RETURN NEW; END $$`);
  await f.pool.query(
    `CREATE TRIGGER p11_fail_insert BEFORE INSERT ON media FOR EACH ROW EXECUTE FUNCTION p11_fail_insert('${filename}')`,
  );
  try {
    await work();
  } finally {
    await f.pool.query("DROP TRIGGER p11_fail_insert ON media");
    await f.pool.query("DROP FUNCTION p11_fail_insert()");
  }
}
// A Media whose post-transaction file removal waits until released, exposing the window
// between the end of the mutation's transaction and the re-checked unlink.
function gatedMedia() {
  const media = new Media(f.pool, f.mediaRoot);
  const hooks = media as unknown as {
    sweep: (site: string, files: unknown[]) => Promise<void>;
  };
  const original = hooks.sweep.bind(media);
  let reached!: () => void, open!: () => void;
  const window = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  hooks.sweep = async (site, files) => {
    if (files.length) {
      reached();
      await gate;
    }
    return original(site, files);
  };
  return { media, window, open };
}
// Holds the site's media lock from another connection until released.
async function holdSiteLock() {
  const client = await f.pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('media:'||$1))", ["atlas"]);
  return async () => {
    await client.query("COMMIT");
    client.release();
  };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("P11 media delete whose commit fails keeps the row and its files", async () => {
  const item = await upload(1);
  await replace(item.id, 2);
  await failCommitOn("media.delete", async () => {
    await assert.rejects(f.app.media.remove(f.editor, item.id), /p11 injected commit failure/);
  });
  assert.equal(await mediaCount(), 1);
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM media_version WHERE media_id=$1", [item.id]))
      .rows[0].n,
    2,
  );
  assert.equal(await exists(fileOf(1)), true);
  assert.equal(await exists(fileOf(2)), true);
  assert.deepEqual(await audits("media.delete"), []);
  // Once the failure is gone the same delete succeeds and removes both files.
  await f.app.media.remove(f.editor, item.id);
  assert.equal(await mediaCount(), 0);
  assert.deepEqual(await filesOnDisk(), []);
});

test("P11 media version delete whose commit fails keeps the version and its file", async () => {
  const item = await upload(1);
  await replace(item.id, 2);
  await failCommitOn("media.version.delete", async () => {
    await assert.rejects(
      f.app.media.removeVersion(f.editor, item.id, 1),
      /p11 injected commit failure/,
    );
  });
  assert.deepEqual(
    (await f.app.media.versions(f.editor, item.id)).versions.map((v) => v.version),
    [2, 1],
  );
  assert.equal(await exists(fileOf(1)), true);
  assert.equal((await f.app.media.versionFile(f.editor, item.id, 1)).data.equals(png(1)), true);
  assert.deepEqual(await audits("media.version.delete"), []);
  await f.app.media.removeVersion(f.editor, item.id, 1);
  assert.equal(await exists(fileOf(1)), false);
  assert.equal((await audits("media.version.delete"))[0].detail.fileRemoved, true);
});

test("P11 media delete removes unshared files and keeps files shared across media and versions", async () => {
  const a = await upload(1);
  await replace(a.id, 2); // a: v1=1 v2=2(current)
  const b = await upload(3);
  await replace(b.id, 1); // b: v1=3 v2=1(current), shares a's historical v1
  const c = await upload(4);
  await replace(c.id, 2); // c: v1=4 v2=2(current), shares a's current
  const d = await upload(5);
  await replace(d.id, 6);
  await f.app.media.restore(f.editor, d.id, 1); // d: v1=5 v2=6 v3=5, shares within itself

  await f.app.media.remove(f.editor, a.id);
  assert.equal(await exists(fileOf(1)), true, "b's current version");
  assert.equal(await exists(fileOf(2)), true, "c's current version");
  await f.app.media.remove(f.editor, d.id);
  assert.equal(await exists(fileOf(5)), false);
  assert.equal(await exists(fileOf(6)), false);
  await f.app.media.remove(f.editor, b.id);
  assert.equal(await exists(fileOf(1)), false);
  assert.equal(await exists(fileOf(3)), false);
  assert.deepEqual(await filesOnDisk(), [sha(2), sha(4)].map((s) => `${s}.png`).sort());
  await assertNoMissingFiles("after deletes");

  const deleted = await audits("media.delete");
  assert.deepEqual(
    deleted.map((row) => [row.actor_id, row.site_id, row.detail]),
    [
      [f.editor.id, "atlas", { mediaId: a.id, versions: 2, filesRemoved: 0 }],
      [f.editor.id, "atlas", { mediaId: d.id, versions: 3, filesRemoved: 2 }],
      [f.editor.id, "atlas", { mediaId: b.id, versions: 2, filesRemoved: 2 }],
    ],
  );
});

test("P11 media re-upload committed between a delete's commit and its unlink keeps its file", async () => {
  const item = await upload(1);
  const gated = gatedMedia();
  const removing = gated.media.remove(f.editor, item.id);
  await gated.window; // deleted and committed; the file is still on disk
  assert.equal(await mediaCount(), 0);
  assert.equal(await exists(fileOf(1)), true);
  const again = await upload(1);
  assert.notEqual(again.id, item.id);
  gated.open();
  await removing;
  assert.equal(await exists(fileOf(1)), true);
  await assertNoMissingFiles("re-upload inside the unlink window");
  assert.equal((await audits("media.delete"))[0].detail.filesRemoved, 1);
});

test("P11 media re-upload waiting on the lock during a delete's unlink keeps its file", async () => {
  for (const uploadFirst of [false, true]) {
    await f.pool.query("DELETE FROM media");
    const item = await upload(1);
    const gated = gatedMedia();
    const removing = gated.media.remove(f.editor, item.id);
    await gated.window;
    // Both the unlink step and the re-upload queue on the site lock, in either order.
    const release = await holdSiteLock();
    let uploading: Promise<unknown>;
    if (uploadFirst) {
      uploading = upload(1);
      await pause(50);
      gated.open();
    } else {
      gated.open();
      await pause(50);
      uploading = upload(1);
    }
    await pause(50);
    await release();
    await Promise.all([removing, uploading]);
    assert.equal(await mediaCount(), 1);
    assert.equal(await exists(fileOf(1)), true, `uploadFirst=${uploadFirst}`);
    await assertNoMissingFiles(`lock order uploadFirst=${uploadFirst}`);
  }
});

test("P11 media concurrent delete and identical re-upload never lose a referenced file", async () => {
  for (let round = 0; round < 12; round++) {
    await f.pool.query("DELETE FROM media");
    // Odd rounds keep the content only as history, so the upload always creates a new row.
    const item = await upload(1);
    if (round % 2) await replace(item.id, 2);
    const delay = (round % 4) * 3;
    await Promise.all([
      f.app.media.remove(f.editor, item.id),
      pause(delay).then(() => upload(1)),
      pause(3 - (round % 4)).then(() => upload(1)),
    ]);
    await assertNoMissingFiles(`round ${round}`);
    const live = (await f.pool.query("SELECT count(*)::int AS n FROM media WHERE sha256=$1", [sha(1)]))
      .rows[0].n;
    assert.equal(await exists(fileOf(1)), live > 0, `round ${round}`);
  }
});

test("P11 media failed insert removes the placed file after the transaction, only if unreferenced", async () => {
  // Unreferenced content: the file is still present until the transaction has ended.
  const gated = gatedMedia();
  await failInsertOf("boom.png", async () => {
    const uploading = upload(7, gated.media, "boom.png");
    await gated.window;
    assert.equal(await exists(fileOf(7)), true);
    assert.equal(await mediaCount(), 0);
    gated.open();
    await assert.rejects(uploading, /p11 injected insert failure/);
  });
  assert.deepEqual(await filesOnDisk(), []);
  assert.deepEqual(await audits("media.upload"), []);

  // Content kept only as history whose file went missing: restored, and kept after the failure.
  const a = await upload(1);
  await replace(a.id, 2);
  await rm(fileOf(1));
  await failInsertOf("boom.png", async () => {
    await assert.rejects(upload(1, f.app.media, "boom.png"), /p11 injected insert failure/);
  });
  assert.equal(await exists(fileOf(1)), true, "still a's historical version");
  await assertNoMissingFiles("history restored");

  // A successful upload of the same content inside the unlink window keeps the file.
  const raced = gatedMedia();
  await failInsertOf("boom.png", async () => {
    const uploading = upload(8, raced.media, "boom.png");
    await raced.window;
    await upload(8);
    raced.open();
    await assert.rejects(uploading, /p11 injected insert failure/);
  });
  assert.equal(await exists(fileOf(8)), true);
  await assertNoMissingFiles("raced upload");
  assert.deepEqual(
    (await audits("media.upload")).map((row) => row.detail.filename),
    ["p1.png", "p8.png"],
  );
});

test("P11 media upload whose commit fails leaves neither row, file nor audit", async () => {
  await failCommitOn("media.upload", async () => {
    await assert.rejects(upload(3), /p11 injected commit failure/);
  });
  assert.equal(await mediaCount(), 0);
  assert.deepEqual(await filesOnDisk(), []);
  assert.deepEqual(await audits("media.upload"), []);
  // Replace placing a new file follows the same rule.
  const item = await upload(4);
  await failCommitOn("media.replace", async () => {
    await assert.rejects(replace(item.id, 5), /p11 injected commit failure/);
  });
  assert.equal(await exists(fileOf(5)), false);
  assert.equal(await exists(fileOf(4)), true);
});

test("P11 media upload audits creations but not dedupe hits; delete is audited", async () => {
  const item = await upload(1);
  const dedupe = await upload(1);
  assert.equal(dedupe.id, item.id);
  // Over HTTP too.
  const response = await f.api("/media", {
    method: "POST",
    body: { site: "atlas", alt: "图片", ...image(2) },
  });
  assert.equal(response.status, 201);
  const second = await response.json();
  const uploads = await audits("media.upload");
  assert.deepEqual(
    uploads.map((row) => [row.actor_id, row.site_id, row.detail]),
    [
      [f.editor.id, "atlas", { mediaId: item.id, sha256: sha(1), bytes: SIZE, filename: "p1.png" }],
      [f.admin.id, "atlas", { mediaId: second.id, sha256: sha(2), bytes: SIZE, filename: "p2.png" }],
    ],
  );
  assert.equal((await f.api(`/media/${second.id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(
    (await audits("media.delete")).map((row) => [row.actor_id, row.site_id, row.detail]),
    [[f.admin.id, "atlas", { mediaId: second.id, versions: 1, filesRemoved: 1 }]],
  );
  // Rolled-back deletes write nothing.
  await failCommitOn("media.delete", async () => {
    await assert.rejects(f.app.media.remove(f.editor, item.id));
  });
  assert.equal((await audits("media.delete")).length, 1);
  assert.equal(await exists(fileOf(1)), true);
});
