// M15 submission metadata autofill: bounded HTML parsing, endpoint auth/errors and the DB quota.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { parseMetadata, type PageMetadata } from "../../src/server/metadata.js";
import { UnsafePublicTarget } from "../../src/server/outbound.js";
import { setup, type Fixture, password } from "../p6/helpers.js";

const ORIGIN = "https://atlas.p6.test";
const HOST = "atlas.p6.test";
let f: Fixture;

before(async () => {
  f = await setup();
  assert.equal(await f.app.auth.provision("atlas"), true);
});
after(async () => {
  await f?.close();
});

function post(path: string, body: unknown, cookie = "", origin = ORIGIN) {
  return f.app.respond(
    new Request(ORIGIN + path, {
      method: "POST",
      headers: {
        host: HOST,
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function signup(email: string) {
  const response = await f.app.respond(
    new Request(ORIGIN + "/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, name: "P15 reader", password }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

const fixed = (metadata: PageMetadata) => async () => ({
  notModified: false,
  text: `<html><head><title>${metadata.title}</title><meta name="description" content="${metadata.description}"></head></html>`,
  etag: null,
});

test("P15 metadata parser decodes entities and prefers Open Graph fields", () => {
  const body = `<html><head>
    <title>  Fallback &amp; title  </title>
    <meta name="description" content="fallback &lt;description&gt;">
    <meta property="og:title" content="Open &#39;Graph&#39; &#x4F60;&#22909;">
    <meta property="og:description" content="OG &quot;description&quot; &amp; more">
    <meta property="og:site_name" content="Ignored site name">
  </head><body><title>Body title</title></body></html>`;
  assert.deepEqual(parseMetadata(body), {
    title: "Open 'Graph' 你好",
    description: 'OG "description" & more',
  });
});

test("P15 metadata parser ignores scripts, styles, comments and content outside <head>", () => {
  const body = `<head>
    <!-- <title>Commented</title> -->
    <script>const fake = '<title>Script title</title><meta name="description" content="script description">';</script>
    <style>.fake::after { content: "<meta property='og:title' content='Style title'>"; }</style>
    <title>Real &amp; safe</title>
    <meta name="description" content="Real description">
  </head><body><meta property="og:title" content="Body OG"><meta name="description" content="Body description"></body>`;
  assert.deepEqual(parseMetadata(body), {
    title: "Real & safe",
    description: "Real description",
  });
  const scriptEndTag = `<head><script>const end = "</head>"; const fake = '<title>Script title</title>';</script><title>After script</title><meta property="og:description" content="Visible"></head>`;
  assert.deepEqual(parseMetadata(scriptEndTag), {
    title: "After script",
    description: "Visible",
  });
  for (const unterminated of [
    "<head><script><title>Hidden</title>",
    "<head><style><meta name=\"description\" content=\"Hidden\">",
    "<head><!-- <title>Hidden</title>",
  ])
    assert.deepEqual(parseMetadata(unterminated), { title: "", description: "" });
});

test("P15 metadata parser returns empty fields for missing tags and truncates by code point", () => {
  assert.deepEqual(parseMetadata("<html><body>No head</body></html>"), {
    title: "",
    description: "",
  });
  const parsed = parseMetadata(
    `<head><title>${"😀".repeat(201)}</title><meta name="description" content="${"界".repeat(5001)}"></head>`,
  );
  assert.equal(Array.from(parsed.title).length, 200);
  assert.equal(Array.from(parsed.description).length, 5000);
});

test("P15 metadata endpoint requires a session, same origin and a public URL", async () => {
  const anonymous = await post("/api/me/submissions/metadata", { url: "https://example.com/" });
  assert.equal(anonymous.status, 401);

  const cookie = await signup("metadata-origin@example.test");
  const wrongOrigin = await post(
    "/api/me/submissions/metadata",
    { url: "https://example.com/" },
    cookie,
    "https://evil.p6.test",
  );
  assert.equal(wrongOrigin.status, 403);

  for (const url of [
    "not a URL",
    "http://example.com/",
    "https://127.0.0.1/private",
    "https://user:pass@example.com/",
  ]) {
    const response = await post("/api/me/submissions/metadata", { url }, cookie);
    assert.equal(response.status, 400, url);
    assert.doesNotMatch((await response.json()).error, /127\.0\.0\.1|example\.com/);
  }
});

test("P15 metadata endpoint uses the injectable bounded fetcher and maps failures to 502", async () => {
  const cookie = await signup("metadata-fetch@example.test");
  const seen: { value?: { url: string; options: Record<string, unknown> } } = {};
  f.app.metadata.fetcher = async (url, options = {}) => {
    seen.value = { url, options };
    return {
      notModified: false,
      text: `<head><title>Example &amp; Co</title><meta property="og:description" content="A site description"></head>`,
      etag: null,
    };
  };
  const response = await post(
    "/api/me/submissions/metadata",
    { url: "https://example.com/start" },
    cookie,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    title: "Example & Co",
    description: "A site description",
  });
  assert.equal(seen.value?.url, "https://example.com/start");
  assert.equal(seen.value?.options.maxBytes, 1024 * 1024);
  assert.equal(seen.value?.options.timeoutMs, 8000);
  assert.equal(seen.value?.options.redirects, 0);
  assert.deepEqual(seen.value?.options.headers, { accept: "text/html" });

  f.app.metadata.fetcher = async () => {
    throw new Error("SECRET fetched content must not leak");
  };
  const failed = await post(
    "/api/me/submissions/metadata",
    { url: "https://example.com/fail" },
    cookie,
  );
  assert.equal(failed.status, 502);
  const error = (await failed.json()).error as string;
  assert.match(error, /无法获取/);
  assert.doesNotMatch(error, /SECRET/);

  f.app.metadata.fetcher = async () => {
    throw new UnsafePublicTarget("SECRET private address");
  };
  const unsafe = await post(
    "/api/me/submissions/metadata",
    { url: "https://example.com/private" },
    cookie,
  );
  assert.equal(unsafe.status, 400);
  assert.doesNotMatch((await unsafe.json()).error, /SECRET/);
});

test("P15 metadata endpoint rate-limits each user to 20 successful reservations per hour", async () => {
  const email = "metadata-limit@example.test";
  const cookie = await signup(email);
  f.app.metadata.fetcher = fixed({ title: "Rate limited", description: "Still public" });
  for (let i = 0; i < 20; i++) {
    const response = await post(
      "/api/me/submissions/metadata",
      { url: `https://example.com/${i}` },
      cookie,
    );
    assert.equal(response.status, 200, `request ${i + 1}`);
  }
  const limited = await post(
    "/api/me/submissions/metadata",
    { url: "https://example.com/21" },
    cookie,
  );
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /20/);
  const userId = (
    await f.pool.query(
      "SELECT id FROM identity_user WHERE email=$1 AND space_id='atlas'",
      [email],
    )
  ).rows[0].id;
  const count = (
    await f.pool.query(
      "SELECT count(*)::int AS n FROM metadata_fetch WHERE site_id='atlas' AND user_id=$1",
      [userId],
    )
  ).rows[0].n;
  assert.equal(count, 20);
});

test("P15 admin metadata endpoint reuses the service without the visitor quota", async () => {
  f.app.metadata.fetcher = fixed({ title: "Admin lookup", description: "Operator only" });
  const before = (
    await f.pool.query("SELECT count(*)::int AS n FROM metadata_fetch")
  ).rows[0].n;
  for (let i = 0; i < 21; i++) {
    const response = await f.api("/content/atlas/metadata", {
      method: "POST",
      body: { url: `https://example.com/admin-${i}` },
    });
    assert.equal(response.status, 200, `admin request ${i + 1}`);
  }
  const count = (
    await f.pool.query("SELECT count(*)::int AS n FROM metadata_fetch")
  ).rows[0].n;
  assert.equal(count, before);
});
