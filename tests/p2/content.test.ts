import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { chromium, type Page } from "@playwright/test";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";
import { Application } from "../../src/server/http.js";
import { AuthRegistry, prefix } from "../../src/server/auth.js";
import { runJobs } from "../../src/server/jobs.js";
import { AiWorker } from "../../src/server/ai.js";
import { configSchema } from "../../src/domain/config.js";
import { HttpError, type Operator } from "../../src/server/operators.js";
import { personalPage, directoryPage } from "../../src/ui/directory.js";
let pool: Pool,
  app: Application,
  server: ReturnType<typeof createServer>,
  admin: Operator,
  origins: string[],
  key: string;
const password = "P2-test-password-429!";
before(async () => {
  pool = await database();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const dir = await mkdtemp(join(tmpdir(), "network-upgrade-"));
  try {
    await cp("migrations/001-foundation.sql", join(dir, "001-foundation.sql"));
    await cp("migrations/002-platform.sql", join(dir, "002-platform.sql"));
    await migrate(pool, dir);
    await pool.query(
      "INSERT INTO site(id,host,config) VALUES('legacy','legacy.test',$1)",
      [
        {
          name: "Legacy",
          template: "basic",
          locales: ["zh"],
          navigation: [],
          catalogPath: "tools",
          tagline: "",
        },
      ],
    );
    await pool.query(
      "INSERT INTO resource(id,internal_note) VALUES('legacy-item','private legacy'); INSERT INTO publication(site_id,resource_id,locale,slug,title,status) VALUES('legacy','legacy-item','zh','old','Old content','published')",
    );
    await migrate(pool);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  key = randomBytes(32).toString("hex");
  server = createServer(
    {
      key: await readFile(process.env.P0_TLS_KEY!),
      cert: await readFile(process.env.P0_TLS_CERT!),
    },
    async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = new Request("https://" + req.headers.host + req.url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(!["GET", "HEAD"].includes(req.method!)
            ? { body: Buffer.concat(chunks) }
            : {}),
        });
        const response = await app.respond(request);
        res.statusCode = response.status;
        for (const [name, value] of response.headers)
          if (name !== "set-cookie") res.setHeader(name, value);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) res.setHeader("set-cookie", cookies);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.statusCode = 500;
        res.end("Test transport failed");
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  origins = process.env
    .P0_HOSTS!.split(",")
    .map((host) => `https://${host}:${port}`);
  app = new Application(pool, {
    key,
    adminOrigin: origins[3],
    databaseUrl: process.env.P0_DATABASE_URL!,
    development: false,
  });
  const id = await app.sites.operators.create(
    "owner@example.test",
    password,
    true,
  );
  admin = { id, email: "owner@example.test", global_admin: true };
  for (const [index, id] of ["atlas", "notes", "library"].entries())
    await app.sites.create(admin, {
      id,
      name: ["灵感地图", "开发札记", "资源书房"][index],
      origin: origins[index],
      centerSite: index === 1 ? "atlas" : null,
      legacyShared: index === 1,
    });
  for (const id of ["atlas", "notes", "library"])
    assert.equal(await app.auth.provision(id), true);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await app?.close();
  await pool?.end();
});

const master = (title = "Shared title") => ({
  url: "https://example.com/tool",
  source: "manual",
  translations: {
    zh: { title, description: "中文公开说明" },
    en: { title: "English title", description: "English description" },
  },
});
async function resource(id: string, title?: string) {
  await app.content.saveResource(admin, {
    id,
    expectedVersion: 0,
    data: master(title),
    public: true,
    internalNote: "PRIVATE-SENTINEL",
  });
}
async function stage(
  site: string,
  id: string,
  locale = "zh",
  candidate: Record<string, unknown> = {},
) {
  await app.content.stage(admin, site, id, locale, {
    candidate: { resourceVersion: 1, slug: id, ...candidate },
    expected: { published: 0, draft: 0 },
  });
}
async function publish(site: string, id: string, locale = "zh") {
  return app.content.publish(admin, site, id, locale, {
    expected: { published: 0, draft: 1 },
    operationId: randomUUID(),
  });
}
const request = (index: number, path: string) =>
  new Request(origins[index] + path, {
    headers: { host: new URL(origins[index]).host },
  });

test("P2 upgrade preserves legacy publications, notes and original migration checksums", async () => {
  assert.equal(
    (await pool.query("SELECT count(*) FROM schema_migration")).rows[0].count,
    "11",
  );
  const context = await app.catalog.resolve("legacy.test");
  assert.equal((await app.catalog.list(context, "zh"))[0].title, "Old content");
  assert.equal(
    (
      await pool.query(
        "SELECT internal_note FROM resource WHERE id='legacy-item'",
      )
    ).rows[0].internal_note,
    "private legacy",
  );
  await migrate(pool);
  await pool.query("UPDATE publication SET title='' WHERE site_id='legacy'");
  assert.equal(
    (await app.content.diagnose(admin, "legacy", "legacy-item", "zh")).visible,
    false,
  );
  await pool.query(
    "UPDATE publication SET title='Old content' WHERE site_id='legacy'",
  );
});

test("P2 master revision is frozen per site; manual overrides persist when choosing a newer revision", async () => {
  await resource("shared");
  await stage("atlas", "shared", "zh", {
    overrides: { title: "Atlas override" },
  });
  await publish("atlas", "shared");
  await stage("notes", "shared");
  await publish("notes", "shared");
  await app.content.saveResource(admin, {
    id: "shared",
    expectedVersion: 1,
    data: master("Master changed"),
    public: true,
    internalNote: "PRIVATE-SENTINEL",
  });
  const atlas = await app.catalog.resolve(new URL(origins[0]).host),
    notes = await app.catalog.resolve(new URL(origins[1]).host);
  assert.equal(
    (await app.catalog.detail(atlas, "zh", "shared")).title,
    "Atlas override",
  );
  assert.equal(
    (await app.catalog.detail(notes, "zh", "shared")).title,
    "Shared title",
  );
  assert.equal(
    (await app.content.diagnose(admin, "atlas", "shared", "zh")).sourceUpdate,
    true,
  );
  const difference = await app.content.updateDiff(
    admin,
    "notes",
    "shared",
    "zh",
  );
  assert.equal(difference.candidate.resourceVersion, 2);
  assert.equal(difference.differences[0].after, "Master changed");
  assert.equal(
    (await app.content.updateDiff(admin, "atlas", "shared", "zh")).candidate
      .overrides.title,
    "Atlas override",
  );

  await app.content.stage(admin, "atlas", "shared", "zh", {
    candidate: {
      resourceVersion: 2,
      slug: "shared",
      overrides: { title: "Atlas override" },
    },
    expected: { published: 1, draft: 2 },
  });
  await app.content.publish(admin, "atlas", "shared", "zh", {
    expected: { published: 1, draft: 3 },
    operationId: randomUUID(),
  });
  assert.equal(
    (await app.catalog.detail(atlas, "zh", "shared")).title,
    "Atlas override",
  );
  assert.equal(
    (await app.content.publicationHistory(admin, "atlas", "shared", "zh"))
      .length,
    2,
  );
  await assert.rejects(
    app.content.saveResource(admin, {
      id: "shared",
      expectedVersion: 1,
      data: master(),
      public: true,
    }),
  );
});

test("P2 drafts preserve public content, concurrent writes conflict and publication is idempotent", async () => {
  await resource("concurrent");
  const input = {
    candidate: { resourceVersion: 1, slug: "concurrent" },
    expected: { published: 0, draft: 0 },
  };
  const saves = await Promise.allSettled([
    app.content.stage(admin, "atlas", "concurrent", "zh", input),
    app.content.stage(admin, "atlas", "concurrent", "zh", input),
  ]);
  assert.equal(saves.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await app.respond(request(0, "/api/items/zh/concurrent"))).status,
    404,
  );
  const op = {
    expected: { published: 0, draft: 1 },
    operationId: randomUUID(),
  };
  assert.equal(
    await app.content.publish(admin, "atlas", "concurrent", "zh", op),
    1,
  );
  assert.equal(
    await app.content.publish(admin, "atlas", "concurrent", "zh", op),
    1,
  );
  await app.content.stage(admin, "atlas", "concurrent", "zh", {
    candidate: {
      resourceVersion: 1,
      slug: "concurrent",
      overrides: { title: "Draft only" },
    },
    expected: { published: 1, draft: 2 },
  });
  assert.equal(
    (await (await app.respond(request(0, "/api/items/zh/concurrent"))).json())
      .title,
    "Shared title",
  );
  assert.equal(
    (await app.content.preview(admin, "atlas", "concurrent", "zh")).title,
    "Draft only",
  );
  await assert.rejects(app.content.publish(admin, "notes", "shared", "zh", op));
});

test("P2 list/search/detail/category/count/sitemap share the same visibility and no private fields", async () => {
  await resource("categorized", "Find this needle");
  await app.content.saveCategory(admin, "atlas", {
    id: "design",
    labels: { zh: "设计" },
    expectedVersion: 0,
  });
  await stage("atlas", "categorized", "zh", { categoryId: "design" });
  await publish("atlas", "categorized");
  let response = await (
    await app.respond(request(0, "/api/search?q=needle&category=design"))
  ).json();
  assert.equal(response.total, 1);
  assert.equal(response.items[0].slug, "categorized");
  assert.equal(JSON.stringify(response).includes("PRIVATE-SENTINEL"), false);
  assert.equal(
    (await (await app.respond(request(1, "/api/search?q=needle"))).json())
      .total,
    0,
  );
  assert.equal(
    (
      await (
        await app.respond(request(0, "/api/search?q=needle&page=99"))
      ).json()
    ).total,
    1,
  );
  assert.equal(
    (await app.respond(request(0, "/api/search?page=-1"))).status,
    400,
  );
  assert.equal(
    (await (await app.respond(request(0, "/api/categories"))).json())[0].count,
    1,
  );
  assert.match(
    await (await app.respond(request(0, "/sitemap.xml"))).text(),
    /categorized/,
  );
  await app.content.saveCategory(admin, "atlas", {
    id: "design",
    labels: { zh: "设计" },
    active: false,
    expectedVersion: 1,
  });
  assert.equal(
    (await (await app.respond(request(0, "/api/search?q=needle"))).json())
      .total,
    0,
  );
  assert.equal(
    (await app.respond(request(0, "/api/items/zh/categorized"))).status,
    404,
  );
  assert.deepEqual(
    await (await app.respond(request(0, "/api/categories"))).json(),
    [],
  );
  assert.doesNotMatch(
    await (await app.respond(request(0, "/sitemap.xml"))).text(),
    /categorized/,
  );
  assert.deepEqual(
    (await app.content.diagnose(admin, "atlas", "categorized", "zh")).reasons,
    ["category_unavailable"],
  );
  await assert.rejects(
    stage("notes", "categorized", "zh", { categoryId: "design" }),
  );
});

test("P2 trigram search ranks title matches and keeps the trigram index installed", async () => {
  await app.content.saveResource(admin, {
    id: "rank-title",
    expectedVersion: 0,
    data: {
      ...master("Alpha Tools"),
      translations: {
        zh: { title: "Alpha Tools", description: "标题直接命中" },
        en: { title: "Alpha Tools", description: "title match" },
      },
    },
    public: true,
    internalNote: "rank fixture",
  });
  await app.content.saveResource(admin, {
    id: "rank-description",
    expectedVersion: 0,
    data: {
      ...master("Other Tool"),
      translations: {
        zh: { title: "Other Tool", description: "说明里提到 alpha" },
        en: { title: "Other Tool", description: "description mentions alpha" },
      },
    },
    public: true,
    internalNote: "rank fixture",
  });
  for (const id of ["rank-title", "rank-description"]) {
    await stage("atlas", id);
    await publish("atlas", id);
  }
  const result = await app.catalog.browse(
    await app.catalog.resolve(new URL(origins[0]).host),
    { locale: "zh", q: "ALPHA" },
  );
  assert.equal(result.total, 2);
  assert.equal(result.items[0].slug, "rank-title");
  assert.ok(result.items.some((item) => item.slug === "rank-description"));
  assert.equal(
    (
      await pool.query(
        "SELECT extname FROM pg_extension WHERE extname='pg_trgm'",
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM pg_indexes WHERE tablename='publication' AND indexname='publication_search_trgm'",
      )
    ).rowCount,
    1,
  );
});

test("P2 media upload, publication reference, public serving and delete guards", async () => {
  const token = await app.sites.operators.login(admin.email, password);
  const adminHeaders = {
    host: new URL(origins[3]).host,
    origin: origins[3],
    cookie: "network_operator=" + token,
    "content-type": "application/json",
  };
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const upload = async (alt: string, data = png, mime = "image/png") => {
    const response = await app.respond(
      new Request(origins[3] + "/admin/api/media", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          site: "atlas",
          filename: "pixel.png",
          mime,
          alt,
          data,
        }),
      }),
    );
    return response;
  };
  const first = await upload("封面");
  assert.equal(first.status, 201);
  const item = await first.json();
  assert.equal(item.mime, "image/png");
  assert.equal(item.width, 1);
  assert.equal(item.height, 1);
  assert.match(item.url, /^\/media\/[0-9a-f-]{36}$/);
  assert.equal(
    (
      await app.respond(
        new Request(origins[3] + item.adminUrl, {
          headers: {
            host: new URL(origins[3]).host,
            cookie: "network_operator=" + token,
          },
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await app.respond(request(0, item.url))).status,
    404,
  );
  await resource("media-resource", "Media resource");
  await stage("atlas", "media-resource", "zh", {
    overrides: { image: { mediaId: item.id, alt: "资源封面" } },
  });
  await publish("atlas", "media-resource");
  const page = await (
    await app.respond(request(0, "/zh/tools/media-resource"))
  ).text();
  assert.match(page, new RegExp(item.url));
  assert.match(page, /资源封面/);
  const publicImage = await app.respond(request(0, item.url));
  assert.equal(publicImage.status, 200);
  assert.equal(publicImage.headers.get("content-type"), "image/png");
  assert.match(publicImage.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(
    (await app.respond(request(1, item.url))).status,
    404,
  );
  assert.equal(
    (
      await app.respond(
        new Request(origins[3] + "/admin/api/media/" + item.id, {
          method: "DELETE",
          headers: {
            host: new URL(origins[3]).host,
            origin: origins[3],
            cookie: "network_operator=" + token,
          },
        }),
      )
    ).status,
    409,
  );

  const png2 = Buffer.concat([
    Buffer.from(png, "base64"),
    Buffer.from([0]),
  ]).toString("base64");
  const second = await (await upload("未引用", png2)).json();
  const removed = await app.respond(
    new Request(origins[3] + "/admin/api/media/" + second.id, {
      method: "DELETE",
      headers: {
        host: new URL(origins[3]).host,
        origin: origins[3],
        cookie: "network_operator=" + token,
      },
    }),
  );
  assert.equal(removed.status, 200);

  const wrongType = await upload("错类型", png, "image/jpeg");
  assert.equal(wrongType.status, 415);
  const svg = await upload(
    "SVG",
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString(
      "base64",
    ),
    "image/png",
  );
  assert.equal(svg.status, 415);
});

test("P2 AI config seals the key and worker output stays a manual suggestion", async () => {
  await assert.rejects(
    app.ai.saveConfig(admin, {
      site: "atlas",
      endpoint: "https://localhost/v1/chat/completions",
      model: "test-model",
      key: "test-key-123456",
      enabled: true,
      monthlyTokens: 1000,
    }),
  );
  const config = await app.ai.saveConfig(admin, {
    site: "atlas",
    endpoint: "https://provider.example.test/v1/chat/completions",
    model: "test-model",
    key: "test-key-123456",
    enabled: true,
    monthlyTokens: 1000,
  });
  assert.equal(config.hasKey, true);
  assert.equal(JSON.stringify(config).includes("test-key-123456"), false);
  const sealed = (
    await pool.query("SELECT sealed_key FROM ai_config WHERE site_id='atlas'")
  ).rows[0].sealed_key as string;
  assert.equal(sealed.includes("test-key-123456"), false);

  const job = await app.ai.create(admin, {
    site: "atlas",
    kind: "generate",
    locale: "zh",
    title: "原题",
    description: "原说明",
    brief: "更简洁",
  });
  const worker = new AiWorker(pool, key, async (input) => {
    assert.equal(input.model, "test-model");
    assert.match(input.messages[1].content, /原说明/);
    return {
      output: { title: "AI 标题", description: "AI 说明" },
      tokensIn: 12,
      tokensOut: 7,
      model: "test-model",
    };
  });
  assert.equal(await worker.runOnce(), true);
  const done = await app.ai.job(admin, "atlas", job.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.output, { title: "AI 标题", description: "AI 说明" });
  assert.equal(done.tokens.input, 12);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM publication WHERE resource_id='ai-resource'",
      )
    ).rows[0].count,
    0,
  );

  await pool.query("UPDATE ai_job SET tokens_in=1000 WHERE id=$1", [job.id]);
  await assert.rejects(
    app.ai.create(admin, {
      site: "atlas",
      kind: "generate",
      locale: "zh",
      title: "预算",
    }),
    /预算/,
  );
  await app.ai.saveConfig(admin, {
    site: "atlas",
    endpoint: "https://provider.example.test/v1/chat/completions",
    model: "test-model",
    enabled: false,
    monthlyTokens: 1000,
  });
  await assert.rejects(
    app.ai.create(admin, {
      site: "atlas",
      kind: "generate",
      locale: "zh",
      title: "原题",
    }),
    /未启用/,
  );
});

test("P2 missing translations are rejected; canonical, hreflang, sitemap use trusted origin", async () => {
  await resource("multilingual", "中文资源");
  await stage("atlas", "multilingual");
  await publish("atlas", "multilingual");
  await stage("atlas", "multilingual", "en");
  await publish("atlas", "multilingual", "en");
  const config = await app.sites.export(admin, "atlas");
  config.config.locales = ["zh", "en"];
  let state = await app.sites.config(admin).read("atlas");
  const draft = await app.sites.save(admin, "atlas", config, {
    revision: state.revision,
    draftVersion: state.draft_version,
  });
  await app.sites.publish(admin, "atlas", {
    revision: state.revision,
    draftVersion: draft,
  });
  app.catalog.invalidate("atlas");
  const html = await (
    await app.respond(request(0, "/en/tools/multilingual"))
  ).text();
  assert.match(html, /English title/);
  assert.match(html, /hreflang="zh"/);
  assert.ok(html.includes(origins[0] + "/en/tools/multilingual"));
  await resource("zh-only");
  await app.content.saveResource(admin, {
    id: "zh-only",
    expectedVersion: 1,
    data: {
      url: "https://example.com",
      translations: { zh: { title: "仅中文", description: "中文说明" } },
    },
  });
  await assert.rejects(
    stage("atlas", "zh-only", "en", { resourceVersion: 2 }),
    /语言/,
  );
  assert.equal(
    (await app.respond(request(0, "/en/tools/zh-only"))).status,
    404,
  );
  await assert.rejects(
    app.content.saveResource(admin, {
      id: "unsafe",
      expectedVersion: 0,
      data: { ...master(), url: "javascript:alert(1)" },
    }),
  );
});

test("P2 JSON dry-run does not write; imports are atomic and private notes remain local", async () => {
  const bundle = await app.content.exportResources(admin);
  assert.equal(JSON.stringify(bundle).includes("PRIVATE-SENTINEL"), false);
  const valid = {
    id: "import-valid",
    expectedVersion: 0,
    data: master(),
    public: true,
  };
  const conflict = {
    id: "shared",
    expectedVersion: 0,
    data: master(),
    public: true,
  };
  assert.equal(
    (
      await app.content.importResources(
        admin,
        { schemaVersion: 1, kind: "resources", resources: [valid] },
        false,
      )
    ).applied,
    false,
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM resource WHERE id='import-valid'"))
      .rowCount,
    0,
  );
  await assert.rejects(
    app.content.importResources(
      admin,
      { schemaVersion: 1, kind: "resources", resources: [valid, conflict] },
      true,
    ),
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM resource WHERE id='import-valid'"))
      .rowCount,
    0,
  );
  const shared = bundle.resources.find(
    (r: { id: string }) => r.id === "shared",
  );
  await app.content.importResources(
    admin,
    { schemaVersion: 1, kind: "resources", resources: [shared] },
    true,
  );
  assert.equal(
    (await pool.query("SELECT internal_note FROM resource WHERE id='shared'"))
      .rows[0].internal_note,
    "PRIVATE-SENTINEL",
  );
});

test("P2 editor cannot read global masters, distribute unknown resources or mutate another site", async () => {
  const id = await app.sites.operators.create(
    "editor-p2@example.test",
    password,
  );
  const editor = { id, email: "editor-p2@example.test", global_admin: false };
  await app.sites.operators.grant(admin, id, "atlas", "editor");
  await assert.rejects(app.content.resources(editor));
  await assert.rejects(app.content.categories(editor, "notes"));
  await resource("restricted");
  await assert.rejects(
    app.content.stage(editor, "atlas", "restricted", "zh", {
      candidate: { resourceVersion: 1, slug: "restricted" },
      expected: { published: 0, draft: 0 },
    }),
  );
  const published = (await app.content.publications(editor, "atlas")).find(
    (p) => p.id === "shared" && p.locale === "zh",
  );
  assert.ok(published);
  await app.sites.operators.grant(admin, id, "atlas", "viewer");
  await assert.rejects(
    app.content.unpublish(editor, "atlas", "shared", "zh", 2),
  );
});

