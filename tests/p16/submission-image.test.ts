// M16: an optional image on reader submissions, held outside the media library until review.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture, password } from "../p6/helpers.js";
import { runMaintenance } from "../../src/server/maintenance.js";

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
  // Exercise the real admin route so respond()'s global CSP cannot overwrite the image policy.
  const response = await f.api(`/content/atlas/submissions/${row.id}/image`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
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
  let uploads = 0;
  const counting = {
    upload: async (...args: Parameters<typeof f.app.media.upload>) => {
      uploads++;
      return f.app.media.upload(...args);
    },
  } as unknown as typeof f.app.media;
  await f.app.content.review(f.admin, "atlas", row.id, { decision: "rejected", expectedVersion: row.version }, counting);
  assert.equal(uploads, 0);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM submission_image")).rows[0].n, 0);
  // A reviewer that loses the race must not upload either.
  await assert.rejects(
    f.app.content.review(f.admin, "atlas", row.id, { decision: "accepted", expectedVersion: row.version }, counting),
    /already reviewed/,
  );
  assert.equal(uploads, 0);

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

test("P16 an image import does not overwrite a draft changed while it uploads", async () => {
  assert.equal((await post("/api/me/submissions", submission({ title: "并发", image: { mime: "image/png", data: PNG } }))).status, 201);
  const row = await latest();
  const resource = "submission-" + row.id;
  let uploads = 0;
  const racing = {
    upload: async () => {
      uploads++;
      await f.pool.query(
        "UPDATE content_draft SET candidate=jsonb_set(candidate,'{overrides,title}','\"人工改写\"'),version=version+1 WHERE site_id='atlas' AND resource_id=$1",
        [resource],
      );
      return { id: "00000000-0000-4000-8000-000000000001" };
    },
  } as unknown as typeof f.app.media;
  const result = await f.app.content.review(
    f.admin,
    "atlas",
    row.id,
    { decision: "accepted", expectedVersion: row.version },
    racing,
  );
  assert.equal(uploads, 1);
  const draft = (
    await f.pool.query("SELECT version,candidate FROM content_draft WHERE site_id='atlas' AND resource_id=$1", [result.resourceId])
  ).rows[0];
  assert.equal(draft.version, 2);
  assert.equal(draft.candidate.overrides.title, "人工改写");
  assert.equal(draft.candidate.overrides.logo ?? null, null);
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM submission_image WHERE submission_id=$1", [row.id])).rows[0].n,
    0,
  );
});

test("P16 the site's pending submission images share a bounded byte budget", async () => {
  const identity = (
    await f.pool.query("SELECT site_id,space_id,user_id FROM submission WHERE site_id='atlas' ORDER BY created_at LIMIT 1")
  ).rows[0];
  await f.pool.query(
    `WITH created AS (
       INSERT INTO submission(site_id,space_id,user_id,data,created_at)
       SELECT $1,$2,$3,'{}'::jsonb,clock_timestamp()-interval '2 hours'
       FROM generate_series(1,$4::int)
       RETURNING id
     )
     INSERT INTO submission_image(submission_id,mime,bytes,width,height,sha256,data)
     SELECT id,'image/png',1048576,1,1,repeat('a',64),'\\x00'::bytea FROM created`,
    [identity.site_id, identity.space_id, identity.user_id, 100],
  );
  const before = (await f.pool.query("SELECT count(*)::int AS n FROM submission")).rows[0].n;
  const response = await post("/api/me/submissions", submission({ title: "超过容量", image: { mime: "image/png", data: PNG } }));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /待审核投稿图片/);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM submission")).rows[0].n, before);
});

test("P16 maintenance prunes old held images only for reviewed submissions", async () => {
  const identity = (
    await f.pool.query("SELECT site_id,space_id,user_id FROM submission WHERE site_id='atlas' ORDER BY created_at LIMIT 1")
  ).rows[0];
  const make = async (status: string, days: number) => {
    const id = (
      await f.pool.query(
        `INSERT INTO submission(site_id,space_id,user_id,data,status,created_at)
         VALUES($1,$2,$3,$4,$5,clock_timestamp()-$6::int*interval '1 day') RETURNING id`,
        [identity.site_id, identity.space_id, identity.user_id, submission(), status, days],
      )
    ).rows[0].id as string;
    await f.pool.query(
      `INSERT INTO submission_image(submission_id,mime,bytes,width,height,sha256,data)
       VALUES($1,'image/png',1,1,1,repeat('b',64),'\\x00'::bytea)`,
      [id],
    );
    return id;
  };
  const oldAccepted = await make("accepted", 31);
  const oldRejected = await make("rejected", 31);
  const oldPending = await make("pending", 31);
  const recentAccepted = await make("accepted", 29);
  const result = await runMaintenance(f.pool, { force: true });
  assert.deepEqual(result?.submissionImages, { deleted: 2 });
  const remaining = (
    await f.pool.query(
      "SELECT submission_id FROM submission_image WHERE submission_id=ANY($1::uuid[]) ORDER BY submission_id",
      [[oldAccepted, oldRejected, oldPending, recentAccepted]],
    )
  ).rows.map((row) => row.submission_id);
  assert.deepEqual(new Set(remaining), new Set([oldPending, recentAccepted]));
});
