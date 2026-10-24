// M16: an optional image on reader submissions, held outside the media library until review.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture, password } from "../p6/helpers.js";
import { contentHttp } from "../../src/server/content-http.js";

const ORIGIN = "https://atlas.p6.test";
const HOST = "atlas.p6.test";
// A 1×1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let f: Fixture;
let cookie = "";

function post(path: string, body: unknown) {
  return f.app.respond(
    new Request(ORIGIN + path, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}
const submission = (extra: Record<string, unknown> = {}) => ({
  locale: "zh",
  url: "https://example.com/tool",
  title: "投稿工具",
  description: "推荐理由",
  ...extra,
});
async function latest() {
  const rows = await f.app.content.submissions(f.admin, "atlas");
  return rows[0];
}

before(async () => {
  f = await setup();
  assert.equal(await f.app.auth.provision("atlas"), true);
  const response = await f.app.respond(
    new Request(ORIGIN + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: "p16-reader@example.com", name: "P16 reader", password }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
});
after(async () => {
  await f?.close();
});

test("P16 a submission image is validated by content and kept out of submission data", async () => {
  const fake = Buffer.from("<svg onload=alert(1)>").toString("base64");
  assert.equal((await post("/api/me/submissions", submission({ image: { mime: "image/png", data: fake } }))).status, 415);
  const jpegClaim = await post("/api/me/submissions", submission({ image: { mime: "image/jpeg", data: PNG } }));
  assert.equal(jpegClaim.status, 415);
  const big = Buffer.alloc(1024 * 1024 + 1);
  Buffer.from(PNG, "base64").copy(big);
  assert.equal(
    (await post("/api/me/submissions", submission({ image: { mime: "image/png", data: big.toString("base64") } }))).status,
    413,
  );
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM submission")).rows[0].n, 0);

  const created = await post("/api/me/submissions", submission({ image: { mime: "image/png", data: PNG } }));
  assert.equal(created.status, 201, await created.clone().text());
  const row = await latest();
  assert.equal(row.has_image, true);
  assert.equal("image" in row.data, false);
  const mine = await f.app.respond(
    new Request(ORIGIN + "/api/me/submissions", { headers: { host: HOST, cookie } }),
  );
  assert.equal((await mine.json())[0].has_image, true);
});

test("P16 operators preview the held image with locked-down headers", async () => {
  const row = await latest();
  const response = await contentHttp(
    f.app.content,
    f.admin,
    `/content/atlas/submissions/${row.id}/image`,
    new Request("https://admin.p6.test/x"),
    async () => ({}),
  );
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("base64"), PNG);
  await assert.rejects(
    f.app.content.submissionImage(f.admin, "atlas", "00000000-0000-4000-8000-000000000000"),
    /投稿没有图片/,
  );
});

test("P16 accepting imports the image into the media library as the draft logo", async () => {
  const row = await latest();
  const result = await f.app.content.review(
    f.admin,
    "atlas",
    row.id,
    { decision: "accepted", expectedVersion: row.version },
    f.app.media,
  );
  assert.equal(result.resourceId, "submission-" + row.id);
  assert.equal("imageError" in result, false);
  const draft = (
    await f.pool.query("SELECT candidate FROM content_draft WHERE site_id='atlas' AND resource_id=$1", [result.resourceId])
  ).rows[0].candidate;
  const media = (await f.pool.query("SELECT * FROM media WHERE id=$1", [draft.overrides.logo.mediaId])).rows[0];
  assert.equal(media.site_id, "atlas");
  assert.equal(media.mime, "image/png");
  assert.equal(media.alt, "投稿工具");
  assert.equal(draft.overrides.logo.alt, "投稿工具");
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM submission_image")).rows[0].n, 0);
});

test("P16 rejecting deletes the held image; an import failure still accepts without a logo", async () => {
  assert.equal((await post("/api/me/submissions", submission({ title: "拒绝", image: { mime: "image/png", data: PNG } }))).status, 201);
  let row = await latest();
  await f.app.content.review(f.admin, "atlas", row.id, { decision: "rejected", expectedVersion: row.version }, f.app.media);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM submission_image")).rows[0].n, 0);

  assert.equal((await post("/api/me/submissions", submission({ title: "超额", image: { mime: "image/png", data: PNG } }))).status, 201);
  row = await latest();
  const failing = {
    upload: async () => {
      const { HttpError } = await import("../../src/server/operators.js");
      throw new HttpError(413, "媒体存储空间不足");
    },
  } as unknown as typeof f.app.media;
  const result = await f.app.content.review(
    f.admin,
    "atlas",
    row.id,
    { decision: "accepted", expectedVersion: row.version },
    failing,
  );
  assert.equal(result.imageError, "媒体存储空间不足");
  const draft = (
    await f.pool.query("SELECT candidate FROM content_draft WHERE site_id='atlas' AND resource_id=$1", [result.resourceId])
  ).rows[0].candidate;
  assert.equal(draft.overrides?.logo ?? null, null);
  // Kept for a later manual import.
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM submission_image")).rows[0].n, 1);
});