test("P2 actual user favorites and submissions are site scoped; review creates a draft, never auto-publishes", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto(origins[0] + "/login");
    await page.locator("#email").fill("reader-p2@example.test");
    await page.locator("#password").fill(password);
    await page.locator("#register").click();
    await page.waitForURL(origins[0] + "/");
    let result = await context.request.post(origins[0] + "/api/me/favorites", {
      data: { resourceId: "shared", enabled: true },
      headers: { origin: origins[0] },
    });
    assert.equal(result.status(), 200);
    assert.equal(
      (
        await (
          await context.request.get(origins[0] + "/api/me/favorites")
        ).json()
      ).total,
      1,
    );
    await page.goto(origins[0] + "/me");
    await page.locator("#favorites a").first().waitFor();
    await page.locator("#title").fill("Browser suggestion");
    await page.locator("#url").fill("https://example.com/browser-suggestion");
    await page
      .locator("#description")
      .fill("A resource submitted through the actual form");
    await page.locator("#submission button").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "投稿已提交，等待本站审核。",
    );
    await page.goto(origins[1] + "/login");
    await page.locator("button").click();
    await page.waitForURL(origins[1] + "/");
    assert.equal(
      (
        await (
          await context.request.get(origins[1] + "/api/me/favorites")
        ).json()
      ).total,
      0,
    );
    result = await context.request.post(origins[0] + "/api/me/submissions", {
      data: {
        locale: "zh",
        url: "https://example.com/submitted",
        title: "A submitted resource",
        description: "A useful submitted resource",
      },
      headers: { origin: origins[0] },
    });
    assert.equal(result.status(), 201);
    const submission = await result.json();
    assert.deepEqual(
      await (
        await context.request.get(origins[1] + "/api/me/submissions")
      ).json(),
      [],
    );
    await assert.rejects(
      app.content.review(admin, "notes", submission.id, {
        expectedVersion: 1,
        decision: "accepted",
      }),
    );
    const accepted = await app.content.review(admin, "atlas", submission.id, {
      expectedVersion: 1,
      decision: "accepted",
    });
    assert.ok(accepted.resourceId);
    assert.equal(
      (await app.respond(request(0, "/api/items/zh/" + accepted.resourceId)))
        .status,
      404,
    );
    await assert.rejects(
      app.content.review(admin, "atlas", submission.id, {
        expectedVersion: 1,
        decision: "accepted",
      }),
    );
    await publish("atlas", accepted.resourceId!);
    assert.equal(
      (await app.respond(request(0, "/api/items/zh/" + accepted.resourceId)))
        .status,
      200,
    );
    assert.equal(
      (
        await context.request.post(origins[0] + "/api/me/favorites", {
          data: { resourceId: "shared", enabled: false },
          headers: { origin: origins[1] },
        })
      ).status(),
      403,
    );
    await app.content.unpublish(admin, "atlas", "shared", "zh", 2);
    assert.equal(
      (
        await (
          await context.request.get(origins[0] + "/api/me/favorites")
        ).json()
      ).total,
      0,
    );
    await context.request.post(origins[0] + "/api/auth/sign-out", {
      data: {},
      headers: { origin: origins[0] },
    });
    assert.equal(
      (await context.request.get(origins[1] + "/api/me/favorites")).status(),
      401,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P2 browser operator edits a master, stages and publishes a site resource, and public readers can search and favorite", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#resources");
    await page.locator("#resource-id").fill("browser-resource");
    await page
      .locator("#resource-data")
      .fill(JSON.stringify(master("Browser selected resource")));
    await page.locator("#save-resource").click();
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.startsWith("主档新版本"),
    );
    await page.goto(origins[3] + "/admin#content/atlas");
    await page.locator("#publication-resource").fill("browser-resource");
    await page.locator("#publication-candidate").fill(
      JSON.stringify({
        resourceVersion: 1,
        slug: "browser-resource",
        overrides: { description: "Browser reviewed description" },
      }),
    );
    await page.locator("#stage-content").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "内容草稿已保存。",
    );
    await page.locator("#preview-content").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#content-result")
        ?.textContent?.includes("Browser reviewed description"),
    );
    await page.locator("#publish-content").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "本站内容已发布。",
    );
    if (process.env.P2_SCREENSHOT)
      await page.screenshot({
        path: process.env.P2_SCREENSHOT,
        fullPage: true,
      });
    await page.goto(origins[0] + "/zh/tools?q=Browser");
    await page
      .locator(".item-title")
      .filter({ hasText: "Browser selected resource" })
      .click();
    await page.waitForURL(origins[0] + "/zh/tools/browser-resource");
    assert.equal(
      await page.locator("link[rel=canonical]").getAttribute("href"),
      origins[0] + "/zh/tools/browser-resource",
    );
    assert.ok(await page.locator("a.button").getAttribute("href"));
    await page.locator("button.favorite").click();
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("请先登录"),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    if (process.env.P2_SCREENSHOT)
      await page.screenshot({
        path: process.env.P2_SCREENSHOT.replace(".png", "-public-mobile.png"),
        fullPage: true,
      });
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P2 public DTOs escape stored markup and disabled resource/module gates apply immediately", async () => {
  await resource("markup", "<img src=x onerror=alert(1)>");
  await stage("atlas", "markup");
  await publish("atlas", "markup");
  let html = await (await app.respond(request(0, "/zh/tools/markup"))).text();
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img src=x"));
  await app.content.saveResource(admin, {
    id: "markup",
    expectedVersion: 1,
    data: master(),
    public: false,
  });
  assert.equal(
    (await app.respond(request(0, "/api/items/zh/markup"))).status,
    404,
  );
  assert.doesNotMatch(
    await (await app.respond(request(0, "/sitemap.xml"))).text(),
    /\/markup/,
  );
  await pool.query("UPDATE site SET modules='{}' WHERE id='atlas'");
  assert.deepEqual(
    await (await app.respond(request(0, "/api/catalog"))).json(),
    [],
  );
  assert.equal(
    (await (await app.respond(request(0, "/api/search"))).json()).total,
    0,
  );
  assert.equal(
    (await app.respond(request(0, "/api/items/zh/browser-resource"))).status,
    404,
  );
  await pool.query(
    "UPDATE site SET modules=ARRAY['directory'] WHERE id='atlas'",
  );
});

test("P2 batch publication reports each site transaction and duplicate slug rolls back its own write", async () => {
  await resource("batch-ok");
  await resource("batch-conflict");
  await stage("notes", "batch-ok");
  await stage("notes", "batch-conflict", "zh", { slug: "shared" });
  const token = await app.sites.operators.login(admin.email, password);
  const response = await app.respond(
    new Request(origins[3] + "/admin/api/content/batch-publish", {
      method: "POST",
      headers: {
        host: new URL(origins[3]).host,
        origin: origins[3],
        cookie: "network_operator=" + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        items: [
          {
            siteId: "notes",
            resourceId: "batch-ok",
            locale: "zh",
            expected: { published: 0, draft: 1 },
            operationId: randomUUID(),
          },
          {
            siteId: "notes",
            resourceId: "batch-conflict",
            locale: "zh",
            expected: { published: 0, draft: 1 },
            operationId: randomUUID(),
          },
        ],
      }),
    }),
  );
  assert.equal(response.status, 200);
  const results = (await response.json()).results;
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(
    (await app.respond(request(1, "/api/items/zh/batch-ok"))).status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM publication WHERE site_id='notes' AND resource_id='batch-conflict'",
      )
    ).rowCount,
    0,
  );
  assert.ok(
    (
      await pool.query(
        "SELECT candidate FROM content_draft WHERE site_id='notes' AND resource_id='batch-conflict'",
      )
    ).rows[0].candidate,
  );
});

