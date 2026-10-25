// M20 stable-release hardening: review fixes from docs/CODE-REVIEW-20261025.md.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setup, type Fixture } from "../p6/helpers.js";
import { parseRss } from "../../src/server/collector-adapters.js";
import { gate, personaSchema } from "../../src/server/distribution.js";
import { ReadLimiter } from "../../src/server/read-limit.js";
import { keyId, registerPreviousKeys, seal, sealedWith, unseal } from "../../src/server/crypto.js";
import { reseal } from "../../src/server/reseal.js";
import { runMaintenance } from "../../src/server/maintenance.js";
import { randomBytes, createCipheriv } from "node:crypto";

let f: Fixture;
before(async () => {
  f = await setup();
});
after(async () => {
  await f?.close();
});
const get = (url: string, headers: Record<string, string> = {}) =>
  f.app.respond(new Request(url, { headers: { host: new URL(url).host, ...headers } }));

test("P20 L8 out-of-range character references do not fail a feed", () => {
  const items = parseRss(
    `<rss><channel><item><title>Bad &#xFFFFFF; &#55296; ok &#x41;</title><link>https://example.com/a</link><guid>a</guid></item></channel></rss>`,
    "https://example.com/feed",
    "en",
  );
  assert.equal(items.length, 1);
  const title = JSON.stringify(items[0].data);
  assert.match(title, /&#xFFFFFF;/);
  assert.match(title, /ok A/);
});

test("P20 M6 bare tech names are not new links; explicit links still are", () => {
  const persona = personaSchema.parse({});
  const base = { title: "Vite", description: "Vite 构建工具", content: "## 概述\n基于 Node.js 与 Vue.js，读取 vite.config.json。" };
  assert.ok(!gate(base, { name: "Vite" }, persona).includes("new_url"));
  for (const content of ["访问 www.evil.example", "见 https://evil.example/x", "镜像在 evil.com"])
    assert.ok(gate({ ...base, content }, { name: "Vite" }, persona).includes("new_url"), content);
});

test("P20 L1/L7 security headers, favicon and the admin theme-init script", async () => {
  const page = await get("https://atlas.p6.test/");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /object-src 'none'/);
  assert.match(page.headers.get("permissions-policy") ?? "", /camera=\(\)/);
  assert.equal(page.headers.get("strict-transport-security"), "max-age=31536000");
  const plain = await f.app.respond(
    new Request("http://atlas.p6.test/", { headers: { host: "atlas.p6.test" } }),
  );
  assert.equal(plain.headers.get("strict-transport-security"), null);
  for (const path of ["/favicon.ico", "/favicon.svg"]) {
    const icon = await get("https://atlas.p6.test" + path);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/svg+xml");
  }
  const login = await (await get("https://admin.p6.test/admin/login")).text();
  assert.match(login, /<script src="\/assets\/admin-theme-init.js"><\/script>/);
  assert.match(login, /<noscript>/);
  const init = await get("https://admin.p6.test/assets/admin-theme-init.js");
  assert.equal(init.status, 200);
  assert.match(await init.text(), /admin-theme/);
  // Admin-only asset is not served on a site host.
  assert.equal((await get("https://atlas.p6.test/assets/admin-theme-init.js")).status, 404);
});

test("P20 H4 migration 021 adds the resource and media-reference indexes", async () => {
  const names = (
    await f.pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('publication','content_draft')",
    )
  ).rows.map((r) => r.indexname);
  for (const name of [
    "publication_resource",
    "content_draft_resource",
    "publication_image_media",
    "publication_logo_media",
  ])
    assert.ok(names.includes(name), name);
});

test("P20 H1 read limiter: per bucket, site and client; 429 in Chinese", () => {
  let now = 0;
  const limiter = new ReadLimiter({ search: 2, list: 1, sitemap: 1, badge: 1 }, () => now);
  limiter.consume("search", "atlas", "1.2.3.4");
  limiter.consume("search", "atlas", "1.2.3.4");
  assert.throws(() => limiter.consume("search", "atlas", "1.2.3.4"), (e: Error & { status?: number }) =>
    e.status === 429 && /请求过于频繁/.test(e.message),
  );
  limiter.consume("search", "notes", "1.2.3.4");
  limiter.consume("search", "atlas", "5.6.7.8");
  limiter.consume("list", "atlas", "1.2.3.4");
  now += 60_001;
  limiter.consume("search", "atlas", "1.2.3.4");
});

test("P20 H1 public search answers 429 once the client's window is spent", async () => {
  let last = 0;
  for (let i = 0; i < 125; i++)
    last = (await get("https://atlas.p6.test/api/search?q=x")).status;
  assert.equal(last, 429);
  // Another site keeps its own window.
  assert.notEqual((await get("https://notes.p6.test/api/search?q=x")).status, 429);
});

