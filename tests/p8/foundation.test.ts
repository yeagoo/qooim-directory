import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setup, type Fixture } from "../p6/helpers.js";

const basePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function png(seed: number) {
  const data = Buffer.alloc(200, 0);
  basePng.copy(data);
  data.writeUInt32BE(seed, 196);
  return data;
}
const bodySha = async (response: Response) =>
  createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
let f: Fixture, locale: string;
before(async () => {
  f = await setup();
  locale = (
    await f.pool.query("SELECT config->'locales'->>0 AS l FROM site WHERE id='atlas'")
  ).rows[0].l;
});
after(async () => {
  await f?.close();
});
const upload = (seed: number) =>
  f.app.media.upload(f.admin, {
    site: "atlas",
    filename: `p${seed}.png`,
    mime: "image/png",
    alt: "封面",
    data: png(seed).toString("base64"),
  });
const fetchPublic = (path: string, site = "atlas") =>
  f.app.respond(
    new Request(`https://${site}.p6.test${path}`, {
      headers: { host: `${site}.p6.test` },
    }),
  );
// Simulates a replacement: point media at a second stored file as version 2.
async function replaceWith(mediaId: string, otherId: string) {
  await f.pool.query(
    `INSERT INTO media_version(media_id,version,filename,mime,bytes,width,height,sha256)
     SELECT $1,2,filename,mime,bytes,width,height,sha256 FROM media WHERE id=$2`,
    [mediaId, otherId],
  );
  await f.pool.query(
    `UPDATE media m SET version=2,filename=o.filename,mime=o.mime,bytes=o.bytes,width=o.width,height=o.height,sha256=o.sha256
     FROM media o WHERE m.id=$1 AND o.id=$2`,
    [mediaId, otherId],
  );
}
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
test("P8 uploads record version 1 history and a versioned URL", async () => {
  const item = await upload(1);
  assert.equal(item.version, 1);
  assert.equal(item.url, `/media/${item.id}/1`);
  const history = (
    await f.pool.query("SELECT version,sha256 FROM media_version WHERE media_id=$1", [item.id])
  ).rows;
  assert.deepEqual(history, [{ version: 1, sha256: item.sha256 }]);
});
test("P8 publishing freezes the image version until republished", async () => {
  const a = await upload(10),
    b = await upload(11);
  await f.app.content.saveResource(f.admin, {
    id: "frozen",
    expectedVersion: 0,
    data: {
      url: "https://example.com/frozen",
      source: "manual",
      translations: { [locale]: { title: "Frozen", description: "Frozen item" } },
    },
    public: true,
  });
  await publishWith("frozen", a.id);
  const listing = (
    await f.pool.query(
      "SELECT image,image_media_id,image_version FROM public_listing WHERE resource_id='frozen'",
    )
  ).rows[0];
  assert.equal(listing.image.url, `/media/${a.id}/1`);
  assert.equal(listing.image_media_id, a.id);
  assert.equal(listing.image_version, 1);
  const v1 = await fetchPublic(`/media/${a.id}/1`);
  assert.equal(v1.status, 200);
  assert.match(v1.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(await bodySha(v1), a.sha256);
  // Unpublished versions and other sites stay hidden.
  assert.equal((await fetchPublic(`/media/${a.id}/2`)).status, 404);
  assert.equal((await fetchPublic(`/media/${a.id}/1`, "notes")).status, 404);
  assert.equal((await fetchPublic(`/media/${b.id}/1`)).status, 404);
  // Legacy unversioned URLs redirect, uncached, to the published version.
  const legacy = await fetchPublic(`/media/${a.id}`);
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get("location"), `/media/${a.id}/1`);
  assert.equal(legacy.headers.get("cache-control"), "no-store");

  await replaceWith(a.id, b.id);
  // Replacement alone never changes what is live.
  const still = await fetchPublic(`/media/${a.id}/1`);
  assert.equal(still.status, 200);
  assert.equal(await bodySha(still), a.sha256);
  assert.equal((await fetchPublic(`/media/${a.id}/2`)).status, 404);
  assert.equal(await f.app.content.mediaVersionPinned("atlas", a.id, 1), true);
  assert.equal(await f.app.content.mediaVersionPinned("atlas", a.id, 2), false);

  await publishWith("frozen", a.id);
  const v2 = await fetchPublic(`/media/${a.id}/2`);
  assert.equal(v2.status, 200);
  assert.equal(await bodySha(v2), b.sha256);
  assert.equal((await fetchPublic(`/media/${a.id}/1`)).status, 404);
  assert.equal(
    (await fetchPublic(`/media/${a.id}`)).headers.get("location"),
    `/media/${a.id}/2`,
  );
  assert.deepEqual(await f.app.content.publishedMediaVersions("atlas", a.id), [2]);
  assert.equal(await f.app.content.mediaVersionPinned("atlas", a.id, 1), false);
  assert.equal(await f.app.content.mediaVersionPinned("atlas", a.id, 2), true);
  const snapshot = (
    await f.pool.query(
      "SELECT image FROM publication WHERE site_id='atlas' AND resource_id='frozen'",
    )
  ).rows[0].image;
  assert.deepEqual(snapshot, { mediaId: a.id, alt: "资源封面", version: 2 });
});
test("P8 view treats pre-M8 publication images as version 1", async () => {
  const item = await upload(20);
  await f.app.content.saveResource(f.admin, {
    id: "legacy-image",
    expectedVersion: 0,
    data: {
      url: "https://example.com/legacy",
      source: "manual",
      translations: { [locale]: { title: "Legacy", description: "Legacy item" } },
    },
    public: true,
  });
  await publishWith("legacy-image", item.id);
  await f.pool.query(
    "UPDATE publication SET image=image-'version' WHERE resource_id='legacy-image'",
  );
  const listing = (
    await f.pool.query(
      "SELECT image,image_version FROM public_listing WHERE resource_id='legacy-image'",
    )
  ).rows[0];
  assert.equal(listing.image.url, `/media/${item.id}/1`);
  assert.equal(listing.image_version, 1);
  assert.equal((await fetchPublic(`/media/${item.id}/1`)).status, 200);
});