test("P2 admin bulk publishes selected drafts from the content desk", async () => {
  await resource("bulk-ui-a");
  await resource("bulk-ui-b");
  await stage("notes", "bulk-ui-a");
  await stage("notes", "bulk-ui-b");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/notes");
    const row = (id: string) =>
      page.locator(`#publication-list tr:has-text("${id}")`);
    await row("bulk-ui-a").locator(".bulk-publication").check();
    await row("bulk-ui-b").locator(".bulk-publication").check();
    await page.locator("#bulk-publish").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.startsWith("批量发布完成"),
    );
    assert.match(
      (await page.locator("#message").textContent()) ?? "",
      /2 成功，0 失败/,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P2 submission rejection is private and hourly limit persists across requests", async () => {
  const browser = await chromium.launch({ headless: true }),
    context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  try {
    await page.goto(origins[2] + "/login");
    await page.locator("#email").fill("submit-limit@example.test");
    await page.locator("#password").fill(password);
    await page.locator("#register").click();
    await page.waitForURL(origins[2] + "/");
    const body = {
      locale: "zh",
      url: "https://example.com/rate",
      title: "A suggestion",
      description: "A useful suggestion",
    };
    let first: { id: string } | undefined;
    for (let i = 0; i < 10; i++) {
      const result = await context.request.post(
        origins[2] + "/api/me/submissions",
        { data: body, headers: { origin: origins[2] } },
      );
      assert.equal(result.status(), 201);
      if (i === 0) first = await result.json();
    }
    assert.equal(
      (
        await context.request.post(origins[2] + "/api/me/submissions", {
          data: body,
          headers: { origin: origins[2] },
        })
      ).status(),
      429,
    );
    assert.ok(first);
    const firstId = first.id;
    await app.content.review(admin, "library", firstId, {
      expectedVersion: 1,
      decision: "rejected",
      note: "Needs more detail",
    });
    const own = await (
      await context.request.get(origins[2] + "/api/me/submissions")
    ).json();
    assert.equal(
      own.find((s: { id: string }) => s.id === firstId).note,
      "Needs more detail",
    );
    assert.equal(
      (
        await pool.query("SELECT resource_id FROM submission WHERE id=$1", [
          firstId,
        ])
      ).rows[0].resource_id,
      null,
    );
    assert.equal(
      (await app.respond(request(0, "/api/me/submissions"))).status,
      401,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P2 architecture check rejects direct content SQL in a new public route", async () => {
  const { checkDataBoundary } =
    await import("../../scripts/check-boundaries.mjs");
  const dir = await mkdtemp(join(tmpdir(), "network-data-boundary-"));
  try {
    await writeFile(
      join(dir, "public-route.ts"),
      "export const read = () => db.query('SELECT title FROM publication WHERE site_id=$1');",
    );
    assert.equal(checkDataBoundary(dir).length, 1);
    await writeFile(
      join(dir, "public-route.ts"),
      "export const read = ctx => catalog.browse(ctx, {locale:'zh'});",
    );
    assert.deepEqual(checkDataBoundary(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P2 a failure after snapshot writes rolls back publication, history, operation and draft consumption", async () => {
  await resource("transaction-failure");
  await stage("atlas", "transaction-failure");
  const operationId = randomUUID();
  await pool.query(
    "CREATE FUNCTION p2_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.publish' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER p2_reject_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION p2_reject_audit()",
  );
  try {
    await assert.rejects(
      app.content.publish(admin, "atlas", "transaction-failure", "zh", {
        expected: { published: 0, draft: 1 },
        operationId,
      }),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM publication WHERE resource_id='transaction-failure'",
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM publication_revision WHERE resource_id='transaction-failure'",
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query("SELECT 1 FROM content_operation WHERE id=$1", [
          operationId,
        ])
      ).rowCount,
      0,
    );
    assert.ok(
      (
        await pool.query(
          "SELECT candidate FROM content_draft WHERE resource_id='transaction-failure'",
        )
      ).rows[0].candidate,
    );
  } finally {
    await pool.query(
      "DROP TRIGGER p2_reject_audit ON audit_event; DROP FUNCTION p2_reject_audit()",
    );
  }
  assert.equal(
    await app.content.publish(admin, "atlas", "transaction-failure", "zh", {
      expected: { published: 0, draft: 1 },
      operationId,
    }),
    1,
  );
});

test("P2 CLI exports, checks, imports and idempotently publishes through the same authorized service", async () => {
  const { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const env = {
    ...process.env,
    DATABASE_URL: process.env.P0_DATABASE_URL!,
    ADMIN_ORIGIN: origins[3],
    AUTH_ENCRYPTION_KEY: key,
    OPERATOR_EMAIL: admin.email,
    OPERATOR_PASSWORD: password,
  };
  const run = (...args: string[]) =>
    exec(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env });
  const exported = JSON.parse((await run("resources-export", "1")).stdout);
  assert.equal(exported.kind, "resources");
  assert.ok(!JSON.stringify(exported).includes("PRIVATE-SENTINEL"));
  const dir = await mkdtemp(join(tmpdir(), "network-content-cli-"));
  try {
    const bundle = join(dir, "resources.json"),
      candidate = join(dir, "candidate.json");
    await writeFile(
      bundle,
      JSON.stringify({
        schemaVersion: 1,
        kind: "resources",
        resources: [
          {
            id: "cli-resource",
            expectedVersion: 0,
            public: true,
            data: master("CLI resource"),
          },
        ],
      }),
    );
    assert.equal(
      JSON.parse((await run("resources-check", bundle)).stdout).applied,
      false,
    );
    assert.equal(
      (await pool.query("SELECT 1 FROM resource WHERE id='cli-resource'"))
        .rowCount,
      0,
    );
    assert.equal(
      JSON.parse((await run("resources-import", bundle)).stdout).applied,
      true,
    );
    await writeFile(
      candidate,
      JSON.stringify({
        candidate: { resourceVersion: 1, slug: "cli-resource" },
        expected: { published: 0, draft: 0 },
      }),
    );
    assert.equal(
      (
        await run("content-stage", "atlas", "cli-resource", "zh", candidate)
      ).stdout.trim(),
      "1",
    );
    const op = randomUUID();
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await run(
            "content-publish",
            "atlas",
            "cli-resource",
            "zh",
            "0",
            "1",
            op,
          )
        ).stdout.trim(),
        "1",
      );
    assert.equal(
      (
        await (
          await app.respond(request(0, "/api/items/zh/cli-resource"))
        ).json()
      ).title,
      "CLI resource",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exchange review: oversized page round trips through bounded schema-1 parts over the actual HTTP boundary", async () => {
  const { splitResourceExchange } =
    await import("../../src/ui/content-admin.js");
  for (let i = 0; i < 24; i++)
    await app.content.saveResource(admin, {
      id: `exchange-review-${String(i).padStart(2, "0")}`,
      expectedVersion: 0,
      internalNote: "PRIVATE-EXCHANGE-NOTE",
      data: {
        ...master(),
        translations: {
          zh: { title: "大文件协作", description: "中".repeat(5000) },
          en: { title: "Large file", description: "x".repeat(5000) },
        },
      },
    });
  const bundle = await app.content.exportResources(admin, "exchange-review-");
  const token = await app.sites.operators.login(admin.email, password);
  const exchange = (value: unknown, apply: boolean) =>
    app.respond(
      new Request(origins[3] + "/admin/api/resources/exchange", {
        method: "POST",
        headers: {
          host: new URL(origins[3]).host,
          origin: origins[3],
          cookie: `network_operator=${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ bundle: value, apply }),
      }),
    );
  assert.ok(Buffer.byteLength(JSON.stringify(bundle, null, 2)) > 262144);
  assert.equal((await exchange(bundle, false)).status, 413); // Reproduces the original unsplit round-trip failure.
  const parts = splitResourceExchange(bundle);
  assert.ok(parts.length > 1);
  assert.deepEqual(
    parts.flatMap((p: any) => p.resources.map((r: any) => r.id)),
    bundle.resources.map((r: any) => r.id),
  );
  for (const part of parts) {
    assert.ok(part.resources.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify(part, null, 2)) <= 262144);
    for (const apply of [false, true]) {
      assert.ok(
        Buffer.byteLength(JSON.stringify({ bundle: part, apply })) <= 262144,
      );
      const response = await exchange(part, apply);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).applied, apply);
    }
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM resource WHERE id LIKE 'exchange-review-%' AND version=2 AND internal_note='PRIVATE-EXCHANGE-NOTE'",
      )
    ).rows[0].count,
    "24",
  );
  assert.equal(JSON.stringify(parts).includes("PRIVATE-EXCHANGE-NOTE"), false);
  assert.equal(
    splitResourceExchange({
      schemaVersion: 1,
      kind: "resources",
      resources: [],
    }).length,
    1,
  );
  assert.throws(
    () =>
      splitResourceExchange({
        ...bundle,
        resources: [
          { ...bundle.resources[0], data: { padding: "x".repeat(262144) } },
        ],
      }),
    /单条资源/,
  );
});

test("exchange review: browser downloads importable parts and ignores stale or cleared file selections", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  let releaseCheck = () => {};
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#resources");
    await page.locator("#resource-search").fill("exchange-review-");
    await page.locator("#search-resources").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-resource").length === 24,
    );
    await page.locator("#export-resources").click();
    await page.locator("#resource-exports button").first().waitFor();
    assert.ok((await page.locator("#resource-exports button").count()) > 1);
    const downloaded = page.waitForEvent("download");
    await page.locator("#resource-exports button").first().click();
    const download = await downloaded;
    const bytes = await readFile((await download.path())!);
    assert.ok(bytes.length <= 262144);
    const part = JSON.parse(bytes.toString());
    assert.ok(part.resources.length > 1);
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        if (this.name !== "slow.json") return original.call(this);
        const file = this;
        return new Promise<string>((resolve) => {
          (window as any).reviewReleaseFile = async () => {
            resolve(await original.call(file));
            (window as any).reviewFileFinished = true;
          };
        });
      };
    });
    const first = { ...part, resources: [part.resources[0]] };
    const second = { ...part, resources: [part.resources[1]] };
    await page.locator("#resource-file").setInputFiles({
      name: "slow.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(first)),
    });
    await page.waitForFunction(
      () => typeof (window as any).reviewReleaseFile === "function",
    );
    await page.locator("#resource-file").setInputFiles({
      name: "current.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(second)),
    });
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "文件已载入，请检查导入。",
    );
    await page.evaluate(() => (window as any).reviewReleaseFile());
    await page.waitForFunction(() => (window as any).reviewFileFinished);
    const sent = page.waitForRequest(
      (r) => r.url().includes("/resources/exchange") && r.method() === "POST",
    );
    await page.locator("#check-import").click();
    assert.equal(
      (await sent).postDataJSON().bundle.resources[0].id,
      second.resources[0].id,
    );
    await page.waitForFunction(() =>
      document
        .querySelector("#import-result")
        ?.textContent?.includes('"applied": false'),
    );
    await page.locator("#resource-file").setInputFiles([]);
    await page.locator("#apply-import").click();
    await page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "请先选择文件",
    );
    assert.equal(
      (
        await pool.query("SELECT version FROM resource WHERE id=$1", [
          second.resources[0].id,
        ])
      ).rows[0].version,
      2,
    );
    let checking!: () => void;
    const started = new Promise<void>((resolve) => {
      checking = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    await page.route("**/admin/api/resources/exchange", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      checking();
      await held;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "STALE-CHECK-ERROR" }),
      });
    });
    const upload = async (value: unknown) => {
      await page.locator("#resource-file").setInputFiles({
        name: "selected.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(value)),
      });
      await page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent ===
          "文件已载入，请检查导入。",
      );
    };
    await upload(first);
    await page.locator("#check-import").click();
    await started;
    await upload(second);
    releaseCheck();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#check-import") as HTMLButtonElement)
          ?.disabled,
    );
    assert.equal(
      await page.locator("#message").textContent(),
      "文件已载入，请检查导入。",
    );
    assert.equal(await page.locator("#import-result").textContent(), "");
    const boundary = await app.content.exportResources(
      admin,
      "exchange-review-",
    );
    boundary.resources = boundary.resources.slice(0, 13);
    const excess = Buffer.byteLength(JSON.stringify(boundary)) - (262144 - 3);
    assert.ok(excess > 0 && excess < 15000);
    const last = boundary.resources.at(-1)!;
    last.data.translations.zh.description =
      last.data.translations.zh.description.slice(Math.ceil(excess / 3));
    const boundaryFile = Buffer.from(JSON.stringify(boundary));
    assert.ok(boundaryFile.length <= 262144);
    assert.ok(
      Buffer.byteLength(JSON.stringify({ bundle: boundary, apply: false })) >
        262144,
    );
    await page.locator("#resource-file").setInputFiles({
      name: "boundary.json",
      mimeType: "application/json",
      buffer: boundaryFile,
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("导入请求超过 256 KiB"),
    );
    await page.locator("#apply-import").click();
    await page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "请先选择文件",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
  } finally {
    releaseCheck();
    await context.close();
    await browser.close();
  }
});

test("content selection review: delayed first-resource differences cannot replace the second-resource candidate", async () => {
  for (const id of ["selection-first", "selection-second"]) {
    await resource(id, id);
    await stage("atlas", id);
    await publish("atlas", id);
    await app.content.saveResource(admin, {
      id,
      expectedVersion: 1,
      data: master(id + " version two"),
      public: true,
    });
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let release = () => {};
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/atlas");
    await page.locator(".edit-publication").first().waitFor();
    const choose = (id: string) =>
      page
        .locator("tr")
        .filter({ has: page.locator("td", { hasText: id + " · zh" }) })
        .locator(".edit-publication")
        .click();
    await choose("selection-first");
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route(
      "**/admin/api/content/atlas/selection-first/zh/diff",
      async (route) => {
        const response = await route.fetch();
        enter();
        await held;
        await route.fulfill({ response });
      },
    );
    await page.locator("#diff-content").click();
    await entered;
    await choose("selection-second");
    const received = page.waitForResponse((r) =>
      r.url().endsWith("/selection-first/zh/diff"),
    );
    release();
    await (await received).finished();
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    assert.equal(
      await page.locator("#publication-resource").inputValue(),
      "selection-second",
    );
    assert.equal(
      JSON.parse(await page.locator("#publication-candidate").inputValue())
        .slug,
      "selection-second",
    );
    assert.equal(await page.locator("#content-result").textContent(), "");
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test("content selection review: stale reads and committed writes preserve the current editor", async () => {
  const initial = (await app.content.publications(admin, "atlas")).find(
    (p: any) => p.id === "selection-first" && p.locale === "zh",
  );
  assert.ok(initial);
  await app.content.stage(admin, "atlas", "selection-first", "zh", {
    candidate: {
      resourceVersion: 2,
      slug: "selection-first",
      overrides: { description: "Stored draft for preview" },
    },
    expected: { published: initial.version, draft: initial.draft_version },
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const releases: Array<() => void> = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
  async function hold(pattern: string, fail = false) {
    let release!: () => void, enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    releases.push(release);
    await page.route(pattern, async (route) => {
      const response = fail ? null : await route.fetch();
      enter();
      await held;
      if (fail)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "STALE-SELECTION-ERROR" }),
        });
      else await route.fulfill({ response: response! });
    });
    return {
      entered,
      async finish(suffix: string) {
        const response = page.waitForResponse((r) => r.url().endsWith(suffix));
        release();
        await (await response).finished();
        await settle();
        await page.unrouteAll({ behavior: "wait" });
      },
    };
  }
  const choosePublication = (id: string) =>
    page
      .locator("tr")
      .filter({ has: page.locator("td", { hasText: id + " · zh" }) })
      .locator(".edit-publication")
      .click();
  const chooseMaster = (id: string) =>
    page.locator(`.edit-resource[data-id="${id}"]`).click();
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/atlas");
    await choosePublication("selection-first");
    let pending = await hold("**/selection-first/zh/diff");
    await page.locator("#diff-content").click();
    await pending.entered;
    const manual = JSON.stringify({
      resourceVersion: 2,
      slug: "selection-first",
      overrides: { title: "Manual after read started" },
    });
    await page.locator("#publication-candidate").fill(manual);
    await pending.finish("/selection-first/zh/diff");
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      manual,
    );
    assert.equal(await page.locator("#content-result").textContent(), "");

    pending = await hold("**/selection-first/zh/preview");
    await page.locator("#preview-content").click();
    await pending.entered;
    await page.locator("#diagnose-content").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#content-result")
        ?.textContent?.includes('"visible"'),
    );
    const diagnostic = await page.locator("#content-result").textContent();
    await pending.finish("/selection-first/zh/preview");
    assert.equal(
      await page.locator("#content-result").textContent(),
      diagnostic,
    );

    pending = await hold("**/selection-first/zh/diagnose", true);
    await page.locator("#diagnose-content").click();
    await pending.entered;
    await choosePublication("selection-second");
    await page.evaluate(() => {
      document.querySelector("#message")!.textContent = "SECOND-EDITOR";
    });
    await pending.finish("/selection-first/zh/diagnose");
    assert.equal(await page.locator("#message").textContent(), "SECOND-EDITOR");

    await choosePublication("selection-first");
    const saved = {
      resourceVersion: 2,
      slug: "selection-first",
      overrides: { description: "Committed first-resource draft" },
    };
    await page.locator("#publication-candidate").fill(JSON.stringify(saved));
    pending = await hold("**/selection-first/zh/stage");
    await page.locator("#stage-content").click();
    await pending.entered;
    await choosePublication("selection-second");
    const second = JSON.stringify({
      resourceVersion: 1,
      slug: "selection-second",
      overrides: { description: "Unsaved second-resource draft" },
    });
    await page.locator("#publication-candidate").fill(second);
    await pending.finish("/selection-first/zh/stage");
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      second,
    );
    assert.equal(
      await page.locator("#publication-resource").inputValue(),
      "selection-second",
    );
    const draft = (
      await pool.query(
        "SELECT candidate FROM content_draft WHERE site_id='atlas' AND resource_id='selection-first' AND locale='zh'",
      )
    ).rows[0].candidate;
    assert.equal(draft.overrides.description, saved.overrides.description);

    await page.evaluate(() => {
      location.hash = "resources";
    });
    await page.locator("#resource-search").fill("selection-");
    await page.locator("#search-resources").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-resource").length === 2,
    );
    pending = await hold("**/admin/api/resources/selection-first");
    await chooseMaster("selection-first");
    await pending.entered;
    await chooseMaster("selection-second");
    await page.waitForFunction(() =>
      document
        .querySelector("#resource-history")
        ?.textContent?.includes("selection-second version two"),
    );
    await pending.finish("/resources/selection-first");
    assert.ok(
      (await page.locator("#resource-history").textContent())!.includes(
        "selection-second version two",
      ),
    );
    await page.locator("#new-resource").click();
    assert.equal(await page.locator("#resource-history").textContent(), "");

    await chooseMaster("selection-first");
    await page
      .locator("#resource-data")
      .fill(JSON.stringify(master("Saved selection master")));
    pending = await hold("**/admin/api/resources");
    await page.locator("#save-resource").click();
    await pending.entered;
    await chooseMaster("selection-second");
    await page.locator("#resource-note").fill("Preserve unsaved second note");
    await pending.finish("/admin/api/resources");
    assert.equal(
      await page.locator("#resource-id").inputValue(),
      "selection-second",
    );
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Preserve unsaved second note",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT version FROM resource WHERE id='selection-first'",
        )
      ).rows[0].version,
      3,
    );

    // Reload the current versions, then delay the refresh after a successful save.
    await page.reload();
    await page.locator("#resource-search").fill("selection-");
    await page.locator("#search-resources").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-resource").length === 2,
    );
    await chooseMaster("selection-first");
    await page
      .locator("#resource-data")
      .fill(JSON.stringify(master("Saved before delayed refresh")));
    pending = await hold("**/admin/api/resources?**");
    await page.locator("#save-resource").click();
    await pending.entered;
    await chooseMaster("selection-second");
    await page.locator("#resource-note").fill("Preserve during refresh query");
    const response = page.waitForResponse((r) =>
      r.url().includes("/admin/api/resources?"),
    );
    releases.at(-1)!();
    await (await response).finished();
    await settle();
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Preserve during refresh query",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT version FROM resource WHERE id='selection-first'",
        )
      ).rows[0].version,
      4,
    );
    await page.unrouteAll({ behavior: "wait" });
    await page.reload();
    await page.locator("#resource-search").fill("selection-");
    await page.locator("#search-resources").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-resource").length === 2,
    );
    await chooseMaster("selection-first");
    pending = await hold("**/admin/api/resources?**", true);
    await page.locator("#save-resource").click();
    await pending.entered;
    await chooseMaster("selection-second");
    await page.locator("#resource-note").fill("Preserve after refresh failure");
    await page.evaluate(() => {
      document.querySelector("#message")!.textContent = "CURRENT-EDIT";
    });
    const failedRefresh = page.waitForResponse((r) =>
      r.url().includes("/admin/api/resources?"),
    );
    releases.at(-1)!();
    await (await failedRefresh).finished();
    await settle();
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Preserve after refresh failure",
    );
    assert.equal(await page.locator("#message").textContent(), "CURRENT-EDIT");
    assert.deepEqual(errors, []);
  } finally {
    for (const release of releases) release();
    await context.close();
    await browser.close();
  }
});

test("moderation review: category saving preserves an already edited publication candidate", async () => {
  for (const id of ["moderation-a", "moderation-b"])
    await app.content.saveCategory(admin, "atlas", {
      id,
      expectedVersion: 0,
      labels: { zh: id },
      rank: 0,
      active: true,
    });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/atlas");
    await page
      .locator("tr")
      .filter({ has: page.locator("td", { hasText: "selection-second · zh" }) })
      .locator(".edit-publication")
      .click();
    const candidate = JSON.stringify({
      resourceVersion: 2,
      slug: "selection-second",
      overrides: { description: "Keep already unsaved candidate" },
    });
    await page.locator("#publication-candidate").fill(candidate);
    await page
      .locator(".edit-category")
      .filter({ hasText: "moderation-a" })
      .click();
    await page
      .locator("#category-labels")
      .fill(JSON.stringify({ zh: "Saved category label" }));
    await page.locator("#save-category").click();
    await page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "分类已保存。",
    );
    await page.waitForFunction(
      () =>
        !(document.querySelector("#save-category") as HTMLButtonElement)
          ?.disabled,
    );
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      candidate,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("moderation review: delayed category saves preserve other editors and advance only acknowledged versions", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let release = () => {};
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/atlas");
    await page.locator("#publication-resource").waitFor();
    await page
      .locator("tr")
      .filter({ has: page.locator("td", { hasText: "selection-second · zh" }) })
      .locator(".edit-publication")
      .click();
    const candidate = JSON.stringify({
      resourceVersion: 2,
      slug: "selection-second",
      overrides: { description: "Preserve across category writes" },
    });
    await page.locator("#publication-candidate").fill(candidate);
    await page.locator('.edit-category[data-id="moderation-a"]').click();
    await page
      .locator("#category-labels")
      .fill(JSON.stringify({ zh: "Delayed A category" }));
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/admin/api/content/atlas/categories", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      entered();
      await held;
      await route.fulfill({ response });
    });
    await page.locator("#save-category").click();
    await ready;
    await page.locator('.edit-category[data-id="moderation-b"]').click();
    const bLabels = JSON.stringify({ zh: "Keep B unsaved" });
    await page.locator("#category-labels").fill(bLabels);
    release();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#save-category") as HTMLButtonElement)
          ?.disabled,
    );
    assert.equal(
      await page.locator("#category-id").inputValue(),
      "moderation-b",
    );
    assert.equal(await page.locator("#category-labels").inputValue(), bLabels);
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      candidate,
    );
    await page.unrouteAll({ behavior: "wait" });
    await page.locator('.edit-category[data-id="moderation-a"]').click();
    const version = (await app.content.categories(admin, "atlas")).find(
      (c: any) => c.id === "moderation-a",
    ).version;
    await page
      .locator("#category-labels")
      .fill(JSON.stringify({ zh: "A next acknowledged version" }));
    const request = page.waitForRequest(
      (r) => r.url().endsWith("/atlas/categories") && r.method() === "POST",
    );
    await page.locator("#save-category").click();
    assert.equal((await request).postDataJSON().expectedVersion, version);
    await page.waitForFunction(
      () =>
        !(document.querySelector("#save-category") as HTMLButtonElement)
          ?.disabled,
    );
    assert.equal(
      (await app.content.categories(admin, "atlas")).find(
        (c: any) => c.id === "moderation-a",
      ).version,
      version + 1,
    );
    let editing!: () => void;
    const editingStarted = new Promise<void>((r) => {
      editing = r;
    });
    const editingHeld = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/admin/api/content/atlas/categories", async (route) => {
      const response = await route.fetch();
      editing();
      await editingHeld;
      await route.fulfill({ response });
    });
    await page.locator("#save-category").click();
    await editingStarted;
    const newerLabels = JSON.stringify({ zh: "Typed while A was saving" });
    await page.locator("#category-labels").fill(newerLabels);
    release();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#save-category") as HTMLButtonElement)
          ?.disabled,
    );
    assert.equal(
      await page.locator("#category-labels").inputValue(),
      newerLabels,
    );
    await page.unrouteAll({ behavior: "wait" });
    const acknowledged = (await app.content.categories(admin, "atlas")).find(
      (c: any) => c.id === "moderation-a",
    ).version;
    const nextRequest = page.waitForRequest(
      (r) => r.url().endsWith("/atlas/categories") && r.method() === "POST",
    );
    await page.locator("#save-category").click();
    assert.equal(
      (await nextRequest).postDataJSON().expectedVersion,
      acknowledged,
    );
    await page.waitForFunction(
      () =>
        !(document.querySelector("#save-category") as HTMLButtonElement)
          ?.disabled,
    );
    await page.locator('.edit-category[data-id="moderation-b"]').click();
    await page.locator("#category-labels").fill(bLabels);
    await page.locator("#stage-content").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "内容草稿已保存。",
    );
    assert.equal(await page.locator("#category-labels").inputValue(), bLabels);
    assert.equal(
      await page.locator("#category-id").inputValue(),
      "moderation-b",
    );
    // An external category update must still cause a conflict, retaining local text.
    const current = (await app.content.categories(admin, "atlas")).find(
      (c: any) => c.id === "moderation-b",
    );
    await app.content.saveCategory(admin, "atlas", {
      id: current.id,
      expectedVersion: current.version,
      labels: { zh: "External category update" },
      active: true,
      rank: 0,
    });
    await page.locator("#save-category").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("Category version changed"),
    );
    assert.equal(await page.locator("#category-labels").inputValue(), bLabels);
    assert.equal(await page.locator("#save-category").isEnabled(), true);
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test("moderation review: independent review updates retain notes and committed acceptance survives a list refresh failure", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let release = () => {};
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const signup = await context.request.post(
      origins[0] + "/api/auth/sign-up/email",
      {
        data: {
          email: "moderation-reader@example.test",
          name: "Moderation Reader",
          password,
        },
        headers: { origin: origins[0] },
      },
    );
    assert.equal(signup.status(), 200, await signup.text());
    const ids: string[] = [];
    for (let index = 1; index <= 3; index++) {
      const response = await context.request.post(
        origins[0] + "/api/me/submissions",
        {
          data: {
            locale: "zh",
            title: `Moderation input ${index}`,
            description: "A submitted resource",
            url: "https://example.com/moderation",
          },
          headers: { origin: origins[0] },
        },
      );
      assert.equal(response.status(), 201, await response.text());
      ids.push((await response.json()).id);
    }
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/atlas");
    const article = (n: number) =>
      page.locator("article.resource").filter({
        has: page.locator("strong", { hasText: `Moderation input ${n}` }),
      });
    const accept = (n: number) =>
      article(n).locator('.review[data-decision="accepted"]');
    const reject = (n: number) =>
      article(n).locator('.review[data-decision="rejected"]');
    await article(1).waitFor();
    await page
      .locator("tr")
      .filter({ has: page.locator("td", { hasText: "selection-second · zh" }) })
      .locator(".edit-publication")
      .click();
    const candidate = JSON.stringify({
      resourceVersion: 2,
      slug: "selection-second",
      overrides: { description: "Keep candidate during reviews" },
    });
    await page.locator("#publication-candidate").fill(candidate);
    await page.locator('.edit-category[data-id="moderation-b"]').click();
    const labels = JSON.stringify({ zh: "Keep category during reviews" });
    await page.locator("#category-labels").fill(labels);
    await article(2)
      .locator("input")
      .fill("Other review note before acceptance");
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    let requests = 0;
    await page.route(
      `**/admin/api/content/atlas/submissions/${ids[0]}`,
      async (route) => {
        requests++;
        const response = await route.fetch();
        enter();
        await held;
        await route.fulfill({ response });
      },
    );
    await accept(1).click();
    await entered;
    assert.equal(await reject(1).isDisabled(), true);
    assert.equal(await article(1).locator("input").isDisabled(), true);
    await reject(1).dispatchEvent("click");
    await article(2)
      .locator("input")
      .fill("Other review note during acceptance");
    const accepted = page.waitForResponse((r) =>
      r.url().endsWith("/submissions/" + ids[0]),
    );
    release();
    const firstResource = (await (await accepted).json()).resourceId;
    await page.waitForFunction(
      () => document.querySelectorAll("#publication-list td").length > 0,
    );
    await page
      .locator("#publication-list tr")
      .filter({ hasText: firstResource })
      .waitFor();
    assert.equal(requests, 1);
    assert.equal(await article(1).locator(".review").count(), 0);
    assert.ok(
      (await article(1).locator(".review-status").textContent())!.includes(
        "accepted",
      ),
    );
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      candidate,
    );
    assert.equal(await page.locator("#category-labels").inputValue(), labels);
    assert.equal(
      await article(2).locator("input").inputValue(),
      "Other review note during acceptance",
    );
    assert.equal(
      (await app.respond(request(0, "/api/items/zh/" + firstResource))).status,
      404,
    );
    await page.unrouteAll({ behavior: "wait" });
    // Saving a publication also retains the unrelated category and review input.
    let listEntered!: () => void;
    const listStarted = new Promise<void>((r) => {
      listEntered = r;
    });
    const listHeld = new Promise<void>((r) => {
      release = r;
    });
    let lists = 0;
    await page.route(
      "**/admin/api/content/atlas/publications?**",
      async (route) => {
        if (++lists > 1) return route.continue();
        const response = await route.fetch();
        listEntered();
        await listHeld;
        await route.fulfill({ response });
      },
    );
    await page.locator("#stage-content").click();
    await listStarted;
    await page.locator("#refresh-publications").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "发布记录已刷新，其他编辑内容已保留。",
    );
    const lateList = page.waitForResponse((r) =>
      r.url().includes("/atlas/publications?"),
    );
    release();
    await (await lateList).finished();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#stage-content") as HTMLButtonElement)
          ?.disabled,
    );
    await page.unrouteAll({ behavior: "wait" });
    await page.locator("#publish-content").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "本站内容已发布。",
    );
    assert.equal(
      await article(2).locator("input").inputValue(),
      "Other review note during acceptance",
    );
    assert.equal(await page.locator("#category-labels").inputValue(), labels);
    await article(3).locator("input").fill("Untouched third note");
    await reject(2).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("article.resource")].some(
        (el) =>
          el.querySelector("strong")?.textContent === "Moderation input 2" &&
          el.querySelector(".review-status")?.textContent?.includes("rejected"),
      ),
    );
    assert.equal(
      await article(3).locator("input").inputValue(),
      "Untouched third note",
    );
    await page.route(
      `**/admin/api/content/atlas/submissions/${ids[2]}`,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Controlled review failure" }),
        }),
    );
    await accept(3).click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "Controlled review failure",
    );
    assert.equal(await accept(3).isEnabled(), true);
    assert.equal(await reject(3).isEnabled(), true);
    assert.equal(
      await article(3).locator("input").inputValue(),
      "Untouched third note",
    );
    assert.equal(await article(3).locator("input").isEnabled(), true);
    await page.unrouteAll({ behavior: "wait" });
    await page.route("**/admin/api/content/atlas/publications?**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Controlled publication list failure" }),
      }),
    );
    const acceptedThird = page.waitForResponse((r) =>
      r.url().endsWith("/submissions/" + ids[2]),
    );
    await accept(3).click();
    const thirdResource = (await (await acceptedThird).json()).resourceId;
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("审核已保存，但发布记录刷新失败"),
    );
    assert.equal(await article(3).locator(".review").count(), 0);
    assert.equal(await page.locator("#category-labels").inputValue(), labels);
    await page.unrouteAll({ behavior: "wait" });
    await page.locator("#refresh-publications").click();
    await page
      .locator("#publication-list tr")
      .filter({ hasText: thirdResource })
      .waitFor();
    assert.equal(
      (await pool.query("SELECT status FROM submission WHERE id=$1", [ids[2]]))
        .rows[0].status,
      "accepted",
    );
    assert.equal(
      (
        await pool.query("SELECT count(*) FROM resource WHERE id=$1", [
          thirdResource,
        ])
      ).rows[0].count,
      "1",
    );
    assert.deepEqual(errors, []);
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test("moderation review: accepted drafts crossing the page boundary remain reachable", async () => {
  const existing = await app.content.publications(admin, "atlas");
  assert.ok(existing.length < 99);
  for (let n = existing.length; n < 99; n++) {
    const id = "moderation-fill-" + String(n).padStart(3, "0");
    await resource(id, id);
    await stage("atlas", id);
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    const signup = await context.request.post(
      origins[0] + "/api/auth/sign-up/email",
      {
        data: {
          email: "moderation-page@example.test",
          name: "Page Reader",
          password,
        },
        headers: { origin: origins[0] },
      },
    );
    assert.equal(signup.status(), 200, await signup.text());
    for (let n = 1; n <= 2; n++) {
      const response = await context.request.post(
        origins[0] + "/api/me/submissions",
        {
          data: {
            locale: "zh",
            title: `Boundary moderation ${n}`,
            description: "Page boundary fixture",
            url: "https://example.com/boundary",
          },
          headers: { origin: origins[0] },
        },
      );
      assert.equal(response.status(), 201, await response.text());
    }
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/atlas");
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-publication").length === 99,
    );
    assert.equal(await page.locator("#next-content").count(), 0);
    for (let n = 1; n <= 2; n++) {
      const article = page.locator("article.resource").filter({
        has: page.locator("strong", { hasText: `Boundary moderation ${n}` }),
      });
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/atlas/submissions/") &&
          r.request().method() === "POST",
      );
      await article.locator('.review[data-decision="accepted"]').click();
      const id = (await (await response).json()).resourceId;
      await page.waitForFunction(
        () => document.querySelectorAll(".edit-publication").length === 100,
      );
      await page.locator("#next-content").waitFor();
      assert.ok(
        (await article.locator(".review-resource").textContent())!.includes(id),
      );
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("article.resource")].some(
            (el) => el.getAttribute("aria-busy") === "true",
          ),
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.locator("#next-content").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-publication").length === 1,
    );
    await page.locator("#prev-content").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-publication").length === 100,
    );
    const restored = page.locator("article.resource").filter({
      has: page.locator("strong", { hasText: "Boundary moderation 1" }),
    });
    assert.ok(
      (await restored.locator(".review-resource").textContent())!.includes(
        "submission-",
      ),
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("list ordering review: a late resource page cannot replace a newer search", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let release = () => {};
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#resources");
    await page.locator("#next-resources").waitFor();
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/admin/api/resources?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("page") !== "2")
        return route.continue();
      const response = await route.fetch();
      enter();
      await held;
      await route.fulfill({ response });
    });
    await page.locator("#next-resources").click();
    await entered;
    await page.locator("#resource-search").fill("selection-first");
    await page.locator("#search-resources").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-resource").length === 1,
    );
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/resources") &&
        new URL(r.url()).searchParams.get("page") === "2",
    );
    release();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    assert.equal(
      await page.locator("#resource-search").inputValue(),
      "selection-first",
    );
    assert.equal(await page.locator(".edit-resource").count(), 1);
    assert.equal(
      await page.locator(".edit-resource").getAttribute("data-id"),
      "selection-first",
    );
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test("list ordering review: obsolete failures retain the newer loading state and current failures can retry", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const releases: (() => void)[] = [];
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#resources");
    await page.locator("#next-resources").waitFor();
    const gate = () => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      releases.push(release);
      return { entered, enter, held, release };
    };
    const old = gate(),
      latest = gate();
    let fail = true;
    await page.route("**/admin/api/resources?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("page") === "2") {
        old.enter();
        await old.held;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "obsolete-page-failure" }),
        });
      }
      if (fail && url.searchParams.get("q") === "selection-first") {
        latest.enter();
        await latest.held;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "current-search-failure" }),
        });
      }
      return route.continue();
    });
    await page.locator("#next-resources").click();
    await old.entered;
    await page.locator("#resource-search").fill("selection-first");
    await page.locator("#search-resources").click();
    await latest.entered;
    const oldResponse = page.waitForResponse(
      (r) =>
        r.url().includes("/resources?") &&
        new URL(r.url()).searchParams.get("page") === "2",
    );
    old.release();
    await (await oldResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      "true",
    );
    assert.equal(await page.locator("#message").textContent(), "");
    assert.equal(
      await page.locator("#resource-search").inputValue(),
      "selection-first",
    );
    latest.release();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "current-search-failure",
    );
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      null,
    );
    assert.equal(await page.locator("#search-resources").isEnabled(), true);
    assert.equal(
      await page.locator("#resource-search").inputValue(),
      "selection-first",
    );
    fail = false;
    await page.locator("#search-resources").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".edit-resource").length === 1,
    );
    assert.equal(
      await page.locator(".edit-resource").getAttribute("data-id"),
      "selection-first",
    );
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      null,
    );
  } finally {
    releases.forEach((release) => release());
    await context.close();
    await browser.close();
  }
});

test("list ordering review: cancelled content pagination cannot clear another route's loading state", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const releases: (() => void)[] = [];
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/atlas");
    await page.locator("#next-content").waitFor();
    const hold = async (pattern: string) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      releases.push(release);
      await page.route(pattern, async (route) => {
        const response = await route.fetch();
        enter();
        await held;
        await route.fulfill({ response });
      });
      return { entered, release };
    };
    const old = await hold("**/admin/api/content/atlas/publications?page=2");
    await page.locator("#next-content").click();
    await old.entered;
    const latest = await hold("**/admin/api/resources?**");
    await page.evaluate(() => {
      location.hash = "resources";
    });
    await latest.entered;
    const response = page.waitForResponse((r) =>
      r.url().includes("/atlas/publications?page=2"),
    );
    old.release();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      "true",
    );
    assert.equal(
      await page
        .locator("#workspace")
        .evaluate((el) => (el as HTMLElement).inert),
      true,
    );
    assert.equal(await page.locator("#message").textContent(), "");
    // The new route keeps the prior view inert until its own data arrives.
    assert.equal(await page.locator(".edit-publication").count(), 100);
    latest.release();
    await page.locator("#resource-search").waitFor();
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      null,
    );
    assert.equal(
      await page
        .locator("#workspace")
        .evaluate((el) => (el as HTMLElement).inert),
      false,
    );
    assert.equal(await page.locator("#publication-list").count(), 0);
  } finally {
    releases.forEach((release) => release());
    await context.close();
    await browser.close();
  }
});

test("resource acknowledgement review: typing during a save retains input and advances only the confirmed version", async () => {
  await resource("ack-existing", "Acknowledgement base");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let release = () => {};
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#resources");
    await page.locator('.edit-resource[data-id="ack-existing"]').click();
    await page.locator("#resource-note").fill("Submitted note");
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    await page.route("**/admin/api/resources", async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      enter();
      await held;
      await route.fulfill({ response });
    });
    await page.locator("#save-resource").click();
    await entered;
    await page.locator("#resource-note").fill("Typed while saving");
    const finished = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/admin/api/resources",
    );
    release();
    assert.equal((await finished).status(), 200);
    await page.waitForFunction(
      () =>
        !(document.querySelector("#save-resource") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Typed while saving",
    );
    const second = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/admin/api/resources",
    );
    await page.locator("#save-resource").click();
    const response = await second;
    assert.equal(response.request().postDataJSON().expectedVersion, 2);
    assert.equal(response.status(), 200);
    assert.equal(
      (
        await pool.query(
          "SELECT version,internal_note FROM resource WHERE id='ack-existing'",
        )
      ).rows[0].internal_note,
      "Typed while saving",
    );
    assert.equal(
      (await pool.query("SELECT version FROM resource WHERE id='ack-existing'"))
        .rows[0].version,
      3,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#resource-id")?.getAttribute("readonly") ===
          null &&
        (document.querySelector("#resource-id") as HTMLInputElement)?.value ===
          "",
    );
    await page.locator('.edit-resource[data-id="ack-existing"]').click();
    await app.content.saveResource(admin, {
      id: "ack-existing",
      expectedVersion: 3,
      data: master("External revision"),
      public: true,
      internalNote: "External note",
    });
    await page.locator("#resource-note").fill("Local conflicting input");
    const conflict = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/admin/api/resources",
    );
    await page.locator("#save-resource").click();
    const rejected = await conflict;
    assert.equal(rejected.request().postDataJSON().expectedVersion, 3);
    assert.equal(rejected.status(), 409);
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("Resource version changed"),
    );
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Local conflicting input",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT version,internal_note FROM resource WHERE id='ack-existing'",
        )
      ).rows[0].internal_note,
      "External note",
    );
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test("resource acknowledgement review: new resources retain subsequent input and switching targets retains the acknowledged cache", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const releases: (() => void)[] = [];
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#resources");
    await page.locator("#resource-id").fill("ack-created");
    await page
      .locator("#resource-data")
      .fill(JSON.stringify(master("Acknowledged creation")));
    const holdSave = async () => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      releases.push(release);
      await page.route(
        "**/admin/api/resources",
        async (route) => {
          const response = await route.fetch();
          enter();
          await held;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      return {
        entered,
        async finish() {
          const response = page.waitForResponse(
            (r) =>
              r.request().method() === "POST" &&
              new URL(r.url()).pathname === "/admin/api/resources",
          );
          release();
          assert.equal((await response).status(), 200);
          await page.waitForFunction(
            () =>
              !(document.querySelector("#save-resource") as HTMLButtonElement)
                .disabled,
          );
        },
      };
    };
    let pending = await holdSave();
    await page.locator("#save-resource").click();
    await pending.entered;
    await page.locator("#resource-note").fill("New resource later input");
    await pending.finish();
    assert.equal(
      await page.locator("#resource-id").inputValue(),
      "ack-created",
    );
    assert.equal(
      await page.locator("#resource-id").getAttribute("readonly"),
      "",
    );
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "New resource later input",
    );
    const updated = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/admin/api/resources",
    );
    await page.locator("#save-resource").click();
    const response = await updated;
    assert.equal(response.request().postDataJSON().expectedVersion, 1);
    assert.equal(response.status(), 200);
    await page.waitForFunction(
      () =>
        (document.querySelector("#resource-id") as HTMLInputElement)?.value ===
        "",
    );
    await page.locator('.edit-resource[data-id="ack-existing"]').click();
    await page.locator("#resource-note").fill("Saved before target switch");
    pending = await holdSave();
    await page.locator("#save-resource").click();
    await pending.entered;
    await page.locator('.edit-resource[data-id="ack-created"]').click();
    await page.locator("#resource-note").fill("Keep other target input");
    await page.evaluate(() => {
      document.querySelector("#message")!.textContent = "OTHER-TARGET";
    });
    await pending.finish();
    assert.equal(
      await page.locator("#resource-id").inputValue(),
      "ack-created",
    );
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Keep other target input",
    );
    assert.equal(await page.locator("#message").textContent(), "OTHER-TARGET");
    await page.locator('.edit-resource[data-id="ack-existing"]').click();
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Saved before target switch",
    );
    await page.locator("#resource-note").fill("Saved after selecting back");
    const savedBack = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/admin/api/resources",
    );
    await page.locator("#save-resource").click();
    const back = await savedBack;
    assert.equal(back.request().postDataJSON().expectedVersion, 5);
    assert.equal(back.status(), 200);
    assert.equal(
      (
        await pool.query(
          "SELECT internal_note FROM resource WHERE id='ack-created'",
        )
      ).rows[0].internal_note,
      "New resource later input",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT version,internal_note FROM resource WHERE id='ack-existing'",
        )
      ).rows[0].version,
      6,
    );
  } finally {
    releases.forEach((release) => release());
    await context.close();
    await browser.close();
  }
});

test("resource acknowledgement review: failures preserve input without inventing a version and refresh failure retains a committed baseline", async () => {
  await resource("ack-failures", "Failure base");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let release = () => {};
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#resources");
    await page.locator('.edit-resource[data-id="ack-failures"]').click();
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route(
      "**/admin/api/resources",
      async (route) => {
        enter();
        await held;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "write-unavailable" }),
        });
      },
      { times: 1 },
    );
    await page.locator("#save-resource").click();
    await entered;
    await page
      .locator("#resource-note")
      .fill("Still typing after failed submission");
    release();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "write-unavailable",
    );
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Still typing after failed submission",
    );
    assert.equal(
      (await pool.query("SELECT version FROM resource WHERE id='ack-failures'"))
        .rows[0].version,
      1,
    );
    await page.route(
      "**/admin/api/resources?**",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "refresh-unavailable" }),
        }),
      { times: 1 },
    );
    const retry = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/admin/api/resources",
    );
    await page.locator("#save-resource").click();
    const saved = await retry;
    assert.equal(saved.request().postDataJSON().expectedVersion, 1);
    assert.equal(saved.status(), 200);
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("已保存；列表刷新失败"),
    );
    assert.equal(
      await page.locator("#resource-note").inputValue(),
      "Still typing after failed submission",
    );
    assert.equal(
      await page
        .locator('.edit-resource[data-id="ack-failures"]')
        .evaluate((el) => el.closest("tr")!.children[1].textContent),
      "2",
    );
    await page.locator("#resource-note").fill("Next confirmed save");
    const next = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/admin/api/resources",
    );
    await page.locator("#save-resource").click();
    const response = await next;
    assert.equal(response.request().postDataJSON().expectedVersion, 2);
    assert.equal(response.status(), 200);
    const record = (
      await pool.query(
        "SELECT version,internal_note FROM resource WHERE id='ack-failures'",
      )
    ).rows[0];
    assert.equal(record.version, 3);
    assert.equal(record.internal_note, "Next confirmed save");
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test("content acknowledgement review: continued typing retains input and uses the confirmed draft version", async () => {
  await resource("aack-content", "Content acknowledgement");
  await stage("atlas", "aack-content");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let release = () => {};
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#content/atlas");
    await page
      .locator("#publication-list tr")
      .filter({ hasText: "aack-content · zh" })
      .locator("button")
      .click();
    const candidate = {
      resourceVersion: 1,
      slug: "aack-content",
      overrides: { description: "First save" },
    };
    await page
      .locator("#publication-candidate")
      .fill(JSON.stringify(candidate));
    let enter!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route(
      "**/aack-content/zh/stage",
      async (route) => {
        const response = await route.fetch();
        enter();
        await held;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.locator("#stage-content").click();
    await entered;
    candidate.overrides.description = "Continued typing";
    const next = JSON.stringify(candidate);
    await page.locator("#publication-candidate").fill(next);
    release();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#stage-content") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      next,
    );
    const saved = page.waitForResponse((r) =>
      r.url().endsWith("/aack-content/zh/stage"),
    );
    await page.locator("#stage-content").click();
    const response = await saved;
    assert.deepEqual(response.request().postDataJSON().expected, {
      published: 0,
      draft: 2,
    });
    assert.equal(response.status(), 200);
    assert.equal(
      (
        await pool.query(
          "SELECT version,candidate FROM content_draft WHERE site_id='atlas' AND resource_id='aack-content' AND locale='zh'",
        )
      ).rows[0].candidate.overrides.description,
      "Continued typing",
    );
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

async function openAcknowledgedContent(page: Page, id: string, locale = "zh") {
  await page.goto(origins[3] + "/admin/login");
  await page.locator("#email").fill(admin.email);
  await page.locator("#password").fill(password);
  await page.locator("button").click();
  await page.waitForURL(origins[3] + "/admin");
  await page.goto(origins[3] + "/admin#content/atlas");
  await page
    .locator("#publication-list tr")
    .filter({ hasText: `${id} · ${locale}` })
    .locator("button")
    .click();
}
async function waitContentWrite(page: Page) {
  await page.waitForFunction(
    () =>
      !(document.querySelector("#stage-content") as HTMLButtonElement).disabled,
  );
}

test("content acknowledgement review: publish and unpublish retain later input and advance the right version pair", async () => {
  await resource("aack-flow", "Publication flow");
  await stage("atlas", "aack-flow");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const releases: (() => void)[] = [];
  try {
    await openAcknowledgedContent(page, "aack-flow");
    const hold = async (action: string) => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      releases.push(release);
      await page.route(
        `**/aack-flow/zh/${action}`,
        async (route) => {
          const response = await route.fetch();
          enter();
          await held;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      return {
        entered,
        async finish() {
          const response = page.waitForResponse((r) =>
            r.url().endsWith(`/aack-flow/zh/${action}`),
          );
          release();
          const result = await response;
          assert.equal(result.status(), 200);
          await waitContentWrite(page);
          return result.request().postDataJSON();
        },
      };
    };
    const saved = {
      resourceVersion: 1,
      slug: "aack-flow",
      overrides: { description: "Later description" },
    };
    let pending = await hold("publish");
    await page.locator("#publish-content").click();
    await pending.entered;
    assert.equal(await page.locator("#stage-content").isEnabled(), false);
    assert.equal(await page.locator("#unpublish-content").isEnabled(), false);
    await page.locator("#publication-candidate").fill(JSON.stringify(saved));
    const firstPublish = await pending.finish();
    assert.deepEqual(firstPublish.expected, { published: 0, draft: 1 });
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      JSON.stringify(saved),
    );
    let response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-flow/zh/stage"),
    );
    await page.locator("#stage-content").click();
    let result = await response;
    assert.deepEqual(result.request().postDataJSON().expected, {
      published: 1,
      draft: 2,
    });
    assert.equal(result.status(), 200);
    await waitContentWrite(page);
    response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-flow/zh/publish"),
    );
    await page.locator("#publish-content").click();
    result = await response;
    assert.equal(result.status(), 200);
    const secondPublish = result.request().postDataJSON();
    assert.deepEqual(secondPublish.expected, { published: 1, draft: 3 });
    assert.notEqual(secondPublish.operationId, firstPublish.operationId);
    await waitContentWrite(page);
    assert.equal(
      (
        await pool.query(
          "SELECT description FROM publication WHERE site_id='atlas' AND resource_id='aack-flow' AND locale='zh'",
        )
      ).rows[0].description,
      saved.overrides.description,
    );
    pending = await hold("unpublish");
    await page.locator("#unpublish-content").click();
    await pending.entered;
    saved.overrides.description = "Edited while unpublishing";
    await page.locator("#publication-candidate").fill(JSON.stringify(saved));
    const unpublish = await pending.finish();
    assert.equal(unpublish.expectedVersion, 2);
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      JSON.stringify(saved),
    );
    response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-flow/zh/stage"),
    );
    await page.locator("#stage-content").click();
    result = await response;
    assert.deepEqual(result.request().postDataJSON().expected, {
      published: 3,
      draft: 4,
    });
    assert.equal(result.status(), 200);
    assert.equal(
      (await app.respond(request(0, "/api/items/zh/aack-flow"))).status,
      404,
    );
  } finally {
    releases.forEach((release) => release());
    await context.close();
    await browser.close();
  }
});

test("content acknowledgement review: a refreshed foreign draft is not silently adopted and a failed refresh preserves the confirmed pair", async () => {
  await resource("aack-external", "External changes");
  await stage("atlas", "aack-external");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await openAcknowledgedContent(page, "aack-external");
    const local = {
      resourceVersion: 1,
      slug: "aack-external",
      overrides: { description: "Own confirmed text" },
    };
    await page.locator("#publication-candidate").fill(JSON.stringify(local));
    await page.route(
      "**/atlas/publications?**",
      async (route) => {
        await app.content.stage(admin, "atlas", "aack-external", "zh", {
          expected: { published: 0, draft: 2 },
          candidate: { ...local, overrides: { description: "Foreign draft" } },
        });
        await route.continue();
      },
      { times: 1 },
    );
    await page.locator("#stage-content").click();
    await waitContentWrite(page);
    assert.equal(
      JSON.parse(await page.locator("#publication-candidate").inputValue())
        .overrides.description,
      "Own confirmed text",
    );
    let response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-external/zh/stage"),
    );
    await page.locator("#stage-content").click();
    let result = await response;
    assert.deepEqual(result.request().postDataJSON().expected, {
      published: 0,
      draft: 2,
    });
    assert.equal(result.status(), 409);
    await waitContentWrite(page);
    assert.equal(
      (
        await pool.query(
          "SELECT candidate FROM content_draft WHERE site_id='atlas' AND resource_id='aack-external' AND locale='zh'",
        )
      ).rows[0].candidate.overrides.description,
      "Foreign draft",
    );
    await page
      .locator("#publication-list tr")
      .filter({ hasText: "aack-external · zh" })
      .locator("button")
      .click();
    assert.equal(
      JSON.parse(await page.locator("#publication-candidate").inputValue())
        .overrides.description,
      "Foreign draft",
    );
    await page.locator("#publication-candidate").fill(JSON.stringify(local));
    await page.route(
      "**/atlas/publications?**",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "refresh-unavailable" }),
        }),
      { times: 1 },
    );
    await page.locator("#stage-content").click();
    await waitContentWrite(page);
    assert.ok(
      (await page.locator("#message").textContent())!.includes(
        "已保存。 发布记录刷新失败",
      ),
    );
    local.overrides.description = "Next save after refresh failure";
    await page.locator("#publication-candidate").fill(JSON.stringify(local));
    response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-external/zh/stage"),
    );
    await page.locator("#stage-content").click();
    result = await response;
    assert.deepEqual(result.request().postDataJSON().expected, {
      published: 0,
      draft: 4,
    });
    assert.equal(result.status(), 200);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("content acknowledgement review: an unacknowledged publish retries the exact operation and later publishing uses a new operation", async () => {
  await resource("aack-retry", "Publish retry");
  await stage("atlas", "aack-retry");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await openAcknowledgedContent(page, "aack-retry");
    const unsaved = JSON.stringify({
      resourceVersion: 1,
      slug: "aack-retry",
      overrides: { description: "Unsaved before publishing" },
    });
    await page.locator("#publication-candidate").fill(unsaved);
    let original: unknown;
    await page.route(
      "**/aack-retry/zh/publish",
      async (route) => {
        original = route.request().postDataJSON();
        assert.equal((await route.fetch()).status(), 200);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "publish-ack-lost" }),
        });
      },
      { times: 1 },
    );
    await page.locator("#publish-content").click();
    await waitContentWrite(page);
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      unsaved,
    );
    assert.equal(
      await page.locator("#message").textContent(),
      "publish-ack-lost",
    );
    let response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-retry/zh/publish"),
    );
    await page.locator("#publish-content").click();
    let result = await response;
    assert.deepEqual(result.request().postDataJSON(), original);
    assert.equal(result.status(), 200);
    await waitContentWrite(page);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM publication_revision WHERE site_id='atlas' AND resource_id='aack-retry' AND locale='zh'",
        )
      ).rows[0].count,
      1,
    );
    await page.locator("#publication-candidate").fill(
      JSON.stringify({
        resourceVersion: 1,
        slug: "aack-retry",
        overrides: { description: "Next publication" },
      }),
    );
    await page.locator("#stage-content").click();
    await waitContentWrite(page);
    response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-retry/zh/publish"),
    );
    await page.locator("#publish-content").click();
    result = await response;
    assert.equal(result.status(), 200);
    assert.notEqual(
      result.request().postDataJSON().operationId,
      (original as { operationId: string }).operationId,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM publication_revision WHERE site_id='atlas' AND resource_id='aack-retry' AND locale='zh'",
        )
      ).rows[0].count,
      2,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("content acknowledgement review: a new locale locks its identity and delayed acknowledgement cannot overwrite another locale", async () => {
  await resource("aack-locales", "Locale acknowledgement");
  await stage("atlas", "aack-locales");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const releases: (() => void)[] = [];
  try {
    await openAcknowledgedContent(page, "aack-locales");
    await page.locator("#new-content").click();
    await page.locator("#publication-resource").fill("aack-locales");
    await page.locator("#publication-locale").selectOption("en");
    const english = {
      resourceVersion: 1,
      slug: "aack-locales",
      overrides: { description: "First English draft" },
    };
    await page.locator("#publication-candidate").fill(JSON.stringify(english));
    const hold = async () => {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      releases.push(release);
      await page.route(
        "**/aack-locales/en/stage",
        async (route) => {
          const response = await route.fetch();
          enter();
          await held;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      return {
        entered,
        async finish() {
          const response = page.waitForResponse((r) =>
            r.url().endsWith("/aack-locales/en/stage"),
          );
          release();
          assert.equal((await response).status(), 200);
          await waitContentWrite(page);
        },
      };
    };
    let pending = await hold();
    await page.locator("#stage-content").click();
    await pending.entered;
    english.overrides.description = "Later English text";
    await page.locator("#publication-candidate").fill(JSON.stringify(english));
    await pending.finish();
    assert.equal(
      await page.locator("#publication-resource").getAttribute("readonly"),
      "",
    );
    assert.equal(await page.locator("#publication-locale").isDisabled(), true);
    assert.equal(await page.locator("#publication-locale").inputValue(), "en");
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      JSON.stringify(english),
    );
    let response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-locales/en/stage"),
    );
    await page.locator("#stage-content").click();
    let saved = await response;
    assert.deepEqual(saved.request().postDataJSON().expected, {
      published: 0,
      draft: 1,
    });
    assert.equal(saved.status(), 200);
    await waitContentWrite(page);
    pending = await hold();
    await page.locator("#stage-content").click();
    await pending.entered;
    await page
      .locator("#publication-list tr")
      .filter({ hasText: "aack-locales · zh" })
      .locator("button")
      .click();
    const chinese = JSON.stringify({
      resourceVersion: 1,
      slug: "aack-locales",
      overrides: { description: "Unsaved Chinese text" },
    });
    await page.locator("#publication-candidate").fill(chinese);
    // A newer observed row must survive the older in-flight acknowledgement.
    await app.content.stage(admin, "atlas", "aack-locales", "en", {
      expected: { published: 0, draft: 3 },
      candidate: {
        ...english,
        overrides: { description: "Observed newer English draft" },
      },
    });
    await page.locator("#refresh-publications").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "发布记录已刷新，其他编辑内容已保留。",
    );

    await page.evaluate(() => {
      document.querySelector("#message")!.textContent = "CHINESE-EDITOR";
    });
    await pending.finish();
    assert.equal(await page.locator("#publication-locale").inputValue(), "zh");
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      chinese,
    );
    assert.equal(
      await page.locator("#message").textContent(),
      "CHINESE-EDITOR",
    );
    await page
      .locator("#publication-list tr")
      .filter({ hasText: "aack-locales · en" })
      .locator("button")
      .click();
    response = page.waitForResponse((r) =>
      r.url().endsWith("/aack-locales/en/stage"),
    );
    await page.locator("#stage-content").click();
    saved = await response;
    assert.deepEqual(saved.request().postDataJSON().expected, {
      published: 0,
      draft: 4,
    });
    assert.equal(saved.status(), 200);
    assert.equal(
      (
        await pool.query(
          "SELECT version FROM content_draft WHERE site_id='atlas' AND resource_id='aack-locales' AND locale='zh'",
        )
      ).rows[0].version,
      1,
    );
  } finally {
    releases.forEach((release) => release());
    await context.close();
    await browser.close();
  }
});

// Actual reader markup and script; API fixtures control response order, not authentication.
async function readerReviewBrowser() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/me", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: personalPage("Reader review", ["zh", "en"]),
    }),
  );
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { config: { catalogPath: "tools" } } }),
  );
  await page.route("**/api/me/submissions", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: [] })
      : route.fallback(),
  );
  return {
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
const readerFavorites = (locale: string) => ({
  total: 1,
  page: 1,
  limit: 24,
  items: [
    {
      resource_id: "reader-item",
      slug: "reader-item",
      locale,
      title: locale === "zh" ? "中文收藏" : "English favorite",
    },
  ],
});
async function readerFrame(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
for (const status of [200, 503])
  test(`reader review: delayed ${status} response cannot replace a newer language`, async () => {
    const { page, close } = await readerReviewBrowser();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await page.route("**/api/me/favorites?*", async (route) => {
        const locale = new URL(route.request().url()).searchParams.get(
          "locale",
        )!;
        if (locale === "zh") {
          entered();
          await held;
        }
        await route.fulfill({
          status: locale === "zh" ? status : 200,
          json:
            status === 503 && locale === "zh"
              ? { error: "Old request failed" }
              : readerFavorites(locale),
        });
      });
      await page.goto(origins[0] + "/me");
      await started;
      await page.locator("#personal-locale").selectOption("en");
      await page
        .getByRole("link", { name: "English favorite", exact: true })
        .waitFor();
      const finished = page.waitForResponse((r) =>
        r.url().includes("/api/me/favorites?locale=zh"),
      );
      release();
      await (await finished).finished();
      await readerFrame(page);
      assert.equal(
        await page.locator("#favorites").innerText(),
        "English favorite\n取消收藏",
      );
      assert.equal(await page.locator("#message").innerText(), "");
    } finally {
      release();
      await close();
    }
  });

test("reader review: temporary loading failures offer retry and only 401 offers login", async () => {
  const { page, close } = await readerReviewBrowser();
  let status = 503;
  try {
    await page.route("**/api/me/favorites?*", (route) =>
      route.fulfill({
        status,
        json:
          status === 200
            ? readerFavorites("zh")
            : { error: "Temporary reader failure" },
      }),
    );
    await page.goto(origins[0] + "/me");
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "Temporary reader failure",
    );
    assert.equal(await page.locator('#favorites a[href="/login"]').count(), 0);
    status = 200;
    await page.locator("#retry-personal").click();
    await page.getByRole("link", { name: "中文收藏", exact: true }).waitFor();
    assert.equal(await page.locator("#message").innerText(), "");
    assert.equal(await page.locator("#message").getAttribute("class"), "");
    status = 401;
    await page.locator("#personal-locale").selectOption("en");
    await page.locator('#favorites a[href="/login"]').waitFor();
  } finally {
    await close();
  }
});

test("reader review: submission acknowledgement preserves edits made while sending", async () => {
  const { page, close } = await readerReviewBrowser();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await page.route("**/api/me/favorites?*", (route) =>
      route.fulfill({ json: readerFavorites("zh") }),
    );
    await page.route("**/api/me/submissions", async (route) => {
      if (route.request().method() === "GET") return route.fallback();
      assert.equal(route.request().postDataJSON().title, "Submitted title");
      entered();
      await held;
      await route.fulfill({
        status: 201,
        json: { id: "fixture-submission", status: "pending" },
      });
    });
    await page.goto(origins[0] + "/me");
    await page.getByRole("link", { name: "中文收藏", exact: true }).waitFor();
    await page.locator("#title").fill("Submitted title");
    await page.locator("#url").fill("https://example.com/submitted");
    await page.locator("#description").fill("Submitted description");
    await page.locator("#submission button").click();
    await started;
    await page.locator("#title").fill("Next suggestion, still editing");
    release();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#submission button") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(
      await page.locator("#title").inputValue(),
      "Next suggestion, still editing",
    );
    assert.match(
      await page.locator("#message").innerText(),
      /当前编辑尚未提交/,
    );
    assert.equal(
      await page.locator("#description").inputValue(),
      "Submitted description",
    );
  } finally {
    release();
    await close();
  }
});

test("reader review: committed submission and failed refresh remain distinct and retry does not resubmit", async () => {
  const { page, close } = await readerReviewBrowser();
  let failing = false,
    posts = 0;
  try {
    await page.route("**/api/me/favorites?*", (route) =>
      route.fulfill({
        status: failing ? 503 : 200,
        json: failing
          ? { error: "Refresh unavailable" }
          : readerFavorites("zh"),
      }),
    );
    await page.route("**/api/me/submissions", async (route) => {
      if (route.request().method() === "GET") return route.fallback();
      posts++;
      failing = true;
      await route.fulfill({
        status: 201,
        json: { id: "fixture-submission", status: "pending" },
      });
    });
    await page.goto(origins[0] + "/me");
    await page.getByRole("link", { name: "中文收藏", exact: true }).waitFor();
    await page.locator("#title").fill("Committed suggestion");
    await page.locator("#url").fill("https://example.com/committed");
    await page.locator("#description").fill("Committed description");
    await page.locator("#submission button").click();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#submission button") as HTMLButtonElement)
          .disabled,
    );
    assert.match(
      await page.locator("#message").innerText(),
      /投稿已提交.*列表刷新失败/,
    );
    assert.equal(await page.locator("#title").inputValue(), "");
    failing = false;
    await page.locator("#retry-personal").click();
    await page.getByRole("link", { name: "中文收藏", exact: true }).waitFor();
    assert.equal(posts, 1);
  } finally {
    await close();
  }
});

test("reader review: repeated clicks on an old pagination control cannot skip a page", async () => {
  const { page, close } = await readerReviewBrowser();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const requested: string[] = [];
  try {
    await page.route("**/api/me/favorites?*", async (route) => {
      const number = new URL(route.request().url()).searchParams.get("page")!;
      requested.push(number);
      if (number === "2") {
        entered();
        await held;
      }
      await route.fulfill({
        json: {
          ...readerFavorites("zh"),
          total: 60,
          page: Number(number),
          items: [
            {
              resource_id: "reader-item",
              slug: "reader-item",
              locale: "zh",
              title: "收藏页" + number,
            },
          ],
        },
      });
    });
    await page.goto(origins[0] + "/me");
    await page.locator("#next-favorites").waitFor();
    await page.locator("#next-favorites").evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await started;
    release();
    await page.getByRole("link", { name: "收藏页2", exact: true }).waitFor();
    await readerFrame(page);
    assert.deepEqual(requested, ["1", "2"]);
    assert.equal(await page.locator("#prev-favorites").count(), 1);
    assert.equal(await page.locator("#next-favorites").count(), 1);
  } finally {
    release();
    await close();
  }
});

async function permissionBlockedBy(blocker: number) {
  const deadline = Date.now() + 4000;
  do {
    const row = (
      await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) LIMIT 1",
        [blocker],
      )
    ).rows[0];
    if (row) return row.pid as number;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail("Expected owned database operation to be blocked");
}
async function permissionEditor(name: string) {
  const email = name + "@example.test";
  const id = await app.sites.operators.create(email, password);
  const actor = { id, email, global_admin: false };
  await app.sites.operators.grant(admin, id, "atlas", "editor");
  return actor;
}
for (const action of ["stage", "publish", "unpublish", "status"] as const)
  test(`permission review: ${action} rejects authority revoked while waiting for its business lock`, async () => {
    const actor = await permissionEditor("permission-" + action);
    const id = "permission-" + action;
    await resource(id);
    await stage("atlas", id);
    if (action !== "publish") await publish("atlas", id);
    const state = async () =>
      (
        await pool.query(
          "SELECT (SELECT to_jsonb(p) FROM publication p WHERE site_id='atlas' AND resource_id=$1 AND locale='zh') AS publication,(SELECT to_jsonb(d) FROM content_draft d WHERE site_id='atlas' AND resource_id=$1 AND locale='zh') AS draft,(SELECT active FROM site WHERE id='atlas') AS active,(SELECT count(*) FROM audit_event WHERE actor_id=$2) AS audits",
          [id, actor.id],
        )
      ).rows[0];
    const before = await state();
    const blocker = await pool.connect();
    let writing: Promise<{ error?: unknown; value?: unknown }> | undefined;
    try {
      await blocker.query("BEGIN");
      if (action === "status")
        await blocker.query("SELECT id FROM site WHERE id='atlas' FOR UPDATE");
      else
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          ["publication:atlas:" + id + ":zh"],
        );
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const operation =
        action === "stage"
          ? app.content.stage(actor, "atlas", id, "zh", {
              candidate: { resourceVersion: 1, slug: id },
              expected: { published: 1, draft: 2 },
            })
          : action === "publish"
            ? app.content.publish(actor, "atlas", id, "zh", {
                expected: { published: 0, draft: 1 },
                operationId: randomUUID(),
              })
            : action === "unpublish"
              ? app.content.unpublish(actor, "atlas", id, "zh", 1)
              : app.sites.status(actor, "atlas", false);
      writing = operation.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await permissionBlockedBy(pid);
      if (action === "publish")
        await pool.query(
          "UPDATE operator_grant SET role='viewer' WHERE user_id=$1 AND site_id='atlas'",
          [actor.id],
        );
      else if (action === "unpublish")
        await pool.query("UPDATE operator_user SET disabled=true WHERE id=$1", [
          actor.id,
        ]);
      else
        await pool.query(
          "DELETE FROM operator_grant WHERE user_id=$1 AND site_id='atlas'",
          [actor.id],
        );
      await blocker.query("COMMIT");
      const result = await writing;
      assert.ok(result.error instanceof HttpError);
      assert.equal(result.error.status, 403);
      assert.deepEqual(await state(), before);
    } finally {
      await blocker.query("ROLLBACK");
      await writing;
      blocker.release();
      await pool.query("UPDATE site SET active=true WHERE id='atlas'");
    }
  });

test("permission review: revocation waits for an already authorized publication transaction", async () => {
  const actor = await permissionEditor("permission-commit-order");
  const id = "permission-commit-order";
  await resource(id);
  await stage("atlas", id);
  const blocker = await pool.connect();
  let writing: Promise<unknown> | undefined,
    revoking: Promise<unknown> | undefined;
  try {
    await pool.query(
      `CREATE FUNCTION hold_permission_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='permission-commit-order' THEN PERFORM pg_advisory_xact_lock(hashtextextended('permission-commit-gate',0)); END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      "CREATE TRIGGER hold_permission_publication BEFORE INSERT OR UPDATE ON publication FOR EACH ROW EXECUTE FUNCTION hold_permission_publication()",
    );
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('permission-commit-gate',0))",
    );
    const gatePid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    writing = app.content.publish(actor, "atlas", id, "zh", {
      expected: { published: 0, draft: 1 },
      operationId: randomUUID(),
    });
    void writing.catch(() => {});
    const publisherPid = await permissionBlockedBy(gatePid);
    revoking = pool.query(
      "DELETE FROM operator_grant WHERE user_id=$1 AND site_id='atlas'",
      [actor.id],
    );
    void revoking.catch(() => {});
    await permissionBlockedBy(publisherPid);
    await blocker.query("COMMIT");
    assert.equal(await writing, 1);
    await revoking;
    await assert.rejects(
      app.content.unpublish(actor, "atlas", id, "zh", 1),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled([writing, revoking].filter(Boolean));
    blocker.release();
    await pool.query(
      "DROP TRIGGER IF EXISTS hold_permission_publication ON publication; DROP FUNCTION IF EXISTS hold_permission_publication()",
    );
  }
});

test("permission review: configuration keeps its site grant until commit", async () => {
  const actor = await permissionEditor("permission-config-commit");
  const store = app.sites.config(actor);
  const before = await store.read("atlas");
  const snapshot = await app.sites.export(actor, "atlas");
  snapshot.config.name = "Permission commit configuration";
  const blocker = await pool.connect();
  let writing: Promise<unknown> | undefined,
    revoking: Promise<unknown> | undefined;
  try {
    await pool.query(
      `CREATE FUNCTION hold_permission_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='atlas' AND NEW.draft->>'name'='Permission commit configuration' THEN PERFORM pg_advisory_xact_lock(hashtextextended('permission-config-commit-gate',0)); END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      "CREATE TRIGGER hold_permission_config BEFORE UPDATE ON site FOR EACH ROW EXECUTE FUNCTION hold_permission_config()",
    );
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('permission-config-commit-gate',0))",
    );
    const gatePid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    writing = app.sites.save(
      actor,
      "atlas",
      snapshot,
      { revision: before.revision, draftVersion: before.draft_version },
      true,
    );
    void writing.catch(() => {});
    const writerPid = await permissionBlockedBy(gatePid);
    revoking = pool.query(
      "DELETE FROM operator_grant WHERE user_id=$1 AND site_id='atlas'",
      [actor.id],
    );
    void revoking.catch(() => {});
    await permissionBlockedBy(writerPid);
    await blocker.query("COMMIT");
    assert.equal(await writing, before.draft_version + 1);
    await revoking;
    const after = await store.read("atlas");
    await assert.rejects(
      app.sites.publish(actor, "atlas", {
        revision: after.revision,
        draftVersion: after.draft_version,
      }),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled([writing, revoking].filter(Boolean));
    blocker.release();
    await pool.query(
      "DROP TRIGGER IF EXISTS hold_permission_config ON site; DROP FUNCTION IF EXISTS hold_permission_config()",
    );
  }
});

let managementSiteCreated = false;
const managementSite = "management-review";
async function managementPermissionSite() {
  if (managementSiteCreated) return;
  await app.sites.create(admin, {
    id: managementSite,
    name: "Management review",
    origin: "https://management-review.example.test",
    centerSite: null,
  });
  await pool.query(
    "UPDATE site SET modules=ARRAY['directory','opensource'] WHERE id=$1",
    [managementSite],
  );
  managementSiteCreated = true;
}
async function managementBusinessSnapshot() {
  // Fixed test-owned table list; hash rows to avoid printing any private fixtures on failure.
  const tables = [
    "resource",
    "resource_revision",
    "category",
    "content_draft",
    "publication",
    "submission",
    "github_source",
    "github_task",
    "github_candidate",
    "github_request",
    "auth_instance",
    "auth_provider",
    "audit_event",
  ];
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        createHash("sha256")
          .update(
            JSON.stringify(
              (
                await pool.query(
                  `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
                )
              ).rows,
            ),
          )
          .digest("hex"),
      ]),
    ),
  );
}
for (const action of [
  "master",
  "import",
  "category",
  "submission",
  "github-source",
  "github-enqueue",
  "github-review",
  "provider",
] as const)
  test(`management permission review: ${action} rejects a queued write after authority is removed`, async () => {
    await managementPermissionSite();
    const local = action === "category" || action === "submission";
    const email = "management-" + action + "@example.test";
    const actor = {
      id: await app.sites.operators.create(email, password, !local),
      email,
      global_admin: !local,
    };
    if (local)
      await app.sites.operators.grant(
        admin,
        actor.id,
        managementSite,
        "editor",
      );
    const resourceId = "management-" + action;
    let lock: (client: import("pg").PoolClient) => Promise<unknown>;
    let write: () => Promise<unknown>;
    if (action === "master" || action === "import") {
      await app.content.saveResource(admin, {
        id: resourceId,
        expectedVersion: 0,
        data: master(),
        internalNote: "private fixture",
      });
      lock = (c) =>
        c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "resource:" + resourceId,
        ]);
      const input = {
        id: resourceId,
        expectedVersion: 1,
        data: master("Changed master"),
      };
      write =
        action === "master"
          ? () => app.content.saveResource(actor, input)
          : () =>
              app.content.importResources(
                actor,
                { schemaVersion: 1, kind: "resources", resources: [input] },
                true,
              );
    } else if (action === "category") {
      lock = (c) =>
        c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "category:" + managementSite + ":" + resourceId,
        ]);
      write = () =>
        app.content.saveCategory(actor, managementSite, {
          id: resourceId,
          labels: { zh: "Review category" },
          expectedVersion: 0,
        });
    } else if (action === "submission") {
      const reader = (
        await pool.query(
          "INSERT INTO identity_user(space_id,email) VALUES($1,'management-reader@example.test') RETURNING id",
          [managementSite],
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO identity_member(site_id,space_id,user_id,role) VALUES($1,$1,$2,'reader')",
        [managementSite, reader],
      );
      const row = (
        await pool.query(
          "INSERT INTO submission(site_id,space_id,user_id,data) VALUES($1,$1,$2,$3) RETURNING id",
          [
            managementSite,
            reader,
            {
              locale: "zh",
              title: "Submitted review item",
              description: "Submitted description",
              url: "https://example.com/submitted-review",
            },
          ],
        )
      ).rows[0];
      lock = (c) =>
        c.query("SELECT id FROM submission WHERE id=$1 FOR UPDATE", [row.id]);
      write = () =>
        app.content.review(actor, managementSite, row.id, {
          expectedVersion: 1,
          decision: "accepted",
        });
    } else if (action === "provider") {
      lock = (c) =>
        c.query("SELECT id FROM auth_instance WHERE site_id=$1 FOR UPDATE", [
          managementSite,
        ]);
      write = () =>
        app.auth.providers.set(actor, managementSite, {
          id: "github",
          kind: "github",
          label: "Review provider",
          clientId: "fixture-client",
          clientSecret: "fixture-secret",
        });
    } else {
      const input = {
        siteId: managementSite,
        resourceId,
        repository: "owner/review",
        enabled: true,
        intervalSeconds: 3600,
        expectedVersion: 0,
      };
      const source = await app.github.save(admin, input);
      if (action === "github-source") {
        lock = (c) =>
          c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "github-source:" + resourceId,
          ]);
        write = () =>
          app.github.save(actor, {
            ...input,
            repository: "owner/changed",
            expectedVersion: 1,
          });
      } else if (action === "github-enqueue") {
        lock = (c) =>
          c.query("SELECT id FROM github_source WHERE id=$1 FOR UPDATE", [
            source.id,
          ]);
        write = () => app.github.enqueue(actor, source.id, randomUUID());
      } else {
        const task = await app.github.enqueue(admin, source.id, randomUUID());
        await pool.query(
          "UPDATE github_task SET status='done',completed_at=now() WHERE id=$1",
          [task.id],
        );
        const data = {
          kind: "repository",
          url: "https://github.com/owner/review",
          source: "fixture",
          translations: {
            en: { title: "owner/review", description: "Review repository" },
          },
          project: {
            provider: "github",
            repoId: "123",
            fullName: "owner/review",
            stars: 1,
            forks: 0,
            openIssues: 0,
            language: null,
            license: null,
            topics: [],
            archived: false,
            pushedAt: null,
          },
        };
        const candidate = (
          await pool.query(
            "INSERT INTO github_candidate(source_id,task_id,source_version,base_version,data) VALUES($1,$2,1,0,$3) RETURNING id",
            [source.id, task.id, data],
          )
        ).rows[0];
        lock = (c) =>
          c.query("SELECT id FROM github_candidate WHERE id=$1 FOR UPDATE", [
            candidate.id,
          ]);
        write = () =>
          app.content.reviewGithub(actor, {
            candidateId: candidate.id,
            expectedCandidateVersion: 1,
            expectedResourceVersion: 0,
            decision: "accept",
            fields: [
              "project",
              "url",
              "source",
              "translations.en.title",
              "translations.en.description",
            ],
          });
      }
    }
    const before = await managementBusinessSnapshot();
    const blocker = await pool.connect();
    let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
    try {
      await blocker.query("BEGIN");
      await lock(blocker);
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      pending = write().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await permissionBlockedBy(pid);
      if (local)
        await pool.query(
          "DELETE FROM operator_grant WHERE user_id=$1 AND site_id=$2",
          [actor.id, managementSite],
        );
      else
        await pool.query(
          "UPDATE operator_user SET global_admin=false WHERE id=$1",
          [actor.id],
        );
      await blocker.query("COMMIT");
      const result = await pending;
      assert.ok(result.error instanceof HttpError);
      assert.equal(result.error.status, 403);
      assert.deepEqual(await managementBusinessSnapshot(), before);
    } finally {
      await blocker.query("ROLLBACK");
      await pending;
      blocker.release();
    }
  });