test("P20 B3 health reports database, migrations, worker heartbeat and media", async () => {
  const response = await get("https://admin.p6.test/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.db, true);
  assert.equal(body.migrations.applied, body.migrations.expected);
  assert.equal(body.mediaWritable, true);
  assert.equal(body.workerHeartbeat.ok, false);
  assert.equal(body.status, "degraded");
  await f.pool.query(
    "INSERT INTO maintenance_status VALUES('worker',now(),'{}') ON CONFLICT(name) DO UPDATE SET completed_at=now()",
  );
  assert.equal((await (await get("https://admin.p6.test/health")).json()).status, "ok");
});

test("P20 H5 versioned sealing reads legacy and previous-key values; re-seal is resumable", async () => {
  const oldKey = randomBytes(32).toString("hex"),
    newKey = randomBytes(32).toString("hex");
  const sealed = seal({ a: 1 }, newKey);
  assert.match(sealed, new RegExp(`^v1\\.${keyId(newKey)}\\.`));
  assert.ok(sealedWith(sealed, newKey));
  assert.deepEqual(unseal(sealed, newKey), { a: 1 });
  // Legacy three-part value (before key ids).
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(oldKey, "hex"), nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify({ key: "sk-old" })), cipher.final()]);
  const legacy = [nonce, cipher.getAuthTag(), data].map((v) => v.toString("base64url")).join(".");
  assert.throws(() => unseal(legacy, newKey));
  assert.throws(() => unseal(seal({ b: 2 }, oldKey), newKey), /unknown key/);
  registerPreviousKeys([oldKey]);
  assert.deepEqual(unseal(legacy, newKey), { key: "sk-old" });
  await f.pool.query(
    `INSERT INTO ai_config(site_id,endpoint,model,sealed_key,enabled,monthly_tokens)
     VALUES('notes','https://api.example.com/v1','m',$1,false,20000)`,
    [legacy],
  );
  const first = await reseal(f.pool, newKey);
  assert.deepEqual(first.ai_config, { resealed: 1, failed: 0 });
  const stored = (await f.pool.query("SELECT sealed_key FROM ai_config WHERE site_id='notes'")).rows[0].sealed_key;
  assert.ok(sealedWith(stored, newKey));
  assert.deepEqual(unseal(stored, newKey), { key: "sk-old" });
  assert.deepEqual((await reseal(f.pool, newKey)).ai_config, { resealed: 0, failed: 0 });
});

test("P20 H2 retention prunes old idempotency keys and delivered events, keeps audit by default", async () => {
  await f.pool.query(
    "INSERT INTO content_operation(id,fingerprint,version,created_at) VALUES(gen_random_uuid(),'x',1,now()-interval '100 days')",
  );
  await f.pool.query(
    "INSERT INTO outbox(site_id,revision,status,created_at) VALUES('atlas',1,'done',now()-interval '40 days'),('atlas',1,'pending',now()-interval '40 days')",
  );
  await f.pool.query(
    "INSERT INTO audit_event(actor_id,site_id,action,created_at) VALUES($1,'atlas','old.event',now()-interval '1000 days')",
    [f.admin.id],
  );
  const result = await runMaintenance(f.pool, { force: true });
  assert.ok(result!.history.contentOperations >= 1);
  assert.ok(result!.history.outbox >= 1);
  assert.equal(result!.history.audit, undefined);
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM outbox WHERE status='pending' AND created_at<now()-interval '30 days'")).rows[0].n,
    1,
  );
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action='old.event'")).rows[0].n,
    1,
  );
});

test("P20 M1 OIDC issuers must be public HTTPS hosts unless private networks are allowed", async () => {
  await assert.rejects(
    f.app.auth.providers.set(f.admin, "atlas", {
      id: "oidc-lab",
      kind: "oidc",
      label: "Lab",
      clientId: "client",
      clientSecret: "secret",
      issuer: "https://localhost/realm",
    }),
    (e: Error & { status?: number }) => e.status === 400 && /公开网络/.test(e.message),
  );
});

test("P20 H3 visitors: list, ban revokes sessions, anonymize scrubs the email; audited", async () => {
  const space = (await f.pool.query("SELECT space_id FROM identity_site WHERE site_id='atlas'")).rows[0].space_id;
  const user = (
    await f.pool.query("INSERT INTO identity_user(space_id,email) VALUES($1,'reader@example.test') RETURNING id", [space])
  ).rows[0].id;
  await f.pool.query("INSERT INTO identity_member(site_id,space_id,user_id) VALUES('atlas',$1,$2)", [space, user]);
  await f.pool.query(
    "INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at,absolute_expires_at) VALUES('atlas',$1,$2,'c',now()+interval '1 day',now()+interval '1 day')",
    [space, user],
  );
  const list = await (await f.api("/visitors?site=atlas&q=READER")).json();
  assert.deepEqual(list.visitors.map((v: { email: string }) => v.email), ["reader@example.test"]);
  // A viewer cannot ban; the editor can.
  assert.equal(
    (await f.app.visitors.ban(f.viewer, "atlas", user, true).catch((e) => e.status)) as number,
    403,
  );
  await f.app.visitors.ban(f.editor, "atlas", user, true);
  const banned = (
    await f.pool.query(
      "SELECT u.banned,bool_and(s.revoked) AS revoked FROM identity_user u JOIN identity_session s ON s.user_id=u.id WHERE u.id=$1 GROUP BY u.banned",
      [user],
    )
  ).rows[0];
  assert.deepEqual(banned, { banned: true, revoked: true });
  const anonymized = await f.api(`/visitors/atlas/${user}/anonymize`, { method: "POST", body: {} });
  assert.equal(anonymized.status, 200);
  const row = (await f.pool.query("SELECT email,banned FROM identity_user WHERE id=$1", [user])).rows[0];
  assert.equal(row.email, `anonymized-${user}@anonymized.invalid`);
  const actions = (
    await f.pool.query("SELECT action FROM audit_event WHERE detail->>'userId'=$1 ORDER BY id", [user])
  ).rows.map((r) => r.action);
  assert.deepEqual(actions, ["visitor.ban", "visitor.anonymize"]);
  // Other sites' operators cannot see this site's visitors.
  assert.equal((await f.app.visitors.list(f.editor, { site: "notes" }).catch((e) => e.status)) as number, 403);
});