test("management permission review: bulk import holds global authority across all items", async () => {
  const email = "management-bulk-authority@example.test";
  const actor = {
    id: await app.sites.operators.create(email, password, true),
    email,
    global_admin: true,
  };
  const ids = ["management-bulk-a", "management-bulk-z"];
  for (const id of ids)
    await app.content.saveResource(admin, {
      id,
      expectedVersion: 0,
      data: master(),
    });
  const blocker = await pool.connect();
  let importing: Promise<unknown> | undefined,
    demoting: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["resource:" + ids[1]],
    );
    const gatePid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    importing = app.content.importResources(
      actor,
      {
        schemaVersion: 1,
        kind: "resources",
        resources: ids.map((id) => ({
          id,
          expectedVersion: 1,
          data: master("Updated by bulk import"),
        })),
      },
      true,
    );
    void importing.catch(() => {});
    const writerPid = await permissionBlockedBy(gatePid);
    demoting = pool.query(
      "UPDATE operator_user SET global_admin=false WHERE id=$1",
      [actor.id],
    );
    void demoting.catch(() => {});
    await permissionBlockedBy(writerPid);
    await blocker.query("COMMIT");
    await importing;
    await demoting;
    assert.deepEqual(
      (
        await pool.query(
          "SELECT version FROM resource WHERE id=ANY($1::text[]) ORDER BY id",
          [ids],
        )
      ).rows.map((row) => row.version),
      [2, 2],
    );
    await assert.rejects(
      app.content.saveResource(actor, {
        id: ids[0],
        expectedVersion: 2,
        data: master(),
      }),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled([importing, demoting].filter(Boolean));
    blocker.release();
  }
});

test("management permission review: authorized site editor may accept a submission without global master access", async () => {
  await managementPermissionSite();
  const email = "management-editor-approval@example.test";
  const actor = {
    id: await app.sites.operators.create(email, password),
    email,
    global_admin: false,
  };
  await app.sites.operators.grant(admin, actor.id, managementSite, "editor");
  const reader = (
    await pool.query(
      "INSERT INTO identity_user(space_id,email) VALUES($1,'management-approval-reader@example.test') RETURNING id",
      [managementSite],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO identity_member(site_id,space_id,user_id,role) VALUES($1,$1,$2,'reader')",
    [managementSite, reader],
  );
  const submission = (
    await pool.query(
      "INSERT INTO submission(site_id,space_id,user_id,data) VALUES($1,$1,$2,$3) RETURNING id",
      [
        managementSite,
        reader,
        {
          locale: "zh",
          title: "Approved locally",
          description: "Site-reviewed suggestion",
          url: "https://example.com/local-approval",
        },
      ],
    )
  ).rows[0];
  const result = await app.content.review(
    actor,
    managementSite,
    submission.id,
    { expectedVersion: 1, decision: "accepted" },
  );
  assert.ok(result.resourceId);
  assert.equal(
    (
      await pool.query("SELECT version FROM resource WHERE id=$1", [
        result.resourceId,
      ])
    ).rows[0].version,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM content_draft WHERE site_id=$1 AND resource_id=$2",
        [managementSite, result.resourceId],
      )
    ).rows[0].count,
    "1",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM publication WHERE site_id=$1 AND resource_id=$2",
        [managementSite, result.resourceId],
      )
    ).rows[0].count,
    "0",
  );
  await assert.rejects(
    app.content.saveResource(actor, {
      id: result.resourceId,
      expectedVersion: 1,
      data: master(),
    }),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  );
});

async function importPageFixture() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "network_operator",
      value: await app.sites.operators.login(admin.email, password),
      url: origins[3],
    },
  ]);
  const page = await context.newPage();
  const rows = [
    {
      id: "import-target",
      version: 1,
      data: master("Before import"),
      public: true,
      internal_note: "PRIVATE-FIXTURE",
    },
  ];
  const bundle = {
    schemaVersion: 1,
    kind: "resources",
    resources: [
      {
        id: rows[0].id,
        expectedVersion: 1,
        public: true,
        data: master("Imported"),
        internalNote: "",
      },
    ],
  };
  await page.route("**/admin/api/me", (route) =>
    route.fulfill({ json: admin }),
  );
  await page.route("**/admin/api/sites", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/admin/api/resources?**", (route) =>
    route.fulfill({ json: rows }),
  );
  await page.route("**/admin/api/resources/import-target", (route) =>
    route.fulfill({ json: { history: [] } }),
  );
  await page.route("**/admin/api/operators", (route) =>
    route.fulfill({ json: [] }),
  );
  const accept = () => {
    rows[0] = { ...rows[0], version: 2, data: master("Imported") };
    return { applied: true, results: [{ id: "import-target", version: 2 }] };
  };
  const open = async () => {
    await page.goto(origins[3] + "/admin#resources");
    await page.locator("#resource-id").waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
  };
  const upload = async () => {
    await page.locator("#resource-file").setInputFiles({
      name: "resources.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(bundle)),
    });
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "文件已载入，请检查导入。",
    );
  };
  const prepare = async () => {
    await page.locator('.edit-resource[data-id="import-target"]').click();
    await page.locator("#resource-note").fill("Unsent private edit");
    await page.locator("#resource-zh-title").fill("Unsent title");
  };
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
  return {
    browser,
    context,
    page,
    rows,
    bundle,
    accept,
    open,
    upload,
    prepare,
    settle,
  };
}

test("import interaction review: pending apply blocks duplicate writes and freezes only import controls", async () => {
  const f = await importPageFixture();
  let release!: () => void,
    enter!: () => void,
    posts = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/resources/exchange", async (route) => {
      posts++;
      assert.deepEqual(route.request().postDataJSON(), {
        bundle: f.bundle,
        apply: true,
      });
      enter();
      await gate;
      await route.fulfill({ json: f.accept() });
    });
    await f.open();
    await f.prepare();
    await f.upload();
    await f.page.locator("#apply-import").evaluate((b: HTMLButtonElement) => {
      b.click();
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await entered;
    await f.settle();
    assert.equal(posts, 1);
    assert.equal(await f.page.locator("#save-resource").isDisabled(), true);
    assert.equal(await f.page.locator("#resource-file").isDisabled(), true);
    assert.equal(await f.page.locator("#check-import").isDisabled(), true);
    assert.equal(await f.page.locator("#resource-note").isEnabled(), true);
    await f.page.locator("#resource-note").fill("Typing during import");
    await f.page
      .locator("#resource-file")
      .evaluate((field: HTMLInputElement) => {
        field.value = "";
        field.dispatchEvent(new Event("change", { bubbles: true }));
      });
    release();
    await f.page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("资源已导入"),
    );
    assert.equal(
      await f.page.locator("#resource-note").inputValue(),
      "Typing during import",
    );
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: accepted import refreshes rows without adopting the selected editor version", async () => {
  const f = await importPageFixture();
  const versions: number[] = [];
  try {
    await f.page.route("**/admin/api/resources/exchange", (route) =>
      route.fulfill({ json: f.accept() }),
    );
    await f.page.route("**/admin/api/resources", (route) => {
      versions.push(route.request().postDataJSON().expectedVersion);
      return route.fulfill({
        status: 409,
        json: { error: "IMPORT-VERSION-CONFLICT" },
      });
    });
    await f.open();
    await f.prepare();
    await f.upload();
    await f.page.locator("#apply-import").click();
    await f.page.waitForFunction(
      () =>
        document
          .querySelector('.edit-resource[data-id="import-target"]')
          ?.closest("tr")?.children[1].textContent === "2",
    );
    assert.equal(
      await f.page.locator("#resource-note").inputValue(),
      "Unsent private edit",
    );
    assert.equal(
      await f.page.locator("#resource-zh-title").inputValue(),
      "Unsent title",
    );
    await f.page.locator("#save-resource").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "IMPORT-VERSION-CONFLICT",
    );
    assert.deepEqual(versions, [1]);
    await f.page.locator('.edit-resource[data-id="import-target"]').click();
    assert.equal(
      await f.page.locator("#resource-zh-title").inputValue(),
      "Imported",
    );
    await f.page.locator("#save-resource").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "IMPORT-VERSION-CONFLICT",
    );
    assert.deepEqual(versions, [1, 2]);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: committed import survives list failure and recovers without resubmitting", async () => {
  const f = await importPageFixture();
  let gets = 0,
    posts = 0;
  try {
    await f.page.route("**/admin/api/resources?**", (route) => {
      gets++;
      return gets === 2
        ? route.fulfill({ status: 503, json: { error: "IMPORT-LIST-FAILED" } })
        : route.fulfill({ json: f.rows });
    });
    await f.page.route("**/admin/api/resources/exchange", (route) => {
      posts++;
      return route.fulfill({ json: f.accept() });
    });
    await f.open();
    await f.prepare();
    await f.upload();
    await f.page.locator("#apply-import").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("IMPORT-LIST-FAILED"),
    );
    assert.match(
      await f.page.locator("#message").innerText(),
      /资源已导入.*列表刷新失败/,
    );
    assert.equal(
      await f.page.locator("#resource-note").inputValue(),
      "Unsent private edit",
    );
    assert.equal(await f.page.locator("#apply-import").isDisabled(), true);
    assert.equal(await f.page.locator("#resource-file").inputValue(), "");
    assert.equal(await f.page.locator(".edit-resource").isDisabled(), true);
    await f.page.locator("#refresh-resources").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector(".edit-resource")?.closest("tr")?.children[1]
          .textContent === "2",
    );
    assert.equal(posts, 1);
    assert.equal(gets, 3);
    assert.equal(
      await f.page.locator("#resource-note").inputValue(),
      "Unsent private edit",
    );
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: rejected import keeps file and editor for explicit retry", async () => {
  const f = await importPageFixture();
  let posts = 0;
  try {
    await f.page.route("**/admin/api/resources/exchange", (route) => {
      posts++;
      assert.deepEqual(route.request().postDataJSON().bundle, f.bundle);
      return posts === 1
        ? route.fulfill({ status: 409, json: { error: "IMPORT-REJECTED" } })
        : route.fulfill({ json: f.accept() });
    });
    await f.open();
    await f.prepare();
    await f.upload();
    await f.page.locator("#apply-import").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "IMPORT-REJECTED",
    );
    assert.equal(
      await f.page.locator("#resource-note").inputValue(),
      "Unsent private edit",
    );
    assert.equal(await f.page.locator("#apply-import").isEnabled(), true);
    await f.page.locator("#apply-import").click();
    await f.page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("资源已导入"),
    );
    assert.equal(posts, 2);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: late dry-run cannot replace a committed import notice or unlock controls", async () => {
  const f = await importPageFixture();
  let releaseCheck!: () => void,
    enterCheck!: () => void,
    releaseList!: () => void,
    enterList!: () => void,
    gets = 0;
  const checked = new Promise<void>((r) => (enterCheck = r)),
    checking = new Promise<void>((r) => (releaseCheck = r));
  const listed = new Promise<void>((r) => (enterList = r)),
    listing = new Promise<void>((r) => (releaseList = r));
  try {
    await f.page.route("**/admin/api/resources?**", async (route) => {
      gets++;
      if (gets === 2) {
        enterList();
        await listing;
      }
      await route.fulfill({ json: f.rows });
    });
    await f.page.route("**/admin/api/resources/exchange", async (route) => {
      if (route.request().postDataJSON().apply) {
        await route.fulfill({ json: f.accept() });
        return;
      }
      enterCheck();
      await checking;
      await route.fulfill({ status: 409, json: { error: "OLD-IMPORT-CHECK" } });
    });
    await f.open();
    await f.prepare();
    await f.upload();
    await f.page.locator("#check-import").click();
    await checked;
    await f.page.locator("#apply-import").click();
    await listed;
    const response = f.page.waitForResponse(
      (r) =>
        r.url().endsWith("/resources/exchange") &&
        !r.request().postDataJSON().apply,
    );
    releaseCheck();
    await (await response).finished();
    await f.settle();
    assert.match(await f.page.locator("#message").innerText(), /资源已导入/);
    assert.doesNotMatch(
      await f.page.locator("#message").innerText(),
      /OLD-IMPORT-CHECK/,
    );
    assert.equal(await f.page.locator("#check-import").isDisabled(), true);
    assert.equal(await f.page.locator("#resource-file").isDisabled(), true);
    releaseList();
  } finally {
    releaseCheck();
    releaseList();
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: late import cannot alter another route", async () => {
  const f = await importPageFixture();
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/resources/exchange", async (route) => {
      enter();
      await gate;
      await route.fulfill({ json: f.accept() });
    });
    await f.open();
    await f.upload();
    await f.page.locator("#apply-import").click();
    await entered;
    await f.page.evaluate(() => {
      location.hash = "team";
    });
    await f.page
      .locator("#member-email")
      .fill("kept-during-import@example.test");
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/resources/exchange"),
    );
    release();
    await (await response).finished();
    await f.settle();
    assert.equal(
      await f.page.locator("#member-email").inputValue(),
      "kept-during-import@example.test",
    );
    assert.equal(await f.page.locator("#message").innerText(), "");
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: import retains an unsaved new resource identity", async () => {
  const f = await importPageFixture();
  try {
    await f.page.route("**/admin/api/resources/exchange", (route) =>
      route.fulfill({ json: f.accept() }),
    );
    await f.open();
    await f.page.locator("#resource-id").fill("unsent-new-resource");
    await f.page.locator("#resource-note").fill("Unsent new note");
    await f.upload();
    const response = f.page.waitForResponse((r) =>
      r.url().includes("/resources?"),
    );
    await f.page.locator("#apply-import").click();
    await (await response).finished();
    await f.settle();
    assert.equal(
      await f.page.locator("#resource-id").inputValue(),
      "unsent-new-resource",
    );
    assert.equal(
      await f.page.locator("#resource-note").inputValue(),
      "Unsent new note",
    );
    assert.equal(
      await f.page.locator("#resource-id").getAttribute("readonly"),
      null,
    );
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: active resource save prevents parallel import", async () => {
  const f = await importPageFixture();
  let release!: () => void,
    enter!: () => void,
    imports = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/resources", async (route) => {
      enter();
      await gate;
      await route.fulfill({ json: { version: 2 } });
    });
    await f.page.route("**/admin/api/resources/exchange", (route) => {
      imports++;
      return route.fulfill({ json: f.accept() });
    });
    await f.open();
    await f.prepare();
    await f.upload();
    await f.page.locator("#save-resource").click();
    await entered;
    assert.equal(await f.page.locator("#apply-import").isDisabled(), true);
    assert.equal(await f.page.locator("#refresh-resources").isDisabled(), true);
    await f.page
      .locator("#apply-import")
      .evaluate((b: HTMLButtonElement) =>
        b.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
    await f.settle();
    assert.equal(imports, 0);
    release();
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: manual list refresh preserves typing and refuses an implicit foreign version", async () => {
  const f = await importPageFixture();
  let release!: () => void,
    enter!: () => void,
    gets = 0,
    imports = 0,
    version = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/resources?**", async (route) => {
      gets++;
      if (gets === 2) {
        enter();
        await gate;
      }
      await route.fulfill({ json: f.rows });
    });
    await f.page.route("**/admin/api/resources/exchange", (route) => {
      imports++;
      return route.fulfill({ json: f.accept() });
    });
    await f.page.route("**/admin/api/resources", (route) => {
      version = route.request().postDataJSON().expectedVersion;
      return route.fulfill({
        status: 409,
        json: { error: "FOREIGN-VERSION-CONFLICT" },
      });
    });
    await f.open();
    await f.prepare();
    await f.upload();
    await f.page.locator("#refresh-resources").click();
    await entered;
    assert.equal(await f.page.locator("#save-resource").isDisabled(), true);
    assert.equal(await f.page.locator("#apply-import").isDisabled(), true);
    await f.page
      .locator("#apply-import")
      .evaluate((b: HTMLButtonElement) =>
        b.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
    await f.page.locator("#resource-note").fill("Typing while list waits");
    f.rows[0] = { ...f.rows[0], version: 7, data: master("Foreign version") };
    const response = f.page.waitForResponse((r) =>
      r.url().includes("/resources?"),
    );
    release();
    await (await response).finished();
    await f.settle();
    assert.equal(imports, 0);
    assert.equal(
      await f.page.locator("#resource-note").inputValue(),
      "Typing while list waits",
    );
    assert.equal(
      await f.page.locator("#resource-zh-title").inputValue(),
      "Unsent title",
    );
    assert.equal(
      await f.page
        .locator(".edit-resource")
        .evaluate((b) => b.closest("tr")!.children[1].textContent),
      "7",
    );
    await f.page.locator("#save-resource").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "FOREIGN-VERSION-CONFLICT",
    );
    assert.equal(version, 1);
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("import interaction review: a confirmed file cannot repeat until another file is explicitly selected", async () => {
  const f = await importPageFixture();
  const expected: number[] = [];
  try {
    await f.page.route("**/admin/api/resources/exchange", (route) => {
      const entry = route.request().postDataJSON().bundle.resources[0];
      expected.push(entry.expectedVersion);
      f.rows[0] = {
        ...f.rows[0],
        version: f.rows[0].version + 1,
        data: entry.data,
      };
      return route.fulfill({
        json: {
          applied: true,
          results: [{ id: entry.id, version: f.rows[0].version }],
        },
      });
    });
    await f.open();
    await f.prepare();
    await f.upload();
    await f.page.locator("#apply-import").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector(".edit-resource")?.closest("tr")?.children[1]
          .textContent === "2",
    );
    assert.equal(await f.page.locator("#apply-import").isDisabled(), true);
    f.bundle.resources[0].expectedVersion = 2;
    await f.upload();
    assert.equal(await f.page.locator("#apply-import").isEnabled(), true);
    await f.page.locator("#apply-import").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector(".edit-resource")?.closest("tr")?.children[1]
          .textContent === "3",
    );
    assert.deepEqual(expected, [1, 2]);
    assert.equal(
      await f.page.locator("#resource-note").inputValue(),
      "Unsent private edit",
    );
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

async function diffReviewResource(id: string) {
  await resource(id);
  await app.content.saveResource(admin, {
    id,
    expectedVersion: 1,
    data: master("New shared master"),
    public: true,
  });
}
const diffDraft = (slug: string) => ({
  resourceVersion: 1,
  slug,
  categoryId: null,
  rank: 37,
  overrides: {
    title: "Saved site title",
    description: "Saved site description",
    url: "https://example.test/saved",
    seoTitle: "Saved SEO",
    seoDescription: "Saved SEO description",
  },
});

test("master diff review: saved draft fields survive choosing latest master without writing", async () => {
  const id = "adiff-saved";
  await diffReviewResource(id);
  await stage("atlas", id);
  await publish("atlas", id);
  await app.content.saveCategory(admin, "atlas", {
    id: "diff-category",
    labels: { zh: "待发布分类" },
    expectedVersion: 0,
  });
  const candidate = { ...diffDraft("draft-slug"), categoryId: "diff-category" };
  await app.content.stage(admin, "atlas", id, "zh", {
    candidate,
    expected: { published: 1, draft: 2 },
  });
  const before = await pool.query(
    "SELECT candidate,version FROM content_draft WHERE site_id='atlas' AND resource_id=$1",
    [id],
  );
  const history = await pool.query(
    "SELECT count(*) FROM publication_revision WHERE resource_id=$1",
    [id],
  );
  const result = await app.content.updateDiff(admin, "atlas", id, "zh");
  assert.deepEqual(result.candidate, { ...candidate, resourceVersion: 2 });
  assert.equal(result.sourceVersion, 1);
  assert.equal(result.latestVersion, 2);
  assert.ok(
    result.differences.some(
      (d) => d.field === "title" && d.after === "Saved site title",
    ),
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT candidate,version FROM content_draft WHERE site_id='atlas' AND resource_id=$1",
        [id],
      )
    ).rows,
    before.rows,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT count(*) FROM publication_revision WHERE resource_id=$1",
        [id],
      )
    ).rows,
    history.rows,
  );
  assert.equal(
    (
      await app.catalog.detail(
        await app.catalog.resolve(new URL(origins[0]).host),
        "zh",
        id,
      )
    ).title,
    "Shared title",
  );
});
test("master diff review: never published draft can compare and stays private", async () => {
  const id = "adiff-new";
  await diffReviewResource(id);
  const candidate = diffDraft("new-draft-slug");
  await stage("atlas", id, "zh", candidate);
  const result = await app.content.updateDiff(admin, "atlas", id, "zh");
  assert.deepEqual(result.candidate, { ...candidate, resourceVersion: 2 });
  assert.equal(result.sourceVersion, 0);
  assert.equal(
    result.differences.find((d) => d.field === "title")?.before,
    null,
  );
  assert.equal(
    (await app.respond(request(0, "/api/items/zh/new-draft-slug"))).status,
    404,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT version FROM content_draft WHERE site_id='atlas' AND resource_id=$1",
        [id],
      )
    ).rows[0].version,
    1,
  );
});
test("master diff review: consumed draft falls back to its own site and language snapshot", async () => {
  const id = "adiff-fallback";
  await diffReviewResource(id);
  await stage("atlas", id, "zh", { overrides: { title: "Atlas published" } });
  await publish("atlas", id);
  await stage("notes", id, "zh", { overrides: { title: "Other site" } });
  await stage("atlas", id, "en", { overrides: { title: "English draft" } });
  const result = await app.content.updateDiff(admin, "atlas", id, "zh");
  assert.equal(result.candidate.overrides.title, "Atlas published");
  assert.equal(result.candidate.resourceVersion, 2);
  assert.equal(
    (await app.content.updateDiff(admin, "atlas", id, "en")).candidate.overrides
      .title,
    "English draft",
  );
});
test("master diff review: absent distribution and missing completed translation remain errors", async () => {
  const id = "adiff-validation";
  await diffReviewResource(id);
  await assert.rejects(
    app.content.updateDiff(admin, "atlas", id, "zh"),
    (e: unknown) => e instanceof HttpError && e.status === 404,
  );
  await stage("atlas", id, "en");
  await app.content.saveResource(admin, {
    id,
    expectedVersion: 2,
    data: {
      ...master(),
      translations: { zh: { title: "Only Chinese", description: "仅中文" } },
    },
    public: true,
  });
  await assert.rejects(
    app.content.updateDiff(admin, "atlas", id, "en"),
    (e: unknown) => e instanceof HttpError && e.status === 400,
  );
});
test("master diff review: site viewer may read draft comparison while another site remains forbidden", async () => {
  const id = "adiff-viewer";
  await diffReviewResource(id);
  await stage("atlas", id);
  const actor = {
    id: await app.sites.operators.create("diff-viewer@example.test", password),
    email: "diff-viewer@example.test",
    global_admin: false,
  };
  await app.sites.operators.grant(admin, actor.id, "atlas", "viewer");
  assert.equal(
    (await app.content.updateDiff(actor, "atlas", id, "zh")).candidate
      .resourceVersion,
    2,
  );
  await assert.rejects(
    app.content.updateDiff(actor, "notes", id, "zh"),
    (e: unknown) => e instanceof HttpError && e.status === 403,
  );
  await assert.rejects(
    app.content.stage(actor, "atlas", id, "zh", {
      candidate: diffDraft(id),
      expected: { published: 0, draft: 1 },
    }),
    (e: unknown) => e instanceof HttpError && e.status === 403,
  );
});

test("master diff review: draft clears override and category instead of falling back field by field", async () => {
  const id = "adiff-cleared";
  await diffReviewResource(id);
  await app.content.saveCategory(admin, "atlas", {
    id: "diff-cleared-category",
    labels: { zh: "原分类" },
    expectedVersion: 0,
  });
  await stage("atlas", id, "zh", {
    categoryId: "diff-cleared-category",
    rank: 20,
    overrides: { title: "Published override" },
  });
  await publish("atlas", id);
  await app.content.stage(admin, "atlas", id, "zh", {
    candidate: {
      resourceVersion: 1,
      slug: id,
      categoryId: null,
      rank: 0,
      overrides: {},
    },
    expected: { published: 1, draft: 2 },
  });
  const result = await app.content.updateDiff(admin, "atlas", id, "zh");
  assert.deepEqual(result.candidate, {
    resourceVersion: 2,
    slug: id,
    categoryId: null,
    rank: 0,
    overrides: {},
  });
  assert.equal(
    result.differences.find((d) => d.field === "title")?.after,
    "New shared master",
  );
});
test("master diff review: browser compares saved draft then saves and publishes explicitly", async () => {
  const id = "adiff-browser";
  await diffReviewResource(id);
  await stage("atlas", id);
  await publish("atlas", id);
  const draft = diffDraft("browser-draft-slug");
  await app.content.stage(admin, "atlas", id, "zh", {
    candidate: draft,
    expected: { published: 1, draft: 2 },
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await openAcknowledgedContent(page, id);
    await page.locator("#diff-content").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("已载入候选和差异"),
    );
    assert.deepEqual(
      JSON.parse(await page.locator("#publication-candidate").inputValue()),
      { ...draft, resourceVersion: 2 },
    );
    assert.equal(
      (
        await pool.query(
          "SELECT candidate FROM content_draft WHERE site_id='atlas' AND resource_id=$1",
          [id],
        )
      ).rows[0].candidate.resourceVersion,
      1,
    );
    const staged = page.waitForResponse((r) =>
      r.url().endsWith(`/${id}/zh/stage`),
    );
    await page.locator("#stage-content").click();
    assert.deepEqual((await staged).request().postDataJSON().expected, {
      published: 1,
      draft: 3,
    });
    await waitContentWrite(page);
    const published = page.waitForResponse((r) =>
      r.url().endsWith(`/${id}/zh/publish`),
    );
    await page.locator("#publish-content").click();
    assert.equal((await published).status(), 200);
    await waitContentWrite(page);
    const row = (
      await pool.query(
        "SELECT slug,title,rank,source_version,overrides FROM publication WHERE site_id='atlas' AND resource_id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(row.slug, draft.slug);
    assert.equal(row.title, draft.overrides.title);
    assert.equal(row.rank, draft.rank);
    assert.equal(row.source_version, 2);
    assert.deepEqual(row.overrides, draft.overrides);
  } finally {
    await context.close();
    await browser.close();
  }
});
test("master diff review: comparison does not grant an older editor the newer draft version", async () => {
  const id = "adiff-conflict";
  await diffReviewResource(id);
  await stage("atlas", id);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await openAcknowledgedContent(page, id);
    const foreign = diffDraft("foreign-draft-slug");
    await app.content.stage(admin, "atlas", id, "zh", {
      candidate: foreign,
      expected: { published: 0, draft: 1 },
    });
    await page.locator("#diff-content").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("已载入候选和差异"),
    );
    const compared = await page.locator("#publication-candidate").inputValue();
    assert.equal(JSON.parse(compared).resourceVersion, 2);
    const staged = page.waitForResponse((r) =>
      r.url().endsWith(`/${id}/zh/stage`),
    );
    await page.locator("#stage-content").click();
    const response = await staged;
    assert.deepEqual(response.request().postDataJSON().expected, {
      published: 0,
      draft: 1,
    });
    assert.equal(response.status(), 409);
    await waitContentWrite(page);
    assert.equal(
      await page.locator("#publication-candidate").inputValue(),
      compared,
    );
    const saved = (
      await pool.query(
        "SELECT candidate,version FROM content_draft WHERE site_id='atlas' AND resource_id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.candidate, foreign);
  } finally {
    await context.close();
    await browser.close();
  }
});

const personalSubmission = {
  locale: "zh",
  title: "Session transaction review",
  description: "Reader submission",
  url: "https://example.test/personal-review",
};
async function personalReviewVisitor() {
  const user = (
    await pool.query(
      "INSERT INTO identity_user(space_id,email) VALUES('atlas',$1) RETURNING id",
      ["personal-" + randomUUID() + "@example.test"],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO identity_member(site_id,space_id,user_id) VALUES('atlas','atlas',$1)",
    [user],
  );
  return (
    await pool.query(
      "INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at,absolute_expires_at) VALUES('atlas','atlas',$1,$2,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day') RETURNING id,user_id",
      [user, randomUUID()],
    )
  ).rows[0] as { id: string; user_id: string };
}
for (const change of ["revoke", "ban", "expire", "absolute-expire"] as const) {
  test(`personal transaction review: queued submission rejects ${change} committed during rate-lock wait`, async () => {
    const visitor = await personalReviewVisitor(),
      blocker = await pool.connect();
    let writing: Promise<{ error?: unknown; value?: unknown }> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["submission:atlas:" + visitor.user_id],
      );
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      writing = app.personal.submit("atlas", visitor, personalSubmission).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await permissionBlockedBy(pid);
      if (change === "ban")
        await pool.query("UPDATE identity_user SET banned=true WHERE id=$1", [
          visitor.user_id,
        ]);
      else if (change === "revoke")
        await pool.query(
          "UPDATE identity_session SET revoked=true WHERE id=$1",
          [visitor.id],
        );
      else
        await pool.query(
          `UPDATE identity_session SET ${change === "expire" ? "expires_at" : "absolute_expires_at"}=clock_timestamp() WHERE id=$1`,
          [visitor.id],
        );
      await blocker.query("COMMIT");
      const result = await writing;
      assert.ok(result.error instanceof HttpError);
      assert.equal(result.error.status, 401);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM submission WHERE user_id=$1",
            [visitor.user_id],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await blocker.query("ROLLBACK");
      await writing;
      blocker.release();
    }
  });
}
for (const action of [
  "submit",
  "favorite-add",
  "favorite-remove",
  "favorite-ban",
] as const) {
  test(`personal transaction review: revocation waits for authorized ${action} transaction`, async () => {
    const visitor = await personalReviewVisitor(),
      blocker = await pool.connect();
    const id = "apersonal-" + action;
    if (action !== "submit") {
      await resource(id);
      await stage("atlas", id);
      await publish("atlas", id);
    }
    if (action === "favorite-remove")
      await app.personal.favorite("atlas", visitor, id, true);
    let writing: Promise<unknown> | undefined,
      revoking: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `LOCK TABLE ${action === "submit" ? "submission" : "favorite"} IN ACCESS EXCLUSIVE MODE`,
      );
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      writing =
        action === "submit"
          ? app.personal.submit("atlas", visitor, personalSubmission)
          : app.personal.favorite(
              "atlas",
              visitor,
              id,
              action !== "favorite-remove",
            );
      const writer = await permissionBlockedBy(pid);
      revoking =
        action === "favorite-ban"
          ? pool.query("UPDATE identity_user SET banned=true WHERE id=$1", [
              visitor.user_id,
            ])
          : pool.query("UPDATE identity_session SET revoked=true WHERE id=$1", [
              visitor.id,
            ]);
      await permissionBlockedBy(writer);
      await blocker.query("COMMIT");
      await writing;
      await revoking;
      const denied =
        action === "favorite-ban"
          ? (
              await pool.query(
                "SELECT banned AS denied FROM identity_user WHERE id=$1",
                [visitor.user_id],
              )
            ).rows[0].denied
          : (
              await pool.query(
                "SELECT revoked AS denied FROM identity_session WHERE id=$1",
                [visitor.id],
              )
            ).rows[0].denied;
      assert.equal(denied, true);
      const table = action === "submit" ? "submission" : "favorite";
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,
            [visitor.user_id],
          )
        ).rows[0].n,
        action === "favorite-remove" ? 0 : 1,
      );
      const next =
        action === "submit"
          ? app.personal.submit("atlas", visitor, personalSubmission)
          : app.personal.favorite("atlas", visitor, id, false);
      await assert.rejects(
        next,
        (e: unknown) => e instanceof HttpError && e.status === 401,
      );
    } finally {
      await blocker.query("ROLLBACK");
      await Promise.allSettled([writing, revoking]);
      blocker.release();
    }
  });
}
for (const action of ["submit", "favorite"] as const) {
  test(`personal transaction review: ${action} checks deadline after identity-row lock wait`, async () => {
    const visitor = await personalReviewVisitor(),
      blocker = await pool.connect();
    const id = "apersonal-expiry-favorite";
    if (action === "favorite") {
      await resource(id);
      await stage("atlas", id);
      await publish("atlas", id);
    }
    const column = action === "submit" ? "absolute_expires_at" : "expires_at";
    let writing: Promise<{ error?: unknown; value?: unknown }> | undefined;
    try {
      const deadline = (
        await pool.query(
          `UPDATE identity_session SET ${column}=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING ${column}::text AS deadline`,
          [visitor.id],
        )
      ).rows[0].deadline;
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM identity_user WHERE id=$1 FOR UPDATE",
        [visitor.user_id],
      );
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const work =
        action === "submit"
          ? app.personal.submit("atlas", visitor, personalSubmission)
          : app.personal.favorite("atlas", visitor, id, true);
      writing = work.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const writer = await permissionBlockedBy(pid);
      assert.equal(
        (
          await pool.query(
            "SELECT xact_start<$1::timestamptz AS started_before FROM pg_stat_activity WHERE pid=$2",
            [deadline, writer],
          )
        ).rows[0].started_before,
        true,
      );
      await pool.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM($1::timestamptz-clock_timestamp())))+0.02)",
        [deadline],
      );
      await blocker.query("COMMIT");
      const result = await writing;
      assert.ok(result.error instanceof HttpError);
      assert.equal(result.error.status, 401);
      const table = action === "submit" ? "submission" : "favorite";
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,
            [visitor.user_id],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await blocker.query("ROLLBACK");
      await writing;
      blocker.release();
    }
  });
}

async function seedPersonalRateWindow(
  visitor: { user_id: string },
  count: number,
  seconds = 1,
) {
  const rows = await pool.query(
    `INSERT INTO submission(site_id,space_id,user_id,data,created_at)
     SELECT 'atlas','atlas',$1,$2,clock_timestamp()-interval '1 hour'+$4::int*interval '1 second' FROM generate_series(1,$3::int)
     RETURNING (created_at+interval '1 hour')::text AS deadline`,
    [visitor.user_id, personalSubmission, count, seconds],
  );
  return rows.rows.at(-1)!.deadline as string;
}
async function waitPersonalWindow(deadline: string, writer: number) {
  assert.equal(
    (
      await pool.query(
        "SELECT xact_start<$1::timestamptz AS before FROM pg_stat_activity WHERE pid=$2",
        [deadline, writer],
      )
    ).rows[0].before,
    true,
  );
  await pool.query(
    "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM($1::timestamptz-clock_timestamp())))+0.02)",
    [deadline],
  );
}
for (const wait of ["business", "table"] as const) {
  test(`submission clock review: ${wait} lock wait can cross the hourly window`, async () => {
    const visitor = await personalReviewVisitor(),
      blocker = await pool.connect();
    let writing:
      Promise<{ error?: unknown; value?: { id: string } }> | undefined;
    try {
      await blocker.query("BEGIN");
      if (wait === "business")
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          ["submission:atlas:" + visitor.user_id],
        );
      const deadline = await seedPersonalRateWindow(visitor, 10);
      if (wait === "table")
        await blocker.query("LOCK TABLE submission IN ACCESS EXCLUSIVE MODE");
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      writing = app.personal.submit("atlas", visitor, personalSubmission).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const writer = await permissionBlockedBy(pid);
      await waitPersonalWindow(deadline, writer);
      await blocker.query("COMMIT");
      const result = await writing;
      assert.equal(result.error, undefined);
      assert.ok(result.value?.id);
      const counts = (
        await pool.query(
          "SELECT count(*)::int AS all_rows,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 hour')::int AS recent FROM submission WHERE user_id=$1",
          [visitor.user_id],
        )
      ).rows[0];
      assert.equal(counts.all_rows, 11);
      assert.equal(counts.recent, 1);
    } finally {
      await blocker.query("ROLLBACK");
      await writing;
      blocker.release();
    }
  });
}
test("submission clock review: queued submission time is at insertion instead of transaction start", async () => {
  const visitor = await personalReviewVisitor(),
    blocker = await pool.connect();
  let writing: Promise<{ id: string }> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["submission:atlas:" + visitor.user_id],
    );
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    writing = app.personal.submit("atlas", visitor, personalSubmission);
    await permissionBlockedBy(pid);
    const release = (
      await blocker.query("SELECT clock_timestamp()::text AS at")
    ).rows[0].at;
    await blocker.query("COMMIT");
    const result = await writing;
    assert.equal(
      (
        await pool.query(
          "SELECT created_at>=$2::timestamptz AS after_release FROM submission WHERE id=$1",
          [result.id, release],
        )
      ).rows[0].after_release,
      true,
    );
  } finally {
    await blocker.query("ROLLBACK");
    await writing;
    blocker.release();
  }
});

test("submission clock review: concurrent queued requests cannot overbook the tenth slot", async () => {
  const visitor = await personalReviewVisitor(),
    blocker = await pool.connect();
  await seedPersonalRateWindow(visitor, 9, 3600);
  let writing: Promise<PromiseSettledResult<{ id: string }>[]> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["submission:atlas:" + visitor.user_id],
    );
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    writing = Promise.allSettled(
      Array.from({ length: 3 }, () =>
        app.personal.submit("atlas", visitor, personalSubmission),
      ),
    );
    await permissionBlockedBy(pid);
    const release = (
      await blocker.query("SELECT clock_timestamp()::text AS at")
    ).rows[0].at;
    await blocker.query("COMMIT");
    const results = await writing;
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const result of results.filter((r) => r.status === "rejected")) {
      assert.ok(result.reason instanceof HttpError);
      assert.equal(result.reason.status, 429);
    }
    const counts = (
      await pool.query(
        "SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at >= $2::timestamptz)::int AS inserted_after_release FROM submission WHERE site_id='atlas' AND user_id=$1",
        [visitor.user_id, release],
      )
    ).rows[0];
    assert.equal(counts.total, 10);
    assert.equal(counts.inserted_after_release, 1);
  } finally {
    await blocker.query("ROLLBACK");
    await writing;
    blocker.release();
  }
});
test("submission clock review: quota remains isolated by site and canonical user", async () => {
  const visitor = await personalReviewVisitor(),
    other = await personalReviewVisitor();
  await seedPersonalRateWindow(visitor, 10, 3600);
  await assert.rejects(
    app.personal.submit("atlas", visitor, personalSubmission),
    (e: unknown) => e instanceof HttpError && e.status === 429,
  );
  assert.ok((await app.personal.submit("atlas", other, personalSubmission)).id);
  await pool.query(
    "INSERT INTO identity_member(site_id,space_id,user_id) VALUES('notes','atlas',$1)",
    [visitor.user_id],
  );
  const notes = (
    await pool.query(
      "INSERT INTO identity_session(site_id,space_id,user_id,center_session,expires_at,absolute_expires_at) VALUES('notes','atlas',$1,$2,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day') RETURNING id,user_id",
      [visitor.user_id, randomUUID()],
    )
  ).rows[0];
  assert.ok((await app.personal.submit("notes", notes, personalSubmission)).id);
  const rows = (
    await pool.query(
      "SELECT site_id,count(*)::int AS n FROM submission WHERE user_id=$1 GROUP BY site_id ORDER BY site_id",
      [visitor.user_id],
    )
  ).rows;
  assert.deepEqual(rows, [
    { site_id: "atlas", n: 10 },
    { site_id: "notes", n: 1 },
  ]);
});

async function readerCommitFixture() {
  const f = await readerReviewBrowser();
  await f.page.route("**/api/me/favorites?*", (route) =>
    route.fulfill({
      json: readerFavorites(
        new URL(route.request().url()).searchParams.get("locale") ?? "zh",
      ),
    }),
  );
  const open = async () => {
    await f.page.goto(origins[0] + "/me");
    await f.page.getByRole("link", { name: "中文收藏", exact: true }).waitFor();
    await f.page.locator("#title").fill("Committed reader suggestion");
    await f.page.locator("#url").fill("https://example.com/reader-commit");
    await f.page.locator("#description").fill("Reader description");
  };
  const submit = () =>
    f.page
      .locator("#submission")
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
  return { ...f, open, submit };
}
function readerGate() {
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      enter = r;
    });
  return { release, enter, held, started };
}
test("reader commit review: repeated form submission is blocked while POST and follow-up read wait", async () => {
  const f = await readerCommitFixture(),
    post = readerGate(),
    read = readerGate();
  let posts = 0,
    committed = false;
  try {
    await f.page.route("**/api/me/submissions", async (route) => {
      if (route.request().method() === "GET") {
        if (committed) {
          read.enter();
          await read.held;
        }
        return route.fulfill({ json: [] });
      }
      posts++;
      post.enter();
      await post.held;
      committed = true;
      await route.fulfill({
        status: 201,
        json: { id: "fixture", status: "pending" },
      });
    });
    await f.open();
    await f.submit();
    await post.started;
    await f.submit();
    await f.submit();
    await readerFrame(f.page);
    assert.equal(posts, 1);
    post.release();
    await read.started;
    await f.page.locator("#title").fill("Unsent next suggestion");
    await f.page.locator("#url").fill("https://example.com/next");
    await f.page.locator("#description").fill("Unsent next description");
    await f.submit();
    await readerFrame(f.page);
    assert.equal(posts, 1);
    read.release();
    await f.page.waitForFunction(
      () =>
        !(document.querySelector("#submission button") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Unsent next suggestion",
    );
  } finally {
    post.release();
    read.release();
    await f.close();
  }
});
test("reader commit review: submission confirmation appears before its read completes", async () => {
  const f = await readerCommitFixture(),
    read = readerGate();
  let committed = false;
  try {
    await f.page.route("**/api/me/submissions", async (route) => {
      if (route.request().method() === "GET") {
        if (committed) {
          read.enter();
          await read.held;
        }
        return route.fulfill({ json: [] });
      }
      committed = true;
      await route.fulfill({
        status: 201,
        json: { id: "fixture", status: "pending" },
      });
    });
    await f.open();
    await f.submit();
    await read.started;
    await readerFrame(f.page);
    assert.match(await f.page.locator("#message").innerText(), /投稿已提交/);
  } finally {
    read.release();
    await f.close();
  }
});
for (const status of [200, 503]) {
  test(`reader commit review: superseded ${status} read cannot erase submission confirmation`, async () => {
    const f = await readerCommitFixture(),
      read = readerGate();
    let committed = false,
      posts = 0;
    try {
      await f.page.route("**/api/me/favorites?*", async (route) => {
        const locale = new URL(route.request().url()).searchParams.get(
          "locale",
        )!;
        if (committed && locale === "zh") {
          read.enter();
          await read.held;
          return route.fulfill({
            status,
            json:
              status === 200
                ? readerFavorites(locale)
                : { error: "Old refresh failed" },
          });
        }
        await route.fulfill({ json: readerFavorites(locale) });
      });
      await f.page.route("**/api/me/submissions", async (route) => {
        if (route.request().method() === "GET")
          return route.fulfill({ json: [] });
        posts++;
        committed = true;
        await route.fulfill({
          status: 201,
          json: { id: "fixture", status: "pending" },
        });
      });
      await f.open();
      await f.submit();
      await read.started;
      await f.page.locator("#personal-locale").selectOption("en");
      await f.page
        .getByRole("link", { name: "English favorite", exact: true })
        .waitFor();
      const finished = f.page.waitForResponse((r) =>
        r.url().includes("favorites?locale=zh"),
      );
      read.release();
      await (await finished).finished();
      await readerFrame(f.page);
      assert.match(await f.page.locator("#message").innerText(), /投稿已提交/);
      assert.doesNotMatch(
        await f.page.locator("#message").innerText(),
        /Old refresh failed|列表刷新失败/,
      );
      assert.equal(posts, 1);
    } finally {
      read.release();
      await f.close();
    }
  });
}

test("reader commit review: rejected submission keeps inputs and enables explicit retry", async () => {
  const f = await readerCommitFixture();
  let posts = 0;
  try {
    await f.page.route("**/api/me/submissions", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ json: [] });
      posts++;
      await route.fulfill(
        posts === 1
          ? { status: 503, json: { error: "Fixture submission rejected" } }
          : { status: 201, json: { id: "fixture", status: "pending" } },
      );
    });
    await f.open();
    await f.submit();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "Fixture submission rejected",
    );
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
    assert.equal(
      await f.page.locator("#submission button").isDisabled(),
      false,
    );
    assert.equal(posts, 1);
    await f.submit();
    await f.page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("投稿已提交"),
    );
    assert.equal(posts, 2);
  } finally {
    await f.close();
  }
});
test("reader commit review: committed removal survives failed read and read-only retry", async () => {
  const f = await readerCommitFixture();
  let failing = false,
    posts = 0;
  try {
    await f.page.route("**/api/me/favorites?*", (route) =>
      route.fulfill(
        failing
          ? { status: 503, json: { error: "Fixture list failed" } }
          : { json: readerFavorites("zh") },
      ),
    );
    await f.page.route("**/api/me/favorites", async (route) => {
      posts++;
      failing = true;
      await route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.page.locator(".remove").click();
    await f.page.locator("#retry-personal").waitFor();
    assert.match(
      await f.page.locator("#message").innerText(),
      /已取消收藏.*列表刷新失败/,
    );
    failing = false;
    await f.page.locator("#retry-personal").click();
    await f.page.getByRole("link", { name: "中文收藏", exact: true }).waitFor();
    assert.equal(posts, 1);
    assert.equal(await f.page.locator("#message").innerText(), "已取消收藏。");
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
  } finally {
    await f.close();
  }
});
test("reader commit review: old submission failure cannot replace a later removal confirmation", async () => {
  const f = await readerCommitFixture(),
    post = readerGate();
  try {
    await f.page.route("**/api/me/submissions", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ json: [] });
      post.enter();
      await post.held;
      await route.fulfill({
        status: 503,
        json: { error: "Old submission failed" },
      });
    });
    await f.page.route("**/api/me/favorites", (route) =>
      route.fulfill({ json: { ok: true } }),
    );
    await f.open();
    await f.submit();
    await post.started;
    await f.page.locator(".remove").click();
    await f.page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "已取消收藏。",
    );
    post.release();
    await f.page.waitForFunction(
      () =>
        !(document.querySelector("#submission button") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(await f.page.locator("#message").innerText(), "已取消收藏。");
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
  } finally {
    post.release();
    await f.close();
  }
});
test("reader commit review: old removal failure cannot replace a later submission confirmation", async () => {
  const f = await readerCommitFixture(),
    post = readerGate();
  try {
    await f.page.route("**/api/me/favorites", async (route) => {
      post.enter();
      await post.held;
      await route.fulfill({
        status: 503,
        json: { error: "Old removal failed" },
      });
    });
    await f.page.route("**/api/me/submissions", (route) =>
      route.fulfill(
        route.request().method() === "GET"
          ? { json: [] }
          : { status: 201, json: { id: "fixture", status: "pending" } },
      ),
    );
    await f.open();
    await f.page.locator(".remove").click();
    await post.started;
    await f.submit();
    await f.page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("投稿已提交"),
    );
    const finished = f.page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith("/api/me/favorites"),
    );
    post.release();
    await (await finished).finished();
    await readerFrame(f.page);
    assert.match(await f.page.locator("#message").innerText(), /投稿已提交/);
    assert.doesNotMatch(
      await f.page.locator("#message").innerText(),
      /Old removal failed/,
    );
  } finally {
    post.release();
    await f.close();
  }
});
for (const status of [200, 503]) {
  test(`reader commit review: older ${status} refresh cannot replace a newer submission failure`, async () => {
    const f = await readerCommitFixture(),
      read = readerGate();
    let refreshing = false;
    try {
      await f.page.route("**/api/me/favorites?*", async (route) => {
        if (!refreshing) return route.fulfill({ json: readerFavorites("zh") });
        read.enter();
        await read.held;
        await route.fulfill({
          status,
          json:
            status === 200
              ? readerFavorites("zh")
              : { error: "Old list failure" },
        });
      });
      await f.page.route("**/api/me/favorites", async (route) => {
        refreshing = true;
        await route.fulfill({ json: { ok: true } });
      });
      await f.page.route("**/api/me/submissions", (route) =>
        route.fulfill(
          route.request().method() === "GET"
            ? { json: [] }
            : { status: 503, json: { error: "New submission rejected" } },
        ),
      );
      await f.open();
      await f.page.locator(".remove").click();
      await read.started;
      await f.submit();
      await f.page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent ===
          "New submission rejected",
      );
      const finished = f.page.waitForResponse((r) =>
        r.url().includes("favorites?locale=zh"),
      );
      read.release();
      await (await finished).finished();
      await readerFrame(f.page);
      assert.equal(
        await f.page.locator("#message").innerText(),
        "New submission rejected",
      );
      assert.equal(
        await f.page.locator("#title").inputValue(),
        "Committed reader suggestion",
      );
    } finally {
      read.release();
      await f.close();
    }
  });
}

async function seedSubmissionHistory(
  site: string,
  userId: string,
  count: number,
) {
  return (
    await pool.query(
      `INSERT INTO submission(site_id,space_id,user_id,data,created_at)
     SELECT $1,(SELECT space_id FROM identity_site WHERE site_id=$1),$2,$3,'2026-01-01T00:00:00Z'::timestamptz FROM generate_series(1,$4::int) RETURNING id`,
      [site, userId, personalSubmission, count],
    )
  ).rows
    .map((r) => r.id as string)
    .sort();
}
test("submission history review: stable pages cover tied timestamps without mixing sites or users", async () => {
  const visitor = await personalReviewVisitor(),
    other = await personalReviewVisitor();
  const expected = await seedSubmissionHistory("atlas", visitor.user_id, 103);
  await seedSubmissionHistory("atlas", other.user_id, 2);
  await pool.query(
    "INSERT INTO identity_member(site_id,space_id,user_id) VALUES('notes','atlas',$1)",
    [visitor.user_id],
  );
  await seedSubmissionHistory("notes", visitor.user_id, 2);
  const first = await app.personal.submissions("atlas", visitor);
  const second = await app.personal.submissions("atlas", visitor, 2);
  assert.deepEqual(
    first.map((r) => r.id),
    expected.slice(0, 100),
  );
  assert.deepEqual(
    second.map((r) => r.id),
    expected.slice(100),
  );
  assert.equal((await app.personal.submissions("atlas", visitor, 3)).length, 0);
  assert.deepEqual(
    (await app.personal.submissions("atlas", visitor, 2)).map((r) => r.id),
    second.map((r) => r.id),
  );
});
test("submission history review: real HTTP preserves array compatibility and validates scoped pages", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  const email = "history-" + randomUUID() + "@example.test";
  try {
    const signup = await context.request.post(
      origins[2] + "/api/auth/sign-up/email",
      {
        data: { name: "History reader", email, password },
        headers: { origin: origins[2] },
      },
    );
    assert.equal(signup.status(), 200);
    const user = (
      await pool.query(
        "SELECT id FROM identity_user WHERE email=$1 AND space_id='library'",
        [email],
      )
    ).rows[0].id;
    const ids = await seedSubmissionHistory("library", user, 103);
    const first = await context.request.get(origins[2] + "/api/me/submissions");
    assert.equal(first.status(), 200);
    assert.equal((await first.json()).length, 100);
    const second = await context.request.get(
      origins[2] + "/api/me/submissions?page=2&user_id=ignored&site_id=atlas",
    );
    assert.equal(second.status(), 200);
    assert.deepEqual(
      (await second.json()).map((r: { id: string }) => r.id),
      ids.slice(100),
    );
    for (const value of ["0", "1.5", "100001", "oops"])
      assert.equal(
        (
          await context.request.get(
            origins[2] + "/api/me/submissions?page=" + value,
          )
        ).status(),
        400,
      );
    assert.deepEqual(
      await (
        await context.request.get(
          origins[2] + "/api/me/submissions?page=100000",
        )
      ).json(),
      [],
    );
    assert.equal(
      (
        await context.request.get(origins[0] + "/api/me/submissions?page=2")
      ).status(),
      401,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});
function historyRows(count: number, prefix = "History") {
  return Array.from({ length: count }, (_, i) => ({
    id: `history-${i}`,
    data: { title: `${prefix} ${i + 1}` },
    status: "pending",
    note: "",
  }));
}
async function submissionHistoryFixture(lastCount = 1) {
  const f = await readerCommitFixture(),
    requested: number[] = [];
  await f.page.route("**/api/me/submissions*", (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({
        status: 201,
        json: { id: "created", status: "pending" },
      });
    const page = Number(
      new URL(route.request().url()).searchParams.get("page") ?? 1,
    );
    requested.push(page);
    return route.fulfill({
      json: page === 1 ? historyRows(100) : historyRows(lastCount, "Older"),
    });
  });
  await f.page.route("**/api/me/favorites?*", (route) => {
    const query = new URL(route.request().url()).searchParams,
      page = Number(query.get("page") ?? 1);
    const data = readerFavorites(query.get("locale") ?? "zh");
    data.total = 25;
    data.page = page;
    if (page === 2) data.items[0].title = "Favorite page two";
    return route.fulfill({ json: data });
  });
  return { ...f, requested };
}
test("submission history review: submission pages preserve favorite page and form edits", async () => {
  const f = await submissionHistoryFixture();
  try {
    await f.open();
    await f.page.locator("#next-favorites").click();
    await f.page
      .getByRole("link", { name: "Favorite page two", exact: true })
      .waitFor();
    await f.page.locator("#next-submissions").click();
    await f.page
      .locator("#submissions strong")
      .filter({ hasText: "Older 1" })
      .waitFor();
    assert.equal(await f.page.locator("#prev-favorites").count(), 1);
    assert.equal(await f.page.locator("#submissions article").count(), 1);
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
    await f.page.locator("#personal-locale").selectOption("en");
    await f.page
      .getByRole("link", { name: "English favorite", exact: true })
      .waitFor();
    assert.equal(
      await f.page.locator("#submissions strong").innerText(),
      "Older 1",
    );
    assert.equal(f.requested.at(-1), 2);
    await f.page.locator("#prev-submissions").click();
    await f.page.locator("#next-submissions").waitFor();
    assert.equal(await f.page.locator("#submissions article").count(), 100);
  } finally {
    await f.close();
  }
});
test("submission history review: full final page can recover from an empty next page", async () => {
  const f = await submissionHistoryFixture(0);
  try {
    await f.open();
    await f.page.locator("#next-submissions").click();
    await f.page.locator("#prev-submissions").waitFor();
    assert.match(
      await f.page.locator("#submissions").innerText(),
      /本页暂无投稿/,
    );
    assert.equal(await f.page.locator("#next-submissions").count(), 0);
    await f.page.locator("#prev-submissions").click();
    await f.page.locator("#next-submissions").waitFor();
    assert.equal(await f.page.locator("#submissions article").count(), 100);
  } finally {
    await f.close();
  }
});
for (const status of [200, 503]) {
  test(`submission history review: repeated old controls and stale ${status} page cannot replace newer load`, async () => {
    const f = await submissionHistoryFixture(),
      read = readerGate();
    let calls = 0;
    try {
      await f.page.route("**/api/me/submissions?page=2", async (route) => {
        calls++;
        f.requested.push(2);
        if (calls === 1) {
          read.enter();
          await read.held;
          return route.fulfill({
            status,
            json:
              status === 200
                ? historyRows(1, "Obsolete")
                : { error: "Obsolete history error" },
          });
        }
        return route.fulfill({ json: historyRows(1, "Fresh") });
      });
      await f.open();
      await f.page
        .locator("#next-submissions")
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      await read.started;
      assert.equal(calls, 1);
      await f.page.locator("#personal-locale").selectOption("en");
      await f.page
        .locator("#submissions strong")
        .filter({ hasText: "Fresh 1" })
        .waitFor();
      const finished = f.page.waitForResponse((r) =>
        r.url().endsWith("/api/me/submissions?page=2"),
      );
      read.release();
      await (await finished).finished();
      await readerFrame(f.page);
      assert.equal(
        await f.page.locator("#submissions strong").innerText(),
        "Fresh 1",
      );
      assert.equal(await f.page.locator("#message").innerText(), "");
      assert.equal(calls, 2);
      assert.equal(
        await f.page.locator("#title").inputValue(),
        "Committed reader suggestion",
      );
    } finally {
      read.release();
      await f.close();
    }
  });
}
test("submission history review: confirmed submission returns history to first page and preserves favorite page and new edits", async () => {
  const f = await submissionHistoryFixture(),
    post = readerGate();
  try {
    await f.page.route("**/api/me/submissions", async (route) => {
      if (route.request().method() === "GET") return route.fallback();
      post.enter();
      await post.held;
      await route.fulfill({
        status: 201,
        json: { id: "created", status: "pending" },
      });
    });
    await f.open();
    await f.page.locator("#next-favorites").click();
    await f.page
      .getByRole("link", { name: "Favorite page two", exact: true })
      .waitFor();
    await f.page.locator("#next-submissions").click();
    await f.page.locator("#prev-submissions").waitFor();
    await f.submit();
    await post.started;
    await f.page.locator("#title").fill("Unsent after history submission");
    post.release();
    await f.page.waitForFunction(
      () =>
        !(document.querySelector("#submission button") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(f.requested.at(-1), 1);
    assert.equal(await f.page.locator("#submissions article").count(), 100);
    assert.equal(await f.page.locator("#prev-favorites").count(), 1);
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Unsent after history submission",
    );
    assert.match(
      await f.page.locator("#message").innerText(),
      /当前编辑尚未提交/,
    );
  } finally {
    post.release();
    await f.close();
  }
});
test("submission history review: failed second page retries only reads and keeps inputs", async () => {
  const f = await submissionHistoryFixture();
  let calls = 0,
    posts = 0;
  try {
    f.page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/me/"))
        posts++;
    });
    await f.page.route("**/api/me/submissions?page=2", (route) => {
      calls++;
      return route.fulfill(
        calls === 1
          ? { status: 503, json: { error: "History unavailable" } }
          : { json: historyRows(1, "Recovered") },
      );
    });
    await f.open();
    await f.page.locator("#next-submissions").click();
    await f.page.locator("#retry-personal").waitFor();
    await f.page.locator("#retry-personal").click();
    await f.page
      .locator("#submissions strong")
      .filter({ hasText: "Recovered 1" })
      .waitFor();
    assert.equal(calls, 2);
    assert.equal(posts, 0);
    assert.equal(await f.page.locator("#prev-submissions").count(), 1);
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
  } finally {
    await f.close();
  }
});

test("favorite redraw review: pending removal remains blocked across language redraw and unlocks after failure", async () => {
  const f = await readerCommitFixture(),
    post = readerGate();
  let posts = 0;
  try {
    await f.page.route("**/api/me/favorites", async (route) => {
      posts++;
      post.enter();
      await post.held;
      await route.fulfill({ status: 503, json: { error: "Removal rejected" } });
    });
    await f.open();
    await f.page.locator(".remove").click();
    await post.started;
    await f.page.locator("#personal-locale").selectOption("en");
    await f.page
      .getByRole("link", { name: "English favorite", exact: true })
      .waitFor();
    assert.equal(await f.page.locator(".remove").isDisabled(), true);
    await f.page
      .locator(".remove")
      .evaluate((button) =>
        button.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
    await readerFrame(f.page);
    assert.equal(posts, 1);
    post.release();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "Removal rejected",
    );
    assert.equal(await f.page.locator(".remove").isDisabled(), false);
  } finally {
    post.release();
    await f.close();
  }
});
for (const remaining of [24, 0]) {
  test(`favorite redraw review: deleting last page returns to page one when ${remaining} favorites remain`, async () => {
    const f = await submissionHistoryFixture();
    let removed = false,
      posts = 0;
    const pages: number[] = [];
    try {
      await f.page.route("**/api/me/favorites?*", (route) => {
        const page = Number(
          new URL(route.request().url()).searchParams.get("page") ?? 1,
        );
        pages.push(page);
        const data = readerFavorites("zh");
        data.page = page;
        data.total = removed ? remaining : 25;
        if (page === 2) {
          data.items[0].title = "Favorite page two";
          if (removed) data.items = [];
        } else if (removed) {
          if (remaining === 0) data.items = [];
          else {
            data.items[0].title = "Restored first page";
            data.items[0].resource_id = "remaining-item";
          }
        }
        return route.fulfill({ json: data });
      });
      await f.page.route("**/api/me/favorites", async (route) => {
        posts++;
        removed = true;
        await route.fulfill({ json: { ok: true } });
      });
      await f.open();
      await f.page.locator("#next-favorites").click();
      await f.page
        .getByRole("link", { name: "Favorite page two", exact: true })
        .waitFor();
      await f.page.locator("#next-submissions").click();
      await f.page.locator("#prev-submissions").waitFor();
      await f.page.locator(".remove").click();
      if (remaining)
        await f.page
          .getByRole("link", { name: "Restored first page", exact: true })
          .waitFor();
      else
        await f.page.waitForFunction(() =>
          document
            .querySelector("#favorites")
            ?.textContent?.includes("当前语言还没有可见收藏"),
        );
      assert.equal(await f.page.locator("#prev-favorites").count(), 0);
      assert.equal(pages.at(-1), 1);
      assert.equal(posts, 1);
      assert.equal(await f.page.locator("#prev-submissions").count(), 1);
      assert.equal(
        await f.page.locator("#submissions strong").innerText(),
        "Older 1",
      );
      assert.equal(
        await f.page.locator("#title").inputValue(),
        "Committed reader suggestion",
      );
      assert.match(await f.page.locator("#message").innerText(), /已取消收藏/);
    } finally {
      await f.close();
    }
  });
}

test("favorite redraw review: automatic page correction cannot clear a newer submission error", async () => {
  const f = await submissionHistoryFixture(),
    read = readerGate();
  let removed = false;
  try {
    await f.page.route("**/api/me/favorites?*", async (route) => {
      const page = Number(
        new URL(route.request().url()).searchParams.get("page") ?? 1,
      );
      const data = readerFavorites("zh");
      data.total = removed ? 24 : 25;
      data.page = page;
      if (page === 2) {
        if (removed) {
          read.enter();
          await read.held;
          data.items = [];
        } else data.items[0].title = "Favorite page two";
      } else if (removed) data.items[0].title = "Corrected page one";
      await route.fulfill({ json: data });
    });
    await f.page.route("**/api/me/favorites", async (route) => {
      removed = true;
      await route.fulfill({ json: { ok: true } });
    });
    await f.page.route("**/api/me/submissions", (route) =>
      route.request().method() === "GET"
        ? route.fallback()
        : route.fulfill({
            status: 503,
            json: { error: "New suggestion rejected" },
          }),
    );
    await f.open();
    await f.page.locator("#next-favorites").click();
    await f.page
      .getByRole("link", { name: "Favorite page two", exact: true })
      .waitFor();
    await f.page.locator(".remove").click();
    await read.started;
    await f.submit();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "New suggestion rejected",
    );
    read.release();
    await f.page
      .getByRole("link", { name: "Corrected page one", exact: true })
      .waitFor();
    await readerFrame(f.page);
    assert.equal(
      await f.page.locator("#message").innerText(),
      "New suggestion rejected",
    );
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
  } finally {
    read.release();
    await f.close();
  }
});

test("favorite redraw review: independent removals keep separate locks after redraw", async () => {
  const f = await readerCommitFixture(),
    first = readerGate(),
    second = readerGate();
  let posts = 0;
  try {
    await f.page.route("**/api/me/favorites?*", (route) => {
      const data = readerFavorites(
        new URL(route.request().url()).searchParams.get("locale") ?? "zh",
      );
      data.items[0].resource_id = "reader-a";
      data.items.push({
        ...data.items[0],
        resource_id: "reader-b",
        slug: "reader-b",
        title: "Other favorite",
      });
      data.total = 2;
      return route.fulfill({ json: data });
    });
    await f.page.route("**/api/me/favorites", async (route) => {
      posts++;
      const a = route.request().postDataJSON().resourceId === "reader-a",
        gate = a ? first : second;
      gate.enter();
      await gate.held;
      await route.fulfill({
        status: 503,
        json: {
          error: a ? "First removal rejected" : "Second removal rejected",
        },
      });
    });
    await f.open();
    await f.page.locator('.remove[data-id="reader-a"]').click();
    await first.started;
    await f.page.locator('.remove[data-id="reader-b"]').click();
    await second.started;
    assert.equal(posts, 2);
    await f.page.locator("#personal-locale").selectOption("en");
    await f.page
      .getByRole("link", { name: "English favorite", exact: true })
      .waitFor();
    assert.equal(
      await f.page.locator('.remove[data-id="reader-a"]').isDisabled(),
      true,
    );
    assert.equal(
      await f.page.locator('.remove[data-id="reader-b"]').isDisabled(),
      true,
    );
    first.release();
    await f.page.waitForFunction(
      () =>
        !(
          document.querySelector(
            '.remove[data-id="reader-a"]',
          ) as HTMLButtonElement
        ).disabled,
    );
    assert.equal(
      await f.page.locator('.remove[data-id="reader-b"]').isDisabled(),
      true,
    );
    second.release();
    await f.page.waitForFunction(
      () =>
        !(
          document.querySelector(
            '.remove[data-id="reader-b"]',
          ) as HTMLButtonElement
        ).disabled,
    );
    assert.equal(posts, 2);
  } finally {
    first.release();
    second.release();
    await f.close();
  }
});
test("favorite redraw review: pending removal survives submission pagination and unlocks after acknowledgement", async () => {
  const f = await submissionHistoryFixture(),
    post = readerGate();
  let posts = 0;
  try {
    await f.page.route("**/api/me/favorites", async (route) => {
      posts++;
      post.enter();
      await post.held;
      await route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.page.locator(".remove").click();
    await post.started;
    await f.page.locator("#next-submissions").click();
    await f.page.locator("#prev-submissions").waitFor();
    assert.equal(await f.page.locator(".remove").isDisabled(), true);
    post.release();
    await f.page.waitForFunction(() => {
      const b = document.querySelector(".remove") as HTMLButtonElement | null;
      return b && !b.disabled;
    });
    assert.equal(posts, 1);
    assert.equal(await f.page.locator("#prev-submissions").count(), 1);
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
  } finally {
    post.release();
    await f.close();
  }
});
test("favorite redraw review: obsolete empty page cannot correct a newer language selection", async () => {
  const f = await submissionHistoryFixture(),
    read = readerGate();
  let removed = false,
    englishReads = 0;
  try {
    await f.page.route("**/api/me/favorites?*", async (route) => {
      const query = new URL(route.request().url()).searchParams,
        locale = query.get("locale")!,
        page = Number(query.get("page") ?? 1);
      const data = readerFavorites(locale);
      data.page = page;
      if (locale === "en") englishReads++;
      else {
        data.total = 25;
        if (page === 2) {
          data.items[0].title = "Favorite page two";
          if (removed) {
            read.enter();
            await read.held;
            data.total = 0;
            data.items = [];
          }
        }
      }
      await route.fulfill({ json: data });
    });
    await f.page.route("**/api/me/favorites", async (route) => {
      removed = true;
      await route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.page.locator("#next-favorites").click();
    await f.page
      .getByRole("link", { name: "Favorite page two", exact: true })
      .waitFor();
    await f.page.locator(".remove").click();
    await read.started;
    await f.page.locator("#personal-locale").selectOption("en");
    await f.page
      .getByRole("link", { name: "English favorite", exact: true })
      .waitFor();
    const finished = f.page.waitForResponse((r) =>
      r.url().includes("favorites?locale=zh&page=2"),
    );
    read.release();
    await (await finished).finished();
    await readerFrame(f.page);
    assert.equal(englishReads, 1);
    assert.equal(
      await f.page
        .getByRole("link", { name: "English favorite", exact: true })
        .count(),
      1,
    );
    assert.equal(await f.page.locator("#prev-favorites").count(), 0);
  } finally {
    read.release();
    await f.close();
  }
});

for (const status of [200, 503])
  test(`reader signout review: pending ${status} signout blocks repeated events`, async () => {
    const f = await readerCommitFixture(),
      post = readerGate();
    let posts = 0,
      landings = 0;
    try {
      await f.page.route("**/api/session", (route) =>
        route.fulfill({ json: { id: "reader" } }),
      );
      await f.page.route(origins[0] + "/", (route) => {
        landings++;
        return route.fulfill({
          contentType: "text/html",
          body: "<p>Signed out</p>",
        });
      });
      await f.page.route("**/api/auth/sign-out", async (route) => {
        posts++;
        assert.equal(route.request().method(), "POST");
        post.enter();
        await post.held;
        await route.fulfill({
          status,
          json:
            status === 200
              ? { success: true }
              : { error: "Signout unavailable" },
        });
      });
      await f.open();
      const button = f.page.getByRole("button", {
        name: "退出本站",
        exact: true,
      });
      await button.click();
      await post.started;
      // Dispatching bypasses native disabled-click filtering: the handler must also guard.
      await button.evaluate((b) => {
        b.dispatchEvent(new MouseEvent("click"));
        b.dispatchEvent(new MouseEvent("click"));
      });
      await readerFrame(f.page);
      assert.equal(await button.isDisabled(), true);
      assert.equal(posts, 1);
      post.release();
      if (status === 200) {
        await f.page.waitForURL(origins[0] + "/");
        assert.equal(landings, 1);
      } else {
        await f.page.waitForFunction(
          () =>
            document.querySelector("#message")?.textContent ===
            "Signout unavailable",
        );
        assert.equal(await button.isEnabled(), true);
        assert.equal(landings, 0);
        assert.equal(
          await f.page.locator("#title").inputValue(),
          "Committed reader suggestion",
        );
      }
      assert.equal(posts, 1);
    } finally {
      post.release();
      await f.close();
    }
  });

test("reader signout review: authentication message survives failure and retry succeeds", async () => {
  const f = await readerCommitFixture();
  let posts = 0;
  try {
    await f.page.route("**/api/session", (route) =>
      route.fulfill({ json: { id: "reader" } }),
    );
    await f.page.route(origins[0] + "/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Signed out</p>" }),
    );
    await f.page.route("**/api/auth/sign-out", (route) => {
      posts++;
      return route.fulfill({
        status: posts === 1 ? 503 : 200,
        json:
          posts === 1
            ? { code: "SERVICE_UNAVAILABLE", message: "退出暂不可用，请重试" }
            : { success: true },
      });
    });
    await f.open();
    const button = f.page.getByRole("button", {
      name: "退出本站",
      exact: true,
    });
    await button.click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "退出暂不可用，请重试",
    );
    assert.equal(await button.isEnabled(), true);
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
    await button.click();
    await f.page.waitForURL(origins[0] + "/");
    assert.equal(posts, 2);
  } finally {
    await f.close();
  }
});

async function catalogActionFixture() {
  const f = await readerReviewBrowser();
  const items = ["first", "second"].map((id) => ({
    resource_id: id,
    slug: id,
    title: id,
    description: id,
    url: "https://example.com/" + id,
    locale: "zh",
    seo_title: "",
    seo_description: "",
  }));
  await f.page.route("**/zh/tools", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: directoryPage(
        { name: "Catalog actions", locales: ["zh"] },
        origins[0],
        "tools",
        "zh",
        { items, total: 2, page: 1, limit: 24 },
        [],
        { q: "" },
      ),
    }),
  );
  await f.page.route("**/api/session", (route) =>
    route.fulfill({ json: { id: "reader" } }),
  );
  return {
    ...f,
    open: async () => {
      await f.page.goto(origins[0] + "/zh/tools");
      await f.page
        .getByRole("button", { name: "退出本站", exact: true })
        .waitFor();
    },
  };
}

test("catalog action review: duplicate favorite events are blocked and rejection allows retry", async () => {
  const f = await catalogActionFixture(),
    post = readerGate();
  let posts = 0;
  try {
    await f.page.route("**/api/me/favorites", async (route) => {
      posts++;
      assert.deepEqual(route.request().postDataJSON(), {
        resourceId: "first",
        enabled: true,
      });
      if (posts === 1) {
        post.enter();
        await post.held;
        return route.fulfill({
          status: 503,
          json: { error: "Retry favorite" },
        });
      }
      return route.fulfill({ json: { ok: true } });
    });
    await f.open();
    const button = f.page.locator('.favorite[data-id="first"]');
    await button.click();
    await post.started;
    await button.evaluate((b) => {
      b.dispatchEvent(new MouseEvent("click"));
      b.dispatchEvent(new MouseEvent("click"));
    });
    await readerFrame(f.page);
    assert.equal(posts, 1);
    assert.equal(await button.isDisabled(), true);
    post.release();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "Retry favorite",
    );
    assert.equal(await button.isEnabled(), true);
    await button.click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "已加入本站收藏。",
    );
    assert.equal(posts, 2);
  } finally {
    post.release();
    await f.close();
  }
});

for (const oldStatus of [200, 503])
  test(`catalog action review: late favorite ${oldStatus} cannot replace the newer resource result`, async () => {
    const f = await catalogActionFixture(),
      post = readerGate();
    const newer =
      oldStatus === 200 ? "Newer favorite failed" : "已加入本站收藏。";
    try {
      await f.page.route("**/api/me/favorites", async (route) => {
        if (route.request().postDataJSON().resourceId === "first") {
          post.enter();
          await post.held;
          return route.fulfill({
            status: oldStatus,
            json:
              oldStatus === 200
                ? { ok: true }
                : { error: "Older favorite failed" },
          });
        }
        return route.fulfill({
          status: oldStatus === 200 ? 503 : 200,
          json: oldStatus === 200 ? { error: newer } : { ok: true },
        });
      });
      await f.open();
      const first = f.page.locator('.favorite[data-id="first"]'),
        second = f.page.locator('.favorite[data-id="second"]');
      await first.click();
      await post.started;
      await second.click();
      await f.page.waitForFunction(
        (text) => document.querySelector("#message")?.textContent === text,
        newer,
      );
      assert.equal(await first.isDisabled(), true);
      assert.equal(await second.isEnabled(), true);
      post.release();
      await f.page.waitForFunction(
        () =>
          !(
            document.querySelector(
              '.favorite[data-id="first"]',
            ) as HTMLButtonElement
          ).disabled,
      );
      assert.equal(await f.page.locator("#message").innerText(), newer);
    } finally {
      post.release();
      await f.close();
    }
  });

for (const oldStatus of [200, 503])
  test(`catalog action review: late favorite ${oldStatus} preserves a newer signout error`, async () => {
    const f = await catalogActionFixture(),
      post = readerGate();
    try {
      await f.page.route("**/api/me/favorites", async (route) => {
        post.enter();
        await post.held;
        await route.fulfill({
          status: oldStatus,
          json:
            oldStatus === 200 ? { ok: true } : { error: "Old favorite failed" },
        });
      });
      await f.page.route("**/api/auth/sign-out", (route) =>
        route.fulfill({ status: 503, json: { message: "New signout failed" } }),
      );
      await f.open();
      await f.page.locator('.favorite[data-id="first"]').click();
      await post.started;
      await f.page
        .getByRole("button", { name: "退出本站", exact: true })
        .click();
      await f.page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent ===
          "New signout failed",
      );
      post.release();
      await f.page.waitForFunction(
        () =>
          !(
            document.querySelector(
              '.favorite[data-id="first"]',
            ) as HTMLButtonElement
          ).disabled,
      );
      assert.equal(
        await f.page.locator("#message").innerText(),
        "New signout failed",
      );
    } finally {
      post.release();
      await f.close();
    }
  });

test("catalog action review: late signout rejection preserves the newer favorite result", async () => {
  const f = await catalogActionFixture(),
    post = readerGate();
  try {
    await f.page.route("**/api/auth/sign-out", async (route) => {
      post.enter();
      await post.held;
      await route.fulfill({
        status: 503,
        json: { message: "Old signout failed" },
      });
    });
    await f.page.route("**/api/me/favorites", (route) =>
      route.fulfill({ json: { ok: true } }),
    );
    await f.open();
    const button = f.page.getByRole("button", {
      name: "退出本站",
      exact: true,
    });
    await button.click();
    await post.started;
    await f.page.locator('.favorite[data-id="second"]').click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "已加入本站收藏。",
    );
    post.release();
    await f.page.waitForFunction(
      () =>
        !(
          Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent === "退出本站",
          ) as HTMLButtonElement
        ).disabled,
    );
    assert.equal(
      await f.page.locator("#message").innerText(),
      "已加入本站收藏。",
    );
  } finally {
    post.release();
    await f.close();
  }
});

for (const action of ["submission", "removal"])
  test(`catalog action review: old personal ${action} refresh preserves the newer signout failure`, async () => {
    const f = await readerCommitFixture(),
      post = readerGate();
    let reads = 0;
    try {
      await f.page.route("**/api/session", (route) =>
        route.fulfill({ json: { id: "reader" } }),
      );
      await f.page.route("**/api/auth/sign-out", (route) =>
        route.fulfill({
          status: 503,
          json: { message: "Personal signout failed" },
        }),
      );
      await f.page.route("**/api/me/favorites?*", (route) => {
        reads++;
        return route.fulfill({ json: readerFavorites("zh") });
      });
      await f.page.route(
        action === "submission"
          ? "**/api/me/submissions"
          : "**/api/me/favorites",
        async (route) => {
          if (route.request().method() === "GET")
            return route.fulfill({ json: [] });
          post.enter();
          await post.held;
          await route.fulfill({
            json: { id: "created", ok: true, status: "pending" },
          });
        },
      );
      await f.open();
      if (action === "submission") await f.submit();
      else await f.page.locator(".remove").click();
      await post.started;
      await f.page
        .getByRole("button", { name: "退出本站", exact: true })
        .click();
      await f.page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent ===
          "Personal signout failed",
      );
      post.release();
      await f.page.waitForFunction(
        (action) =>
          action === "submission"
            ? !(
                document.querySelector(
                  "#submission button",
                ) as HTMLButtonElement
              ).disabled
            : !!document.querySelector(".remove") &&
              !(document.querySelector(".remove") as HTMLButtonElement)
                .disabled,
        action,
      );
      await readerFrame(f.page);
      assert.equal(reads, 2);
      assert.equal(
        await f.page.locator("#message").innerText(),
        "Personal signout failed",
      );
    } finally {
      post.release();
      await f.close();
    }
  });

const readerResponseMessage = "服务响应格式异常，请重试加载。";
const readerUnconfirmedMessage =
  "未能确认操作结果，请先刷新记录核对，避免重复提交。";

test("reader response review: HTML 401 retains login routing instead of parse failure", async () => {
  const f = await readerReviewBrowser();
  try {
    await f.page.route("**/api/me/favorites?*", (route) =>
      route.fulfill({
        status: 401,
        contentType: "text/html",
        body: "<h1>Session required</h1>",
      }),
    );
    await f.page.goto(origins[0] + "/me");
    await f.page.locator('#favorites a[href="/login"]').waitFor();
    assert.equal(
      await f.page.locator("#message").innerText(),
      "请先登录，再使用收藏与投稿。",
    );
    assert.equal(await f.page.locator("#retry-personal").count(), 0);
  } finally {
    await f.close();
  }
});

for (const failure of ["html503", "null503", "null200"])
  test(`reader response review: ${failure} read has a stable message and read-only recovery`, async () => {
    const f = await readerCommitFixture();
    let failing = true,
      gets = 0,
      posts = 0;
    const expected =
      failure === "null200"
        ? readerResponseMessage
        : "操作失败（HTTP 503），请稍后重试。";
    try {
      await f.page.route("**/api/me/favorites?*", (route) => {
        gets++;
        if (!failing) return route.fulfill({ json: readerFavorites("zh") });
        return route.fulfill(
          failure === "html503"
            ? {
                status: 503,
                contentType: "text/html",
                body: "<h1>Proxy unavailable</h1>",
              }
            : { status: failure === "null200" ? 200 : 503, json: null },
        );
      });
      await f.page.route("**/api/me/favorites", (route) => {
        posts++;
        return route.fulfill({ json: { ok: true } });
      });
      await f.page.goto(origins[0] + "/me");
      await f.page.locator("#retry-personal").waitFor();
      assert.equal(await f.page.locator("#message").innerText(), expected);
      assert.equal(
        await f.page.locator('#favorites a[href="/login"]').count(),
        0,
      );
      await f.page.locator("#title").fill("Preserved response recovery");
      failing = false;
      await f.page.locator("#retry-personal").click();
      await f.page
        .getByRole("link", { name: "中文收藏", exact: true })
        .waitFor();
      assert.equal(
        await f.page.locator("#title").inputValue(),
        "Preserved response recovery",
      );
      assert.equal(await f.page.locator("#message").innerText(), "");
      assert.equal(gets, 2);
      assert.equal(posts, 0);
    } finally {
      await f.close();
    }
  });

test("reader response review: structured error does not hide the textual message", async () => {
  const f = await catalogActionFixture();
  try {
    await f.page.route("**/api/me/favorites", (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "UNAVAILABLE" }, message: "收藏服务暂不可用" },
      }),
    );
    await f.open();
    const button = f.page.locator('.favorite[data-id="first"]');
    await button.click();
    await f.page.waitForFunction(
      () =>
        !(
          document.querySelector(
            '.favorite[data-id="first"]',
          ) as HTMLButtonElement
        ).disabled,
    );
    assert.equal(
      await f.page.locator("#message").innerText(),
      "收藏服务暂不可用",
    );
  } finally {
    await f.close();
  }
});

test("reader response review: unreadable successful submission keeps inputs and never replays on reload", async () => {
  const f = await readerCommitFixture();
  let posts = 0,
    reads = 0;
  try {
    await f.page.route("**/api/me/submissions", (route) => {
      if (route.request().method() === "GET") {
        reads++;
        return route.fulfill({ json: [] });
      }
      posts++;
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: '{"id":',
      });
    });
    await f.open();
    await f.submit();
    await f.page.waitForFunction(
      () =>
        !(document.querySelector("#submission button") as HTMLButtonElement)
          .disabled,
    );
    assert.equal(
      await f.page.locator("#message").innerText(),
      readerUnconfirmedMessage,
    );
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
    assert.equal(
      await f.page.locator("#url").inputValue(),
      "https://example.com/reader-commit",
    );
    assert.equal(
      await f.page.locator("#description").inputValue(),
      "Reader description",
    );
    assert.equal(posts, 1);
    assert.equal(reads, 1);
    await f.page.locator("#personal-locale").selectOption("en");
    await f.page
      .getByRole("link", { name: "English favorite", exact: true })
      .waitFor();
    assert.equal(reads, 2);
    assert.equal(posts, 1);
    assert.equal(
      await f.page.locator("#title").inputValue(),
      "Committed reader suggestion",
    );
  } finally {
    await f.close();
  }
});

test("reader response review: HTML signout error restores retry without navigating", async () => {
  const f = await catalogActionFixture();
  let posts = 0,
    landings = 0;
  try {
    await f.page.route(origins[0] + "/", (route) => {
      landings++;
      return route.fulfill({
        contentType: "text/html",
        body: "<p>Signed out</p>",
      });
    });
    await f.page.route("**/api/auth/sign-out", (route) => {
      posts++;
      return route.fulfill(
        posts === 1
          ? {
              status: 502,
              contentType: "text/html",
              body: "<h1>Bad gateway</h1>",
            }
          : { json: { success: true } },
      );
    });
    await f.open();
    const button = f.page.getByRole("button", {
      name: "退出本站",
      exact: true,
    });
    await button.click();
    await f.page.waitForFunction(
      () =>
        !(
          Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent === "退出本站",
          ) as HTMLButtonElement
        ).disabled,
    );
    assert.equal(
      await f.page.locator("#message").innerText(),
      "操作失败（HTTP 502），请稍后重试。",
    );
    assert.equal(posts, 1);
    assert.equal(landings, 0);
    await button.click();
    await f.page.waitForURL(origins[0] + "/");
    assert.equal(posts, 2);
    assert.equal(landings, 1);
  } finally {
    await f.close();
  }
});

test("reader response review: unreadable successful signout asks to verify login state without replay", async () => {
  const f = await catalogActionFixture();
  let signedOut = false,
    posts = 0;
  try {
    await f.page.route("**/api/session", (route) =>
      route.fulfill({ json: signedOut ? null : { id: "reader" } }),
    );
    await f.page.route("**/api/auth/sign-out", (route) => {
      signedOut = true;
      posts++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"success":',
      });
    });
    await f.open();
    const button = f.page.getByRole("button", {
      name: "退出本站",
      exact: true,
    });
    await button.click();
    await f.page.waitForFunction(
      () =>
        !(
          Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent === "退出本站",
          ) as HTMLButtonElement
        ).disabled,
    );
    assert.equal(
      await f.page.locator("#message").innerText(),
      "未能确认退出结果，请刷新页面核对登录状态。",
    );
    assert.equal(f.page.url(), origins[0] + "/zh/tools");
    assert.equal(posts, 1);
    const sessionRead = f.page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/session",
    );
    await f.page.reload();
    await (await sessionRead).finished();
    await readerFrame(f.page);
    assert.equal(
      await f.page
        .getByRole("button", { name: "退出本站", exact: true })
        .count(),
      0,
    );
    assert.equal(posts, 1);
  } finally {
    await f.close();
  }
});
