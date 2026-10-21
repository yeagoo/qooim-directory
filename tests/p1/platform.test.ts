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
import { chromium } from "@playwright/test";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";
import { Application } from "../../src/server/http.js";
import { AuthRegistry, prefix } from "../../src/server/auth.js";
import { runJobs } from "../../src/server/jobs.js";
import { OutboxWorker } from "../../src/domain/outbox.js";
import { configSchema } from "../../src/domain/config.js";
import type { Operator } from "../../src/server/operators.js";
let pool: Pool,
  app: Application,
  server: ReturnType<typeof createServer>,
  admin: Operator,
  origins: string[],
  key: string;
const password = "P1-test-password-429!";
before(async () => {
  pool = await database();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await Promise.all([migrate(pool), migrate(pool)]);
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
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await app?.close();
  await pool?.end();
});

test("P1 new sites require an independent account space unless legacy is explicit", async () => {
  await assert.rejects(
    app.sites.create(admin, {
      id: "new-shared-rejected",
      name: "Rejected shared",
      origin: "https://new-shared-rejected.example.test",
      centerSite: "atlas",
    }),
    /独立账号空间/,
  );
});

test("P1 migrations are repeatable, reject checksum drift, and rollback a failed upgrade", async () => {
  assert.equal(
    (await pool.query("SELECT count(*) FROM schema_migration")).rows[0].count,
    "8",
  );
  const dir = await mkdtemp(join(tmpdir(), "network-migrations-"));
  try {
    await cp("migrations", dir, { recursive: true });
    await writeFile(
      join(dir, "006-failure.sql"),
      "CREATE TABLE should_rollback(id int); SELECT definitely_missing_function();",
    );
    await assert.rejects(migrate(pool, dir));
    assert.equal(
      (await pool.query("SELECT to_regclass('should_rollback') AS name"))
        .rows[0].name,
      null,
    );
    await rm(join(dir, "006-failure.sql"));
    await writeFile(join(dir, "001-foundation.sql"), "SELECT 1;");
    await assert.rejects(migrate(pool, dir), /checksum/);
    await migrate(pool);
    assert.equal((await app.sites.list(admin)).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1 dynamic auth provisioning isolates plugin tables, retries idempotently and survives registry restart", async () => {
  for (const id of ["atlas", "notes", "library"])
    assert.equal(await app.auth.provision(id), true, id + " provisioning");
  const instances = (
    await pool.query("SELECT * FROM auth_instance ORDER BY id")
  ).rows;
  assert.ok(
    instances.every(
      (i) => i.state === "ready" && !i.sealed_secret.includes("secret"),
    ),
  );
  for (const instance of instances)
    assert.ok(
      (
        await pool.query("SELECT to_regclass($1) AS name", [
          prefix(instance) + "session",
        ])
      ).rows[0].name,
    );
  assert.notEqual(prefix(instances[0]), prefix(instances[2]));
  const restarted = new AuthRegistry(pool, key, process.env.P0_DATABASE_URL!);
  try {
    assert.equal(await restarted.provision("notes"), true);
  } finally {
    await restarted.close();
  }
  assert.equal(
    (
      await pool.query(
        `SELECT count(*) FROM ${prefix(instances[0])}oauth_client`,
      )
    ).rows[0].count,
    "1",
  );
});

test("P1 browser operator workflow publishes, exports, restores and denies cross-site editors", async () => {
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
    await page.locator(".site-card").first().waitFor();
    assert.equal(await page.locator(".site-card").count(), 3);
    await page.goto(origins[3] + "/admin#site/atlas");
    await page.locator("#name").fill("发布后的灵感地图");
    await page.locator("#save").click();
    await page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "草稿已保存。",
    );
    await page.locator("#publish").click();
    await page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "发布成功。",
    );
    const published = await context.request.get(origins[0] + "/api/config");
    assert.equal((await published.json()).config.name, "发布后的灵感地图");
    const exported = await context.request.get(
      origins[3] + "/admin/api/sites/atlas/export",
    );
    assert.equal((await exported.json()).kind, "published");
    await page.locator('.rollback[data-revision="0"]').click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("历史修订已恢复"),
    );
    const popupPromise = page.waitForEvent("popup");
    await page.locator("#preview").click();
    const preview = await popupPromise;
    await preview.waitForLoadState();
    assert.match(
      (await preview.locator("body").textContent()) ?? "",
      /草稿预览/,
    );
    await preview.close();
    await page.locator("summary").click();
    const snapshot = await (
      await context.request.get(origins[3] + "/admin/api/sites/atlas/export")
    ).json();
    await page.locator("#import").setInputFiles({
      name: "wrong.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ ...snapshot, siteId: "notes" })),
    });
    await page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "Wrong target",
    );
    snapshot.config.name = "从文件导入";
    await page.locator("#import").setInputFiles({
      name: "atlas.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(snapshot)),
    });
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.startsWith("已选择文件"),
    );
    assert.equal(await page.locator("#name").inputValue(), "从文件导入");
    await page.locator("#name").fill("导入后继续编辑");
    await page.locator("#replace").check();
    await page.locator("#save").click();
    await page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "草稿已保存。",
    );
    assert.equal(await page.locator("#name").inputValue(), "导入后继续编辑");
    const shot = process.env.P1_SCREENSHOT;
    if (shot) await page.screenshot({ path: shot, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    if (shot)
      await page.screenshot({
        path: shot.replace(".png", "-mobile.png"),
        fullPage: true,
      });
    const viewerId = await app.sites.operators.create(
      "viewer@example.test",
      password,
    );
    await app.sites.operators.grant(admin, viewerId, "atlas", "viewer");
    const viewerToken = await app.sites.operators.login(
      "viewer@example.test",
      password,
    );
    const headers = {
      cookie: "network_operator=" + viewerToken,
      origin: origins[3],
      "content-type": "application/json",
    };
    const call = (path: string, body?: unknown) =>
      app.respond(
        new Request(origins[3] + "/admin/api" + path, {
          headers: { ...headers, host: new URL(origins[3]).host },
          method: body ? "POST" : "GET",
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    assert.equal((await call("/sites/notes")).status, 403);
    assert.equal(
      (await call("/sites/atlas/status", { active: false })).status,
      403,
    );
    await app.sites.operators.grant(admin, viewerId, "atlas", "editor");
    assert.equal(
      (await call("/sites/atlas/status", { active: true })).status,
      200,
    );
    await pool.query("DELETE FROM operator_grant WHERE user_id=$1", [viewerId]);
    assert.equal((await call("/sites/atlas")).status, 403);
    assert.ok(
      (await pool.query("SELECT count(*)::int AS n FROM audit_event")).rows[0]
        .n >= 6,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P1 shared and independent public accounts use persistent identity across app restart", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto(origins[1] + "/login");
    await page.locator("button").click();
    await page.waitForURL(origins[0] + "/login?**");
    await page.locator("#email").fill("reader@example.test");
    await page.locator("#password").fill(password);
    await page.locator("#register").click();
    await page.waitForURL(origins[1] + "/");
    const first = await (
      await context.request.get(origins[1] + "/api/session")
    ).json();
    assert.equal(first?.email, "reader@example.test");
    const center = await (
      await context.request.get(origins[0] + "/api/session")
    ).json();
    assert.equal(first.email, center.email);
    const sessionUser = async (site: string) =>
      (
        await pool.query(
          `SELECT ss.user_id FROM identity_session ss
           JOIN identity_user u ON u.id=ss.user_id AND u.space_id=ss.space_id
           WHERE ss.site_id=$1 AND u.email=$2 AND NOT ss.revoked AND ss.expires_at>now()
           ORDER BY ss.id DESC LIMIT 1`,
          [site, "reader@example.test"],
        )
      ).rows[0]?.user_id;
    const sharedUser = await sessionUser("notes");
    assert.ok(sharedUser);
    const old = app;
    app = new Application(pool, old.config);
    await old.close();
    assert.equal(
      (await (await context.request.get(origins[1] + "/api/session")).json())
        .email,
      "reader@example.test",
    );
    assert.equal(await sessionUser("notes"), sharedUser);
    await page.goto(origins[2] + "/login");
    await page.locator("#email").fill("reader@example.test");
    await page.locator("#password").fill(password);
    await page.locator("#register").click();
    await page.waitForURL(origins[2] + "/");
    assert.equal(
      (await (await context.request.get(origins[2] + "/api/session")).json())
        .email,
      "reader@example.test",
    );
    assert.notEqual(await sessionUser("library"), sharedUser);
    await context.request.post(origins[0] + "/api/auth/sign-out", {
      headers: { origin: origins[0] },
      data: {},
    });
    assert.equal(
      await (await context.request.get(origins[1] + "/api/session")).json(),
      null,
    );
    assert.ok(
      await (await context.request.get(origins[2] + "/api/session")).json(),
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P1 configuration service rejects stale imports and idempotently publishes with worker recovery", async () => {
  const snapshot = await app.sites.export(admin, "library");
  snapshot.config = configSchema.parse({
    ...snapshot.config,
    name: "CLI-like import",
  });
  await app.sites.preview(admin, "library", snapshot);
  await app.sites.save(admin, "library", snapshot, {
    revision: 0,
    draftVersion: 0,
  });
  await assert.rejects(
    app.sites.save(
      admin,
      "library",
      snapshot,
      { revision: 0, draftVersion: 0 },
      true,
    ),
  );
  const operation = randomUUID();
  assert.equal(
    await app.sites.publish(
      admin,
      "library",
      { revision: 0, draftVersion: 1 },
      operation,
    ),
    1,
  );
  assert.equal(
    await app.sites.publish(
      admin,
      "library",
      { revision: 0, draftVersion: 1 },
      operation,
    ),
    1,
  );
  await runJobs(pool, app.auth);
  assert.equal(
    (
      await pool.query(
        "SELECT revision FROM config_delivery WHERE site_id='library'",
      )
    ).rows[0].revision,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM outbox WHERE status!='done'"))
      .rows[0].count,
    "0",
  );
});

test("P1 hostile Host, Origin and payloads fail closed; stopped site disappears immediately", async () => {
  const token = await app.sites.operators.login(admin.email, password);
  const make = (host: string, path: string, origin?: string, body?: string) =>
    app.respond(
      new Request("https://" + host + path, {
        method: body ? "POST" : "GET",
        headers: {
          host,
          cookie: "network_operator=" + token,
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
          "x-forwarded-host": new URL(origins[3]).host,
        },
        ...(body ? { body } : {}),
      }),
    );
  assert.equal((await make("unknown.test", "/admin/api/sites")).status, 404);
  assert.equal(
    (await make(new URL(origins[0]).host, "/admin/api/sites")).status,
    404,
  );
  assert.equal(
    (
      await make(
        new URL(origins[3]).host,
        "/admin/api/sites",
        "https://evil.test",
        "{}",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await make(
        new URL(origins[3]).host,
        "/admin/api/sites",
        origins[3],
        JSON.stringify({ x: "x".repeat(270000) }),
      )
    ).status,
    413,
  );
  await app.sites.status(admin, "library", false);
  assert.equal((await make(new URL(origins[2]).host, "/")).status, 404);
  await app.sites.status(admin, "library", true);
});

test("P1 production Next route serves platform pages on registered hosts", async () => {
  const child = fork(
    new URL("../../p0/internal/next-server.ts", import.meta.url),
    {
      env: {
        ...process.env,
        P0_NEXT_TEST: "false",
        DATABASE_URL: process.env.P0_DATABASE_URL,
        ADMIN_ORIGIN: origins[3],
        AUTH_ENCRYPTION_KEY: key,
      },
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  try {
    const [message] = await once(child, "message");
    const get = (host: string, path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port: message.port,
            path,
            headers: { host },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode!, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    const login = await get(new URL(origins[3]).host, "/admin/login");
    assert.equal(login.status, 200);
    assert.match(login.body, /登录工作台/);
    assert.equal((await get(new URL(origins[0]).host, "/")).status, 200);
    assert.equal((await get("unknown.test", "/")).status, 404);
  } finally {
    const done = once(child, "exit");
    child.kill();
    await done;
  }
});

test("P1 interrupted schema provisioning resumes; final abandoned attempt is diagnosed and can be requeued", async () => {
  const library = await app.auth.instance("library");
  const encrypted = library.sealed_secret;
  await pool.query(`DROP TABLE ${prefix(library)}verification`);
  await pool.query(
    "UPDATE auth_instance SET state='failed',attempts=1 WHERE site_id='library'",
  );
  assert.equal(await app.auth.provision("library"), true);
  assert.equal((await app.auth.instance("library")).sealed_secret, encrypted);
  await assert.rejects(
    app.sites.create(admin, {
      id: "bad-admin-alias",
      name: "Invalid",
      origin: new URL(origins[3]).origin.replace(/:\d+$/, ":12345"),
      centerSite: null,
    }),
    /域名/,
  );
  await app.sites.create(admin, {
    id: "exhausted",
    name: "Retry example",
    origin: "https://retry.example.test",
    centerSite: null,
  });
  await pool.query(
    "UPDATE auth_instance SET state='provisioning',attempts=5 WHERE site_id='exhausted'",
  );
  await runJobs(pool, app.auth);
  assert.equal((await app.auth.instance("exhausted")).state, "failed");
  const token = await app.sites.operators.login(admin.email, password);
  const response = await app.respond(
    new Request(origins[3] + "/admin/api/tasks/retry", {
      method: "POST",
      headers: {
        host: new URL(origins[3]).host,
        origin: origins[3],
        cookie: "network_operator=" + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ siteId: "exhausted" }),
    }),
  );
  assert.equal(response.status, 200);
  await runJobs(pool, app.auth);
  assert.equal((await app.auth.instance("exhausted")).state, "ready");
});

test("P1 CLI and two independent Next processes share configuration and enforce immediate stop", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const env = {
    ...process.env,
    P0_NEXT_TEST: "false",
    DATABASE_URL: process.env.P0_DATABASE_URL!,
    ADMIN_ORIGIN: origins[3],
    AUTH_ENCRYPTION_KEY: key,
    OPERATOR_EMAIL: admin.email,
    OPERATOR_PASSWORD: password,
  };
  const exported = JSON.parse(
    (
      await exec(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "export", "library"],
        { env },
      )
    ).stdout,
  );
  assert.equal(exported.siteId, "library");
  const children: ReturnType<typeof fork>[] = [],
    ports: number[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const child = fork(
        new URL("../../p0/internal/next-server.ts", import.meta.url),
        {
          env,
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      children.push(child);
      const [message] = await once(child, "message");
      ports.push(message.port);
    }
    const get = (port: number, host: string, path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          { hostname: "127.0.0.1", port, path, headers: { host } },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode!, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    for (const port of ports)
      assert.equal(
        JSON.parse(
          (await get(port, new URL(origins[2]).host, "/api/config")).body,
        ).revision,
        1,
      );
    const dir = await mkdtemp(join(tmpdir(), "network-config-"));
    try {
      exported.config.name = "CLI published";
      const file = join(dir, "config.json");
      await writeFile(file, JSON.stringify(exported));
      const comparison = JSON.parse(
        (
          await exec(
            process.execPath,
            ["--import", "tsx", "src/cli.ts", "compare", "library", file],
            { env },
          )
        ).stdout,
      );
      assert.equal(comparison.stale, false);
      await exec(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "import", "library", file, "2"],
        { env },
      );
      const operation = randomUUID();
      await exec(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "publish",
          "library",
          "1",
          "3",
          operation,
        ],
        { env },
      );
      await exec(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/cli.ts",
          "publish",
          "library",
          "1",
          "3",
          operation,
        ],
        { env },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const start = Date.now(),
      deadline = start + 8000;
    let consistent = false;
    do {
      consistent = (
        await Promise.all(
          ports.map((port) =>
            get(port, new URL(origins[2]).host, "/api/config"),
          ),
        )
      ).every((r) => JSON.parse(r.body).config.name === "CLI published");
      if (consistent) break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    assert.equal(consistent, true);
    console.log(
      "P1 two-process propagation observed within " +
        (Date.now() - start) +
        "ms after CLI publication",
    );
    await app.sites.status(admin, "library", false);
    for (const port of ports)
      assert.equal(
        (await get(port, new URL(origins[2]).host, "/")).status,
        404,
      );
    await app.sites.status(admin, "library", true);
    await app.sites.create(admin, {
      id: "live-added",
      name: "无需重启的新站",
      origin: "https://live-added.example.test",
      centerSite: null,
    });
    for (const port of ports)
      assert.equal(
        (await get(port, "live-added.example.test", "/")).status,
        200,
      );
  } finally {
    await Promise.all(
      children.map(async (child) => {
        const done = once(child, "exit");
        child.kill();
        await done;
      }),
    );
  }
});

test("P1 public pages and assets are cacheable while authenticated surfaces stay no-store", async () => {
  const page = await app.respond(
    new Request(origins[0] + "/", {
      headers: { host: new URL(origins[0]).host },
    }),
  );
  assert.equal(page.status, 200);
  assert.match(page.headers.get("cache-control") ?? "", /public/);
  const etag = page.headers.get("etag");
  assert.ok(etag);
  await page.text();
  const revalidated = await app.respond(
    new Request(origins[0] + "/", {
      headers: {
        host: new URL(origins[0]).host,
        "if-none-match": etag!,
      },
    }),
  );
  assert.equal(revalidated.status, 304);

  const robots = await app.respond(
    new Request(origins[0] + "/robots.txt", {
      headers: { host: new URL(origins[0]).host },
    }),
  );
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Sitemap: .*\/sitemap\.xml/);
  assert.match(robots.headers.get("cache-control") ?? "", /public/);

  const asset = await app.respond(
    new Request(origins[0] + "/assets/network.css", {
      headers: { host: new URL(origins[0]).host },
    }),
  );
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /max-age=3600/);
  const assetTag = asset.headers.get("etag");
  assert.ok(assetTag);
  await asset.text();
  assert.equal(
    (
      await app.respond(
        new Request(origins[0] + "/assets/network.css", {
          headers: {
            host: new URL(origins[0]).host,
            "if-none-match": assetTag!,
          },
        }),
      )
    ).status,
    304,
  );

  const login = await app.respond(
    new Request(origins[0] + "/login", {
      headers: { host: new URL(origins[0]).host },
    }),
  );
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("cache-control"), "no-store");
});

test("operator login lockout is scoped to email and source", async () => {
  const email = "operator-lockout@example.test";
  await app.sites.operators.create(email, password);
  for (let attempt = 0; attempt < 10; attempt++)
    await assert.rejects(
      app.sites.operators.login(email, "wrong-password", "192.0.2.10"),
      /账号或密码/,
    );
  await assert.rejects(
    app.sites.operators.login(email, "wrong-password", "192.0.2.10"),
    /登录尝试过多/,
  );
  const token = await app.sites.operators.login(
    email,
    password,
    "192.0.2.11",
  );
  assert.ok(token);
});

test("P1 localized page and module disable use authoritative public visibility", async () => {
  const id = "library";
  const snapshot = await app.sites.export(admin, id);
  snapshot.config.locales = ["zh", "en"];
  await pool.query("INSERT INTO resource(id) VALUES('p1-locale')");
  await pool.query(
    "INSERT INTO publication(site_id,resource_id,locale,slug,title,status) VALUES('library','p1-locale','en','english','English only resource','published')",
  );
  let state = await app.sites.config(admin).read(id);
  let draft = await app.sites.save(
    admin,
    id,
    snapshot,
    { revision: state.revision, draftVersion: state.draft_version },
    true,
  );
  await app.sites.publish(admin, id, {
    revision: state.revision,
    draftVersion: draft,
  });
  // A fresh process must use the locale encoded in the path, not the configured default.
  const fresh = new Application(pool, app.config);
  try {
    const request = (path: string) =>
      new Request(origins[2] + path, {
        headers: { host: new URL(origins[2]).host },
      });
    assert.match(
      await (await fresh.respond(request("/en/tools"))).text(),
      /English only resource/,
    );
    assert.doesNotMatch(
      await (await fresh.respond(request("/zh/tools"))).text(),
      /English only resource/,
    );
    const disabled = await app.sites.export(admin, id);
    disabled.config.modules = [];
    state = await app.sites.config(admin).read(id);
    draft = await app.sites.save(admin, id, disabled, {
      revision: state.revision,
      draftVersion: state.draft_version,
    });
    await app.sites.publish(admin, id, {
      revision: state.revision,
      draftVersion: draft,
    });
    assert.deepEqual(
      await (await fresh.respond(request("/api/catalog?locale=en"))).json(),
      [],
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM publication WHERE resource_id='p1-locale'",
        )
      ).rows[0].count,
      "1",
    );
  } finally {
    await fresh.close();
  }
  await assert.rejects(
    app.sites.create(admin, {
      id: "insecure-shared",
      name: "Invalid",
      origin: "http://insecure.example.test",
      centerSite: "atlas",
      legacyShared: true,
    }),
  );
});

test("P1 failed publication event can be requeued by an administrator without another revision", async () => {
  const row = (
    await pool.query(
      "SELECT id,site_id,revision FROM outbox ORDER BY id LIMIT 1",
    )
  ).rows[0];
  await pool.query(
    "UPDATE outbox SET status='failed',attempts=5,last_error='delivery_failed',lease_token=NULL,lease_until=NULL WHERE id=$1",
    [row.id],
  );
  const before = await app.sites.config(admin).read(row.site_id);
  const token = await app.sites.operators.login(admin.email, password);
  const request = () =>
    new Request(origins[3] + "/admin/api/tasks/retry-event", {
      method: "POST",
      headers: {
        host: new URL(origins[3]).host,
        origin: origins[3],
        cookie: "network_operator=" + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: row.id }),
    });
  assert.equal((await app.respond(request())).status, 200);
  assert.equal((await app.respond(request())).status, 409);
  await runJobs(pool, app.auth);
  assert.equal(
    (await pool.query("SELECT status FROM outbox WHERE id=$1", [row.id]))
      .rows[0].status,
    "done",
  );
  assert.equal(
    (await app.sites.config(admin).read(row.site_id)).revision,
    before.revision,
  );
});

test("P1 unauthenticated admin redirect retains location and security headers", async () => {
  const response = await app.respond(
    new Request(origins[3] + "/admin", {
      headers: { host: new URL(origins[3]).host },
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), origins[3] + "/admin/login");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("admin navigation review: delayed resource loading cannot replace the team page", async () => {
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
    await page.locator("#create").waitFor();
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/admin/api/resources?**", async (route) => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    await page.evaluate(() => {
      location.hash = "resources";
    });
    await entered;
    await page.evaluate(() => {
      location.hash = "team";
    });
    await page.locator("#member-email").waitFor();
    const finished = page.waitForResponse((r) =>
      r.url().includes("/admin/api/resources?"),
    );
    release();
    await (await finished).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.equal(await page.locator("#member-email").count(), 1);
    assert.equal(await page.locator("#resource-id").count(), 0);
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      null,
    );
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test("admin navigation review: old errors do not unlock a loading page and committed saves do not navigate back", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const releases: Array<() => void> = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function hold(pattern: string, fail = false) {
    let release!: () => void, enter!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    releases.push(release);
    await page.route(pattern, async (route) => {
      const response = fail ? null : await route.fetch();
      enter();
      await waiting;
      if (fail)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "OLD-VIEW-ERROR" }),
        });
      else await route.fulfill({ response: response! });
    });
    return { entered, release };
  }
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.locator("#create").waitFor();
    const old = await hold("**/admin/api/operators", true);
    await page.evaluate(() => {
      location.hash = "team";
    });
    await old.entered;
    const current = await hold("**/admin/api/tasks");
    await page.evaluate(() => {
      location.hash = "tasks";
    });
    await current.entered;
    await page.evaluate(() => {
      document.querySelector("#message")!.textContent = "CURRENT-VIEW";
    });
    const late = page.waitForResponse((r) => r.url().endsWith("/operators"));
    old.release();
    await (await late).finished();
    await settle();
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      "true",
    );
    assert.equal(await page.locator("#message").textContent(), "CURRENT-VIEW");
    current.release();
    await page.getByRole("heading", { name: "运行任务" }).waitFor();
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      null,
    );
    await page.unrouteAll({ behavior: "wait" });
    await page.evaluate(() => {
      location.hash = "site/atlas";
    });
    await page.locator("#name").waitFor();
    const saving = await hold("**/admin/api/sites/atlas/save");
    await page.locator("#name").fill("Navigation committed draft");
    await page.locator("#replace").check();
    await page.locator("#save").click();
    await saving.entered; // route.fetch already committed the actual save.
    await page.evaluate(() => {
      location.hash = "resources";
    });
    await page.locator("#resource-id").waitFor();
    const savedResponse = page.waitForResponse((r) =>
      r.url().endsWith("/atlas/save"),
    );
    saving.release();
    await (await savedResponse).finished();
    await settle();
    assert.equal(await page.locator("#resource-id").count(), 1);
    assert.equal(await page.locator("#name").count(), 0);
    assert.equal(
      (await app.sites.export(admin, "atlas", true)).config.name,
      "Navigation committed draft",
    );
    await page.unrouteAll({ behavior: "wait" });
    const failed = await hold("**/admin/api/tasks", true);
    await page.evaluate(() => {
      location.hash = "tasks";
    });
    await failed.entered;
    failed.release();
    await page.locator("#retry-page").waitFor();
    assert.equal(
      await page.locator("#workspace").getAttribute("aria-busy"),
      null,
    );
    assert.equal(
      await page.locator("#message").textContent(),
      "OLD-VIEW-ERROR",
    );
    await page.unrouteAll({ behavior: "wait" });
    await page.locator("#retry-page").click();
    await page.getByRole("heading", { name: "运行任务" }).waitFor();
    assert.equal(await page.locator("#message").textContent(), "");
    assert.deepEqual(errors, []);
  } finally {
    for (const release of releases) release();
    await context.close();
    await browser.close();
  }
});

test("admin configuration review: slow files cannot overwrite a newer selection or manual edits", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let releaseComparison = () => {};
  try {
    await page.goto(origins[3] + "/admin/login");
    await page.locator("#email").fill(admin.email);
    await page.locator("#password").fill(password);
    await page.locator("button").click();
    await page.waitForURL(origins[3] + "/admin");
    await page.goto(origins[3] + "/admin#site/atlas");
    await page.locator("#name").waitFor();
    await page.getByRole("heading", { name: "登录提供方" }).waitFor();
    await page.locator("summary").click();
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        if (this.name !== "slow.json") return original.call(this);
        const file = this;
        return new Promise<string>((resolve) => {
          (window as any).releaseConfigFile = async () => {
            resolve(await original.call(file));
          };
        });
      };
    });
    const original = await app.sites.export(admin, "atlas");
    const slow = {
      ...original,
      config: { ...original.config, name: "Slow stale name" },
    };
    const fresh = {
      ...original,
      config: { ...original.config, name: "Latest file name" },
    };
    const select = (name: string, value: unknown) =>
      page.locator("#import").setInputFiles({
        name,
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(value)),
      });
    await select("slow.json", slow);
    await page.locator("#save").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("仍在读取或校验"),
    );
    await select("fresh.json", fresh);
    await page.waitForFunction(
      () =>
        (document.querySelector("#name") as HTMLInputElement)?.value ===
        "Latest file name",
    );
    await page.evaluate(() => (window as any).releaseConfigFile());
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    assert.equal(await page.locator("#name").inputValue(), "Latest file name");
    await select("slow.json", slow);
    await page.locator("#name").fill("Manual name retained");
    await page.evaluate(() => (window as any).releaseConfigFile());
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    assert.equal(
      await page.locator("#name").inputValue(),
      "Manual name retained",
    );
    await page.locator("#import").setInputFiles([]);
    assert.equal(
      await page.locator("#name").inputValue(),
      "Manual name retained",
    );
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseComparison = resolve;
    });
    await page.route("**/admin/api/sites/atlas/compare", async (route) => {
      const response = await route.fetch();
      enter();
      await held;
      await route.fulfill({ response });
    });
    await page.locator("#compare").click();
    await entered;
    await page.locator("#name").fill("Edited after comparison started");
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/atlas/compare"),
    );
    releaseComparison();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.equal(await page.locator("#diff").textContent(), "");
    assert.equal(
      await page.locator("#name").inputValue(),
      "Edited after comparison started",
    );
  } finally {
    releaseComparison();
    await context.close();
    await browser.close();
  }
});

test("P1 failed config delivery retains retry and does not skip mail or session maintenance", async (t) => {
  const insert = async (site: string) =>
    (
      await pool.query(
        "INSERT INTO outbox(site_id,revision) SELECT $1,COALESCE(MAX(revision),0)+1 FROM outbox WHERE site_id=$1 RETURNING id",
        [site],
      )
    ).rows[0].id;
  const failed = await insert("atlas");
  const other = await insert("notes");
  const heartbeat = (
    await pool.query(
      "SELECT completed_at FROM maintenance_status WHERE name='worker'",
    )
  ).rows[0]?.completed_at;
  let broken = true,
    mail = 0,
    maintenance = 0;
  const deliver = OutboxWorker.prototype.deliver;
  t.mock.method(
    OutboxWorker.prototype,
    "deliver",
    async function (this: OutboxWorker, job: Parameters<typeof deliver>[0]) {
      if (broken && job.id === failed)
        throw new Error("Injected delivery failure");
      return deliver.call(this, job);
    },
  );
  t.mock.method(app.auth.mail, "runOnce", async () => {
    mail++;
    return true;
  });
  const maintain = app.auth.maintain.bind(app.auth);
  t.mock.method(app.auth, "maintain", async () => {
    maintenance++;
    return maintain();
  });
  await assert.rejects(runJobs(pool, app.auth), AggregateError);
  assert.equal(mail, 1);
  assert.equal(maintenance, 1);
  const statuses = (
    await pool.query(
      "SELECT id,status,attempts,last_error FROM outbox WHERE id=ANY($1::bigint[]) ORDER BY id",
      [[failed, other]],
    )
  ).rows;
  assert.equal(statuses.find((r) => r.id === failed).status, "pending");
  assert.equal(statuses.find((r) => r.id === failed).attempts, 1);
  assert.equal(
    statuses.find((r) => r.id === failed).last_error,
    "delivery_failed",
  );
  assert.equal(statuses.find((r) => r.id === other).status, "pending");
  assert.deepEqual(
    (
      await pool.query(
        "SELECT completed_at FROM maintenance_status WHERE name='worker'",
      )
    ).rows[0]?.completed_at,
    heartbeat,
  );
  broken = false;
  await pool.query("UPDATE outbox SET available_at=now() WHERE id=$1", [
    failed,
  ]);
  await runJobs(pool, app.auth);
  assert.equal(
    (await pool.query("SELECT status FROM outbox WHERE id=$1", [failed]))
      .rows[0].status,
    "done",
  );
  assert.equal(
    (await pool.query("SELECT status FROM outbox WHERE id=$1", [other])).rows[0]
      .status,
    "done",
  );
  assert.equal(mail, 2);
  assert.equal(maintenance, 2);
});

test("P1 mail failure still runs session maintenance and multiple errors are retained", async (t) => {
  let maintenance = 0;
  const mailError = new Error("Injected mail failure");
  const maintenanceError = new Error("Injected maintenance failure");
  t.mock.method(app.auth.mail, "runOnce", async () => {
    throw mailError;
  });
  t.mock.method(app.auth, "maintain", async () => {
    maintenance++;
    throw maintenanceError;
  });
  await assert.rejects(runJobs(pool, app.auth), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [mailError, maintenanceError]);
    return true;
  });
  assert.equal(maintenance, 1);
});

async function controlActor(name: string) {
  const email = `control-${name}@example.test`;
  return {
    id: await app.sites.operators.create(email, password, true),
    email,
    global_admin: true,
  };
}
async function controlPost(actor: Operator, path: string, body: unknown) {
  const token = await app.sites.operators.login(actor.email, password);
  return new Request(origins[3] + "/admin/api" + path, {
    method: "POST",
    headers: {
      host: new URL(origins[3]).host,
      origin: origins[3],
      cookie: "network_operator=" + token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function controlSnapshot(actor: Operator) {
  const state: unknown[] = [];
  for (const table of [
    "operator_user",
    "operator_grant",
    "site",
    "identity_space",
    "identity_site",
    "auth_instance",
    "config_revision",
    "outbox",
    "audit_event",
  ]) {
    const rows = await pool.query(
      `SELECT row_to_json(t)::text AS value FROM ${table} t ${table === "operator_user" ? "WHERE id<>$1" : ""} ORDER BY row_to_json(t)::text`,
      table === "operator_user" ? [actor.id] : [],
    );
    state.push([table, rows.rows]);
  }
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
async function controlWait(blocker: number, minimum = 1) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const rows = (
      await pool.query(
        `WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
        ) SELECT pid FROM waiting`,
        [blocker],
      )
    ).rows;
    if (rows.length >= minimum) return rows[0].pid as number;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("Expected a real blocked database operation");
}
for (const action of [
  "/operators",
  "/grants/revoke",
  "/operators/disable",
  "/tasks/retry-event",
  "/tasks/retry",
]) {
  test(`control permission review: body wait then revocation rejects ${action}`, async () => {
    const actor = await controlActor(action.replaceAll("/", "-"));
    const target = await app.sites.operators.create(
      `target-${actor.id}@example.test`,
      password,
    );
    await app.sites.operators.grant(admin, target, "atlas", "editor");
    const event = (
      await pool.query(
        "INSERT INTO outbox(site_id,revision,status) VALUES('atlas',0,'failed') RETURNING id",
      )
    ).rows[0].id;
    await pool.query(
      "UPDATE auth_instance SET state='failed' WHERE site_id='library'",
    );
    const input =
      action === "/operators"
        ? { email: `new-${actor.id}@example.test`, password }
        : action === "/grants/revoke"
          ? { userId: target, siteId: "atlas" }
          : action === "/operators/disable"
            ? { userId: target }
            : action === "/tasks/retry-event"
              ? { id: event }
              : { siteId: "library" };
    const request = await controlPost(actor, action, input);
    let read!: () => void, release!: () => void;
    const reading = new Promise<void>((r) => (read = r));
    const gate = new Promise<void>((r) => (release = r));
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          read();
          await gate;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const pending = app.respond(
      new Request(request, { body: stream, duplex: "half" } as RequestInit),
    );
    try {
      await reading;
      const snapshot = await controlSnapshot(actor);
      await pool.query(
        "UPDATE operator_user SET global_admin=false WHERE id=$1",
        [actor.id],
      );
      release();
      assert.equal((await pending).status, 403);
      assert.equal(await controlSnapshot(actor), snapshot);
    } finally {
      release();
      await pending;
    }
  });
}
test("control permission review: grant waits then rejects demoted administrator", async () => {
  const actor = await controlActor("grant-lock");
  const target = await app.sites.operators.create(
    "control-grant-target@example.test",
    password,
  );
  await app.sites.operators.grant(admin, target, "atlas", "viewer");
  const blocker = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT * FROM operator_grant WHERE user_id=$1 AND site_id='atlas' FOR UPDATE",
      [target],
    );
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    const snapshot = await controlSnapshot(actor);
    pending = app.sites.operators.grant(actor, target, "atlas", "editor").then(
      () => null,
      (e) => e,
    );
    await controlWait(pid);
    await pool.query(
      "UPDATE operator_user SET global_admin=false WHERE id=$1",
      [actor.id],
    );
    await blocker.query("COMMIT");
    assert.equal(((await pending) as { status: number } | null)?.status, 403);
    assert.equal(await controlSnapshot(actor), snapshot);
  } finally {
    await blocker.query("ROLLBACK");
    await pending;
    blocker.release();
  }
});
test("control permission review: shared site creation waits then rejects disabled administrator", async () => {
  const actor = await controlActor("site-lock");
  const blocker = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT * FROM auth_instance WHERE site_id='atlas' FOR UPDATE",
    );
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    const snapshot = await controlSnapshot(actor);
    pending = app.sites
      .create(actor, {
        id: "control-shared",
        name: "Shared",
        origin: "https://control-shared.example.test",
        centerSite: "atlas",
        legacyShared: true,
      })
      .then(
        () => null,
        (e) => e,
      );
    await controlWait(pid);
    await pool.query("UPDATE operator_user SET disabled=true WHERE id=$1", [
      actor.id,
    ]);
    await blocker.query("COMMIT");
    assert.equal(((await pending) as { status: number } | null)?.status, 403);
    assert.equal(await controlSnapshot(actor), snapshot);
  } finally {
    await blocker.query("ROLLBACK");
    await pending;
    blocker.release();
  }
});

for (const action of ["/grants/revoke", "/tasks/retry-event", "/tasks/retry"]) {
  test(`control permission review: business lock then revocation rejects ${action}`, async () => {
    const actor = await controlActor("locked" + action.replaceAll("/", "-"));
    const target = await app.sites.operators.create(
      `locked-target-${actor.id}@example.test`,
      password,
    );
    await app.sites.operators.grant(admin, target, "atlas", "editor");
    const event = (
      await pool.query(
        "INSERT INTO outbox(site_id,revision,status) VALUES('atlas',0,'failed') RETURNING id",
      )
    ).rows[0].id;
    await pool.query(
      "UPDATE auth_instance SET state='failed' WHERE site_id='library'",
    );
    const input =
      action === "/grants/revoke"
        ? { userId: target, siteId: "atlas" }
        : action === "/tasks/retry-event"
          ? { id: event }
          : { siteId: "library" };
    const request = await controlPost(actor, action, input);
    const blocker = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await blocker.query("BEGIN");
      if (action === "/grants/revoke")
        await blocker.query(
          "SELECT role FROM operator_grant WHERE user_id=$1 AND site_id='atlas' FOR UPDATE",
          [target],
        );
      else if (action === "/tasks/retry-event")
        await blocker.query("SELECT id FROM outbox WHERE id=$1 FOR UPDATE", [
          event,
        ]);
      else
        await blocker.query(
          "SELECT site_id FROM auth_instance WHERE site_id='library' FOR UPDATE",
        );
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const snapshot = await controlSnapshot(actor);
      pending = app.respond(request);
      await controlWait(pid);
      await pool.query(
        "UPDATE operator_user SET global_admin=false WHERE id=$1",
        [actor.id],
      );
      await blocker.query("COMMIT");
      assert.equal((await pending).status, 403);
      assert.equal(await controlSnapshot(actor), snapshot);
    } finally {
      await blocker.query("ROLLBACK");
      await pending;
      blocker.release();
    }
  });
}

test("operator account lifecycle resets credentials and revokes sessions", async () => {
  const email = "operator-lifecycle@example.test",
    next = "operator-lifecycle-next-password";
  const target = await app.sites.operators.create(email, password);
  const token = await app.sites.operators.login(email, password);
  const header = new Headers({ cookie: "network_operator=" + token });
  assert.equal((await app.sites.operators.current(header)).id, target);

  await app.sites.operators.setPassword(admin, target, next);
  await assert.rejects(app.sites.operators.current(header), /会话/);
  await assert.rejects(
    app.sites.operators.login(email, password),
    /账号或密码/,
  );
  const nextToken = await app.sites.operators.login(email, next);

  await app.sites.operators.setDisabled(admin, target, true);
  await assert.rejects(app.sites.operators.login(email, next), /账号或密码/);
  await app.sites.operators.setDisabled(admin, target, false);
  const restored = await app.sites.operators.login(email, next);
  assert.ok(restored);

  await app.sites.operators.revokeSessions(admin, target);
  await assert.rejects(
    app.sites.operators.current(
      new Headers({ cookie: "network_operator=" + nextToken }),
    ),
    /会话/,
  );
  await assert.rejects(
    app.sites.operators.setDisabled(admin, admin.id, true),
    /自己/,
  );
  const audit = await pool.query(
    "SELECT action FROM audit_event WHERE actor_id=$1 AND action LIKE 'operator.%' ORDER BY id DESC LIMIT 5",
    [admin.id],
  );
  const actions = new Set(audit.rows.map((row) => row.action));
  for (const action of [
    "operator.password",
    "operator.disable",
    "operator.enable",
    "operator.session.revoke",
  ])
    assert.ok(actions.has(action), action);
});

test("control permission review: account creation rechecks after password hashing", async () => {
  const actor = await controlActor("hash-lock");
  const request = await controlPost(actor, "/operators", {
    email: "control-created-after-hash@example.test",
    password,
  });
  const blocker = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM operator_user WHERE id=$1 FOR UPDATE", [
      actor.id,
    ]);
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    const snapshot = await controlSnapshot(actor);
    pending = app.respond(request);
    await controlWait(pid);
    await blocker.query("UPDATE operator_user SET disabled=true WHERE id=$1", [
      actor.id,
    ]);
    await blocker.query("COMMIT");
    assert.equal((await pending).status, 403);
    assert.equal(await controlSnapshot(actor), snapshot);
  } finally {
    await blocker.query("ROLLBACK");
    await pending;
    blocker.release();
  }
});

test("control permission review: mutual administrator disable serializes without deadlock", async () => {
  const actors = await Promise.all([
    controlActor("mutual-a"),
    controlActor("mutual-b"),
  ]);
  const requests = await Promise.all(
    actors.map((actor, i) =>
      controlPost(actor, "/operators/disable", { userId: actors[1 - i].id }),
    ),
  );
  const blocker = await pool.connect();
  let pending: Promise<Response[]> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM operator_user WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",
      [actors.map((a) => a.id)],
    );
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    pending = Promise.all(requests.map((r) => app.respond(r)));
    // Both requests must have passed initial authentication before the winner
    // can disable the other account. Include indirect tuple-lock waiters.
    await controlWait(pid, 2);
    await blocker.query("COMMIT");
    assert.deepEqual((await pending).map((r) => r.status).sort(), [200, 403]);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT disabled FROM operator_user WHERE id=ANY($1::uuid[])",
          [actors.map((a) => a.id)],
        )
      ).rows
        .map((r) => r.disabled)
        .sort(),
      [false, true],
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM audit_event WHERE actor_id=ANY($1::uuid[]) AND action='operator.disable'",
          [actors.map((a) => a.id)],
        )
      ).rows[0].count,
      "1",
    );
  } finally {
    await blocker.query("ROLLBACK");
    await pending;
    blocker.release();
  }
});

test("control permission review: authorized controls commit audit and reject invalid retries", async () => {
  const actor = await controlActor("success");
  const post = async (path: string, body: unknown) =>
    app.respond(await controlPost(actor, path, body));
  const created = await post("/operators", {
    email: "control-created-success@example.test",
    password,
  });
  assert.equal(created.status, 200);
  const { id } = await created.json();
  assert.equal(
    (
      await pool.query("SELECT global_admin FROM operator_user WHERE id=$1", [
        id,
      ])
    ).rows[0].global_admin,
    false,
  );
  assert.equal(
    (await post("/grants", { userId: id, siteId: "atlas", role: "editor" }))
      .status,
    200,
  );
  assert.equal(
    (await post("/grants/revoke", { userId: id, siteId: "atlas" })).status,
    200,
  );
  assert.equal(
    (await pool.query("SELECT * FROM operator_grant WHERE user_id=$1", [id]))
      .rowCount,
    0,
  );
  assert.equal(
    (await post("/operators/disable", { userId: actor.id })).status,
    400,
  );
  assert.equal((await post("/operators/disable", { userId: id })).status, 200);
  assert.equal(
    (await pool.query("SELECT disabled FROM operator_user WHERE id=$1", [id]))
      .rows[0].disabled,
    true,
  );
  const event = (
    await pool.query(
      "INSERT INTO outbox(site_id,revision,status,attempts,last_error) VALUES('atlas',0,'failed',5,'test_failure') RETURNING id",
    )
  ).rows[0].id;
  assert.equal((await post("/tasks/retry-event", { id: event })).status, 200);
  assert.equal((await post("/tasks/retry-event", { id: event })).status, 409);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT status,attempts,last_error FROM outbox WHERE id=$1",
        [event],
      )
    ).rows[0],
    { status: "pending", attempts: 0, last_error: null },
  );
  await pool.query(
    "UPDATE auth_instance SET state='failed',attempts=5,error_code='test_failure' WHERE site_id='library'",
  );
  assert.equal((await post("/tasks/retry", { siteId: "library" })).status, 200);
  assert.equal((await post("/tasks/retry", { siteId: "library" })).status, 409);
  assert.equal(
    (await post("/tasks/retry", { siteId: "missing-control-site" })).status,
    409,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT state,attempts,error_code FROM auth_instance WHERE site_id='library'",
      )
    ).rows[0],
    { state: "pending", attempts: 0, error_code: null },
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT action FROM audit_event WHERE actor_id=$1 ORDER BY id",
        [actor.id],
      )
    ).rows.map((r) => r.action),
    [
      "operator.create",
      "operator.grant",
      "operator.revoke",
      "operator.disable",
      "task.retry",
      "auth.retry",
    ],
  );
});

test("control permission review: failed audit rolls account creation and auth retry back", async () => {
  const actor = await controlActor("audit-failure");
  await pool.query(
    "UPDATE auth_instance SET state='failed',attempts=5,error_code='test_failure' WHERE site_id='library'",
  );
  await pool.query(
    `CREATE FUNCTION control_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('operator.create','auth.retry') THEN RAISE EXCEPTION 'Injected control audit failure'; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER control_reject_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION control_reject_audit()",
  );
  try {
    const snapshot = await controlSnapshot(actor);
    assert.equal(
      (
        await app.respond(
          await controlPost(actor, "/operators", {
            email: "control-audit-rollback@example.test",
            password,
          }),
        )
      ).status,
      503,
    );
    assert.equal(
      (
        await app.respond(
          await controlPost(actor, "/tasks/retry", { siteId: "library" }),
        )
      ).status,
      503,
    );
    assert.equal(await controlSnapshot(actor), snapshot);
  } finally {
    await pool.query(
      "DROP TRIGGER control_reject_audit ON audit_event; DROP FUNCTION control_reject_audit()",
    );
  }
});

test("control permission review: authorized retry holds authority until audit commits", async () => {
  const actor = await controlActor("commit-order");
  const request = await controlPost(actor, "/tasks/retry", {
    siteId: "library",
  });
  await pool.query(
    "UPDATE auth_instance SET state='failed' WHERE site_id='library'",
  );
  await pool.query(
    `CREATE FUNCTION control_hold_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='auth.retry' THEN PERFORM pg_advisory_xact_lock(hashtextextended('control-commit-gate',0)); END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER control_hold_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION control_hold_audit()",
  );
  const blocker = await pool.connect();
  let pending: Promise<Response> | undefined,
    demoting: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('control-commit-gate',0))",
    );
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    pending = app.respond(request);
    const writer = await controlWait(pid);
    demoting = pool.query(
      "UPDATE operator_user SET global_admin=false WHERE id=$1",
      [actor.id],
    );
    void demoting.catch(() => {});
    await controlWait(writer);
    await blocker.query("COMMIT");
    assert.equal((await pending).status, 200);
    await demoting;
    assert.equal(
      (
        await pool.query(
          "SELECT state FROM auth_instance WHERE site_id='library'",
        )
      ).rows[0].state,
      "pending",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM audit_event WHERE actor_id=$1 AND action='auth.retry'",
          [actor.id],
        )
      ).rows[0].count,
      "1",
    );
    assert.equal(
      (
        await app.respond(
          await controlPost(actor, "/tasks/retry", { siteId: "library" }),
        )
      ).status,
      403,
    );
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled([pending, demoting].filter(Boolean));
    blocker.release();
    await pool.query(
      "DROP TRIGGER control_hold_audit ON audit_event; DROP FUNCTION control_hold_audit()",
    );
  }
});

async function taskPageFixture() {
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
  const data = {
    instances: ["ready", "pending", "provisioning", "failed"].map((state) => ({
      site_id: "fixture-" + state,
      state,
      attempts: state === "failed" ? 5 : 0,
      error_code: null,
    })),
    eventFailures: [
      {
        id: "42",
        site_id: "fixture-failed",
        revision: 1,
        last_error: "fixture_failure",
      },
    ],
    events: [],
    github: [],
    mail: [],
    maintenance: [],
  };
  await page.route("**/admin/api/me", (route) =>
    route.fulfill({ json: admin }),
  );
  await page.route("**/admin/api/sites", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/admin/api/tasks", (route) =>
    route.fulfill({ json: data }),
  );
  const open = async () => {
    await page.goto(origins[3] + "/admin#tasks");
    await page.getByRole("heading", { name: "运行任务" }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
  };
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  return { browser, context, page, data, open, settle };
}

test("task page review: only failed authentication instances offer retry", async () => {
  const f = await taskPageFixture();
  try {
    await f.open();
    assert.equal(await f.page.locator(".retry").count(), 1);
    assert.equal(
      await f.page.locator(".retry").getAttribute("data-site"),
      "fixture-failed",
    );
    assert.equal(await f.page.locator("#refresh-tasks").count(), 1);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});
for (const kind of ["instance", "event"]) {
  test(`task page review: pending ${kind} retry prevents duplicate and parallel actions`, async () => {
    const f = await taskPageFixture();
    const path = kind === "instance" ? "/tasks/retry" : "/tasks/retry-event";
    const selector =
      kind === "instance"
        ? '.retry[data-site="fixture-failed"]'
        : ".retry-event";
    let release!: () => void,
      enter!: () => void,
      count = 0;
    const gate = new Promise<void>((r) => (release = r)),
      entered = new Promise<void>((r) => (enter = r));
    try {
      await f.page.route("**/admin/api" + path, async (route) => {
        count++;
        enter();
        await gate;
        if (kind === "instance")
          f.data.instances = f.data.instances.filter(
            (i) => i.state !== "failed",
          );
        else f.data.eventFailures = [];
        await route.fulfill({ json: { ok: true } });
      });
      await f.open();
      await f.page.locator(selector).evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await entered;
      await f.settle();
      assert.equal(count, 1);
      assert.equal(await f.page.locator(selector).isDisabled(), true);
      assert.equal(
        await f.page
          .locator(
            kind === "instance"
              ? ".retry-event"
              : '.retry[data-site="fixture-failed"]',
          )
          .isDisabled(),
        true,
      );
      assert.equal(await f.page.locator("#refresh-tasks").isDisabled(), true);
      release();
      await f.page.locator(selector).waitFor({ state: "detached" });
      assert.match(await f.page.locator("#message").innerText(), /已重新排队/);
    } finally {
      release();
      await f.context.close();
      await f.browser.close();
    }
  });
  test(`task page review: committed ${kind} retry survives refresh failure without requeue`, async () => {
    const f = await taskPageFixture();
    let gets = 0,
      posts = 0;
    const selector =
      kind === "instance"
        ? '.retry[data-site="fixture-failed"]'
        : ".retry-event";
    try {
      await f.page.route("**/admin/api/tasks", (route) => {
        gets++;
        return gets === 2
          ? route.fulfill({ status: 503, json: { error: "REFRESH-FAILED" } })
          : route.fulfill({ json: f.data });
      });
      await f.page.route(
        "**/admin/api" +
          (kind === "instance" ? "/tasks/retry" : "/tasks/retry-event"),
        (route) => {
          posts++;
          return route.fulfill({ json: { ok: true } });
        },
      );
      await f.open();
      await f.page.locator(selector).click();
      await f.page.waitForFunction(() =>
        document
          .querySelector("#message")
          ?.textContent?.includes("REFRESH-FAILED"),
      );
      assert.match(
        await f.page.locator("#message").innerText(),
        /已重新排队.*列表刷新失败/,
      );
      assert.equal(await f.page.locator(selector).isDisabled(), true);
      assert.equal(await f.page.locator("#refresh-tasks").isEnabled(), true);
      await f.page
        .locator(selector)
        .evaluate((b: HTMLButtonElement) => b.click());
      await f.settle();
      assert.equal(posts, 1);
      f.data.instances = f.data.instances.filter((i) => i.state !== "failed");
      f.data.eventFailures = [];
      await f.page.locator("#refresh-tasks").click();
      await f.page.locator(selector).waitFor({ state: "detached" });
      assert.equal(gets, 3);
      assert.equal(posts, 1);
      assert.equal(await f.page.locator("#message").innerText(), "");
    } finally {
      await f.context.close();
      await f.browser.close();
    }
  });
}

test("task page review: rejected retry leaves explicit error and can be retried", async () => {
  const f = await taskPageFixture();
  let posts = 0;
  try {
    await f.page.route("**/admin/api/tasks/retry", (route) => {
      posts++;
      if (posts === 1)
        return route.fulfill({
          status: 403,
          json: { error: "PERMISSION-DENIED" },
        });
      f.data.instances = f.data.instances.filter((i) => i.state !== "failed");
      return route.fulfill({ json: { ok: true } });
    });
    await f.open();
    const retry = f.page.locator('.retry[data-site="fixture-failed"]');
    await retry.click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "PERMISSION-DENIED",
    );
    assert.equal(await retry.isEnabled(), true);
    await retry.click();
    await retry.waitFor({ state: "detached" });
    assert.equal(posts, 2);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("task page review: late retry success cannot refresh or overwrite another view", async () => {
  const f = await taskPageFixture();
  let release!: () => void,
    enter!: () => void,
    gets = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/tasks", (route) => {
      gets++;
      return route.fulfill({ json: f.data });
    });
    await f.page.route("**/admin/api/operators", (route) =>
      route.fulfill({ json: [] }),
    );
    await f.page.route("**/admin/api/tasks/retry-event", async (route) => {
      enter();
      await gate;
      await route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.page.locator(".retry-event").click();
    await entered;
    await f.page.evaluate(() => {
      location.hash = "team";
    });
    await f.page.locator("#member-email").waitFor();
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/tasks/retry-event"),
    );
    release();
    await (await response).finished();
    await f.settle();
    assert.equal(gets, 1);
    assert.equal(await f.page.locator("#member-email").count(), 1);
    assert.equal(await f.page.locator("#message").innerText(), "");
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("task page review: manual refresh blocks actions and recovers from read failure", async () => {
  const f = await taskPageFixture();
  let release!: () => void,
    enter!: () => void,
    gets = 0,
    posts = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  const errors: string[] = [];
  f.page.on("pageerror", (error) => errors.push(error.message));
  try {
    await f.page.route("**/admin/api/tasks", async (route) => {
      gets++;
      if (gets === 2) {
        enter();
        await gate;
        await route.fulfill({ status: 503, json: { error: "READ-FAILED" } });
      } else await route.fulfill({ json: f.data });
    });
    await f.page.route("**/admin/api/tasks/retry-event", (route) => {
      posts++;
      return route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.page.locator("#refresh-tasks").evaluate((b: HTMLButtonElement) => {
      b.click();
      b.click();
    });
    await entered;
    await f.page
      .locator(".retry-event")
      .evaluate((b: HTMLButtonElement) => b.click());
    await f.settle();
    assert.equal(gets, 2);
    assert.equal(posts, 0);
    assert.equal(await f.page.locator(".retry-event").isDisabled(), true);
    release();
    await f.page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("READ-FAILED"),
    );
    assert.equal(await f.page.locator("#refresh-tasks").isEnabled(), true);
    assert.equal(await f.page.locator(".retry-event").isEnabled(), true);
    await f.page.locator("#refresh-tasks").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "" &&
        !document.querySelector<HTMLButtonElement>("#refresh-tasks")?.disabled,
    );
    assert.equal(gets, 3);
    assert.equal(posts, 0);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

async function teamPageFixture() {
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
  const target = "00000000-0000-4000-8000-000000000011";
  const users = [
    {
      id: target,
      email: "team-fixture@example.test",
      global_admin: false,
      disabled: false,
      grants: "atlas:viewer",
    },
    { ...admin, disabled: false, grants: "" },
  ];
  await page.route("**/admin/api/me", (r) => r.fulfill({ json: admin }));
  await page.route("**/admin/api/sites", (r) =>
    r.fulfill({
      json: [
        { id: "atlas", config: { name: "Atlas" } },
        { id: "notes", config: { name: "Notes" } },
      ],
    }),
  );
  await page.route("**/admin/api/operators", (r) => r.fulfill({ json: users }));
  const open = async () => {
    await page.goto(origins[3] + "/admin#team");
    await page.locator("#member-email").waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
  };
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const prepare = async () => {
    await page.locator("#member-email").fill("unsent-member@example.test");
    await page.locator("#member-password").fill("Unsent-member-password-123!");
    await page.locator("#member").selectOption(target);
    await page.locator("#grant-site").selectOption("notes");
    await page.locator("#role").selectOption("editor");
  };
  return { browser, context, page, target, users, open, settle, prepare };
}
const teamOperations = [
  { button: "add-member", path: "/operators", success: "成员已添加" },
  { button: "grant", path: "/grants", success: "权限已更新" },
  { button: "revoke", path: "/grants/revoke", success: "权限已撤销" },
  { button: "disable", path: "/operators/disable", success: "成员已停用" },
];
for (const operation of teamOperations) {
  test(`team page review: pending ${operation.button} blocks duplicate and competing writes`, async () => {
    const f = await teamPageFixture();
    let release!: () => void,
      enter!: () => void,
      posts = 0;
    const gate = new Promise<void>((r) => (release = r)),
      entered = new Promise<void>((r) => (enter = r));
    try {
      await f.page.route("**/admin/api" + operation.path, async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({ json: f.users });
          return;
        }
        posts++;
        enter();
        await gate;
        await route.fulfill({ json: { id: f.target, ok: true } });
      });
      await f.open();
      await f.prepare();
      await f.page
        .locator("#" + operation.button)
        .evaluate((b: HTMLButtonElement) => {
          b.click();
          b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
      await entered;
      await f.settle();
      assert.equal(posts, 1);
      for (const other of teamOperations)
        assert.equal(
          await f.page.locator("#" + other.button).isDisabled(),
          true,
        );
      for (const field of [
        "member-email",
        "member-password",
        "member",
        "grant-site",
        "role",
      ])
        assert.equal(await f.page.locator("#" + field).isDisabled(), true);
      release();
      await f.page.waitForFunction(
        (text) =>
          document.querySelector("#message")?.textContent?.includes(text),
        operation.success,
      );
    } finally {
      release();
      await f.context.close();
      await f.browser.close();
    }
  });
  test(`team page review: committed ${operation.button} survives list failure without resubmission`, async () => {
    const f = await teamPageFixture();
    let posts = 0,
      gets = 0;
    try {
      await f.page.route("**/admin/api/operators", (route) => {
        if (route.request().method() === "POST") {
          posts++;
          return route.fulfill({ json: { id: f.target } });
        }
        gets++;
        return gets === 2
          ? route.fulfill({ status: 503, json: { error: "TEAM-READ-FAILED" } })
          : route.fulfill({ json: f.users });
      });
      if (operation.path !== "/operators")
        await f.page.route("**/admin/api" + operation.path, (route) => {
          posts++;
          return route.fulfill({ json: { ok: true } });
        });
      await f.open();
      await f.prepare();
      await f.page.locator("#" + operation.button).click();
      await f.page.waitForFunction(() =>
        document
          .querySelector("#message")
          ?.textContent?.includes("TEAM-READ-FAILED"),
      );
      assert.match(
        await f.page.locator("#message").innerText(),
        new RegExp(operation.success + ".*列表刷新失败"),
      );
      assert.equal(
        await f.page.locator("#" + operation.button).isDisabled(),
        true,
      );
      if (operation.button === "add-member")
        assert.equal(await f.page.locator("#member-password").inputValue(), "");
      else
        assert.equal(
          await f.page.locator("#member-password").inputValue(),
          "Unsent-member-password-123!",
        );
      await f.page.locator("#refresh-team").click();
      await f.page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent === "" &&
          !document.querySelector<HTMLButtonElement>("#refresh-team")?.disabled,
      );
      assert.equal(gets, 3);
      assert.equal(posts, 1);
      assert.equal(
        await f.page.locator("#member-email").inputValue(),
        operation.button === "add-member" ? "" : "unsent-member@example.test",
      );
      assert.equal(
        await f.page.locator("#member-password").inputValue(),
        operation.button === "add-member" ? "" : "Unsent-member-password-123!",
      );
      assert.equal(await f.page.locator("#member").inputValue(), f.target);
      assert.equal(await f.page.locator("#grant-site").inputValue(), "notes");
      assert.equal(await f.page.locator("#role").inputValue(), "editor");
    } finally {
      await f.context.close();
      await f.browser.close();
    }
  });
}

test("team page review: successful grant preserves unsent member draft and permission selection", async () => {
  const f = await teamPageFixture();
  try {
    await f.page.route("**/admin/api/grants", (r) =>
      r.fulfill({ json: { ok: true } }),
    );
    await f.open();
    await f.prepare();
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/operators"),
    );
    await f.page.locator("#grant").click();
    await (await response).finished();
    await f.settle();
    assert.equal(
      await f.page.locator("#member-email").inputValue(),
      "unsent-member@example.test",
    );
    assert.equal(
      await f.page.locator("#member-password").inputValue(),
      "Unsent-member-password-123!",
    );
    assert.equal(await f.page.locator("#grant-site").inputValue(), "notes");
    assert.equal(await f.page.locator("#role").inputValue(), "editor");
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("team page review: rejected creation preserves input and restores controls", async () => {
  const f = await teamPageFixture();
  try {
    await f.page.route("**/admin/api/operators", (r) =>
      r.request().method() === "POST"
        ? r.fulfill({ status: 403, json: { error: "TEAM-FORBIDDEN" } })
        : r.fulfill({ json: f.users }),
    );
    await f.open();
    await f.prepare();
    await f.page.locator("#add-member").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "TEAM-FORBIDDEN",
    );
    assert.equal(
      await f.page.locator("#member-password").inputValue(),
      "Unsent-member-password-123!",
    );
    for (const operation of teamOperations)
      assert.equal(
        await f.page.locator("#" + operation.button).isEnabled(),
        true,
      );
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("team page review: late disable response leaves the task view untouched", async () => {
  const f = await teamPageFixture();
  let release!: () => void,
    enter!: () => void,
    gets = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/operators", (route) => {
      gets++;
      return route.fulfill({ json: f.users });
    });
    await f.page.route("**/admin/api/operators/disable", async (route) => {
      enter();
      await gate;
      await route.fulfill({ json: { ok: true } });
    });
    await f.page.route("**/admin/api/tasks", (route) =>
      route.fulfill({
        json: {
          instances: [],
          eventFailures: [],
          events: [],
          github: [],
          mail: [],
          maintenance: [],
        },
      }),
    );
    await f.open();
    await f.page.locator("#disable").click();
    await entered;
    await f.page.evaluate(() => {
      location.hash = "tasks";
    });
    await f.page.getByRole("heading", { name: "运行任务" }).waitFor();
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/operators/disable"),
    );
    release();
    await (await response).finished();
    await f.settle();
    assert.equal(gets, 1);
    assert.equal(
      await f.page.getByRole("heading", { name: "运行任务" }).count(),
      1,
    );
    assert.equal(await f.page.locator("#message").innerText(), "");
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("team page review: manual refresh is exclusive and preserves inputs after read failure", async () => {
  const f = await teamPageFixture();
  let release!: () => void,
    enter!: () => void,
    gets = 0,
    posts = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  const errors: string[] = [];
  f.page.on("pageerror", (error) => errors.push(error.message));
  try {
    await f.page.route("**/admin/api/operators", async (route) => {
      gets++;
      if (gets === 2) {
        enter();
        await gate;
        await route.fulfill({
          status: 503,
          json: { error: "TEAM-REFRESH-FAILED" },
        });
      } else await route.fulfill({ json: f.users });
    });
    await f.page.route("**/admin/api/grants", (route) => {
      posts++;
      return route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.prepare();
    await f.page.locator("#refresh-team").evaluate((b: HTMLButtonElement) => {
      b.click();
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await entered;
    await f.page
      .locator("#grant")
      .evaluate((b: HTMLButtonElement) =>
        b.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
    await f.settle();
    assert.equal(gets, 2);
    assert.equal(posts, 0);
    assert.equal(await f.page.locator("#member-password").isDisabled(), true);
    release();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("TEAM-REFRESH-FAILED"),
    );
    assert.equal(await f.page.locator("#grant").isEnabled(), true);
    assert.equal(
      await f.page.locator("#member-password").inputValue(),
      "Unsent-member-password-123!",
    );
    await f.page.locator("#refresh-team").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "" &&
        !document.querySelector<HTMLButtonElement>("#refresh-team")?.disabled,
    );
    assert.equal(gets, 3);
    assert.equal(posts, 0);
    assert.equal(
      await f.page.locator("#member-email").inputValue(),
      "unsent-member@example.test",
    );
    assert.equal(await f.page.locator("#grant-site").inputValue(), "notes");
    assert.equal(await f.page.locator("#role").inputValue(), "editor");
    assert.deepEqual(errors, []);
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

async function overviewPageFixture() {
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
  const listing = [
    {
      id: "atlas",
      host: "atlas.example.test",
      active: true,
      state: "ready",
      center_site: null as string | null,
      revision: 0,
      config: { name: "Atlas" },
    },
  ];
  const payload = {
    id: "new-site",
    name: "新站点",
    origin: "https://new-site.example.test",
    centerSite: null,
  };
  await page.route("**/admin/api/me", (r) => r.fulfill({ json: admin }));
  await page.route("**/admin/api/sites", (r) => r.fulfill({ json: listing }));
  await page.route("**/admin/api/operators", (r) => r.fulfill({ json: [] }));
  const open = async () => {
    await page.goto(origins[3] + "/admin");
    await page.locator("#create").waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
  };
  const prepare = async () => {
    await page.locator("#site-id").fill(payload.id);
    await page.locator("#site-name").fill(payload.name);
    await page.locator("#site-origin").fill(payload.origin);
  };
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
  return { browser, context, page, listing, payload, open, prepare, settle };
}

test("overview review: pending creation freezes its payload and rejects duplicate dispatch", async () => {
  const f = await overviewPageFixture();
  let release!: () => void,
    enter!: () => void,
    posts = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/sites", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: f.listing });
        return;
      }
      posts++;
      assert.deepEqual(route.request().postDataJSON(), f.payload);
      enter();
      await gate;
      await route.fulfill({ json: { id: f.payload.id, state: "pending" } });
    });
    await f.open();
    await f.prepare();
    await f.page.locator("#create").evaluate((b: HTMLButtonElement) => {
      b.click();
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await entered;
    await f.settle();
    assert.equal(posts, 1);
    for (const id of ["site-id", "site-name", "site-origin"])
      assert.equal(await f.page.locator("#" + id).isDisabled(), true);
    release();
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("overview review: committed creation keeps acknowledgement on list failure and read-only recovery", async () => {
  const f = await overviewPageFixture();
  let posts = 0,
    gets = 0;
  try {
    await f.page.route("**/admin/api/sites", (route) => {
      if (route.request().method() === "POST") {
        posts++;
        return route.fulfill({ json: { id: f.payload.id, state: "pending" } });
      }
      gets++;
      return gets === 2
        ? route.fulfill({ status: 503, json: { error: "SITE-LIST-FAILED" } })
        : route.fulfill({ json: f.listing });
    });
    await f.open();
    await f.prepare();
    await f.page.locator("#create").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("SITE-LIST-FAILED"),
    );
    assert.match(
      await f.page.locator("#message").innerText(),
      /站点已创建.*列表刷新失败/,
    );
    assert.equal(await f.page.locator("#create").isDisabled(), true);
    assert.equal(await f.page.locator("#site-id").inputValue(), "");
    await f.page.locator("#refresh-sites").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "" &&
        !document.querySelector<HTMLButtonElement>("#refresh-sites")?.disabled,
    );
    assert.equal(posts, 1);
    assert.equal(gets, 3);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("overview review: successful creation renders new card without clearing acknowledgement", async () => {
  const f = await overviewPageFixture();
  try {
    await f.page.route("**/admin/api/sites", (route) => {
      if (route.request().method() === "POST") {
        f.listing.push({
          ...f.listing[0],
          id: f.payload.id,
          host: "new-site.example.test",
          center_site: "atlas",
          state: "pending",
          config: { name: f.payload.name },
        });
        return route.fulfill({ json: { id: f.payload.id, state: "pending" } });
      }
      return route.fulfill({ json: f.listing });
    });
    await f.open();
    await f.prepare();
    await f.page.locator("#create").click();
    await f.page.locator('.site-card[href="#site/new-site"]').waitFor();
    assert.match(await f.page.locator("#message").innerText(), /站点已创建/);
    assert.equal(await f.page.locator("#site-id").inputValue(), "");
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

for (const phase of ["post", "refresh"]) {
  test(`overview review: late creation ${phase} cannot reset another view's input`, async () => {
    const f = await overviewPageFixture();
    let release!: () => void,
      enter!: () => void,
      gets = 0;
    const gate = new Promise<void>((r) => (release = r)),
      entered = new Promise<void>((r) => (enter = r));
    try {
      await f.page.route("**/admin/api/sites", async (route) => {
        const post = route.request().method() === "POST";
        if (!post) gets++;
        if (
          (phase === "post" && post) ||
          (phase === "refresh" && !post && gets === 2)
        ) {
          enter();
          await gate;
        }
        await route.fulfill({
          json: post ? { id: f.payload.id, state: "pending" } : f.listing,
        });
      });
      await f.open();
      await f.prepare();
      await f.page.locator("#create").click();
      await entered;
      await f.page.evaluate(() => {
        location.hash = "team";
      });
      await f.page.locator("#member-email").fill("new-view-input@example.test");
      const response = f.page.waitForResponse(
        (r) =>
          r.url().endsWith("/sites") &&
          r.request().method() === (phase === "post" ? "POST" : "GET"),
      );
      release();
      await (await response).finished();
      await f.settle();
      assert.equal(
        await f.page.locator("#member-email").inputValue(),
        "new-view-input@example.test",
      );
      assert.equal(await f.page.locator("#message").innerText(), "");
    } finally {
      release();
      await f.context.close();
      await f.browser.close();
    }
  });
}

test("overview review: rejected creation preserves values and restores editing", async () => {
  const f = await overviewPageFixture();
  try {
    await f.page.route("**/admin/api/sites", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, json: { error: "SITE-ALREADY-EXISTS" } })
        : route.fulfill({ json: f.listing }),
    );
    await f.open();
    await f.prepare();
    await f.page.locator("#create").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "SITE-ALREADY-EXISTS",
    );
    assert.equal(await f.page.locator("#site-id").inputValue(), f.payload.id);
    assert.equal(await f.page.locator("#site-name").isEnabled(), true);
    assert.equal(await f.page.locator("#create").isEnabled(), true);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("overview review: bootstrap does not render editable routes before initial sites arrive", async () => {
  const f = await overviewPageFixture();
  let release!: () => void,
    enter!: () => void,
    operators = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/sites", async (route) => {
      enter();
      await gate;
      await route.fulfill({ json: f.listing });
    });
    await f.page.route("**/admin/api/operators", (route) => {
      operators++;
      return route.fulfill({ json: [] });
    });
    await f.page.goto(origins[3] + "/admin");
    await entered;
    await f.page.evaluate(() => {
      location.hash = "team";
    });
    await f.settle();
    assert.equal(operators, 0);
    assert.equal(await f.page.locator("#member-email").count(), 0);
    release();
    await f.page.locator("#member-email").waitFor();
    assert.equal(operators, 1);
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("overview review: manual refresh is exclusive, recovers and preserves the creation draft", async () => {
  const f = await overviewPageFixture();
  let release!: () => void,
    enter!: () => void,
    gets = 0,
    posts = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/sites", async (route) => {
      if (route.request().method() === "POST") {
        posts++;
        await route.fulfill({ json: { id: f.payload.id } });
        return;
      }
      gets++;
      if (gets === 2) {
        enter();
        await gate;
        await route.fulfill({
          status: 503,
          json: { error: "OVERVIEW-READ-FAILED" },
        });
      } else await route.fulfill({ json: f.listing });
    });
    await f.open();
    await f.prepare();
    await f.page.locator("#refresh-sites").evaluate((b: HTMLButtonElement) => {
      b.click();
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await entered;
    await f.page
      .locator("#create")
      .evaluate((b: HTMLButtonElement) =>
        b.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
    await f.settle();
    assert.equal(gets, 2);
    assert.equal(posts, 0);
    assert.equal(await f.page.locator("#site-name").isDisabled(), true);
    release();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("OVERVIEW-READ-FAILED"),
    );
    assert.equal(await f.page.locator("#create").isEnabled(), true);
    await f.page.locator("#refresh-sites").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "" &&
        !document.querySelector<HTMLButtonElement>("#refresh-sites")?.disabled,
    );
    assert.equal(gets, 3);
    assert.equal(posts, 0);
    assert.equal(await f.page.locator("#site-id").inputValue(), f.payload.id);
    assert.equal(
      await f.page.locator("#site-name").inputValue(),
      f.payload.name,
    );
    assert.equal(
      await f.page.locator("#site-origin").inputValue(),
      f.payload.origin,
    );
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("overview review: creation defaults to an independent account space", async () => {
  const f = await overviewPageFixture();
  try {
    await f.open();
    assert.equal(await f.page.locator("#center").count(), 0);
    assert.equal(await f.page.locator("#create").isEnabled(), true);
    assert.match(
      await f.page.locator("section.panel", { hasText: "创建新站点" }).innerText(),
      /独立账号空间/,
    );
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("overview review: site-scoped reader can refresh without a creation form", async () => {
  const f = await overviewPageFixture();
  const errors: string[] = [];
  f.page.on("pageerror", (error) => errors.push(error.message));
  try {
    await f.page.route("**/admin/api/me", (route) =>
      route.fulfill({ json: { ...admin, global_admin: false } }),
    );
    await f.page.goto(origins[3] + "/admin");
    await f.page.locator("#refresh-sites").waitFor();
    await f.page.waitForFunction(
      () => !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
    assert.equal(await f.page.locator("#create").count(), 0);
    const response = f.page.waitForResponse((r) => r.url().endsWith("/sites"));
    await f.page.locator("#refresh-sites").click();
    await (await response).finished();
    await f.settle();
    assert.equal(await f.page.locator(".site-card").count(), 1);
    assert.equal(await f.page.locator("#create").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

async function configPageFixture() {
  const f = await overviewPageFixture();
  const config = configSchema.parse({
    name: "Published config",
    template: "basic",
    locales: ["zh"],
  });
  const state = {
    config,
    draft: { ...config, name: "Stored draft" } as typeof config | null,
    revision: 1,
    draft_version: 2,
  };
  const site = { ...f.listing[0], origin: "https://atlas.example.test" };
  const history = [
    { revision: 0, config: { ...config, name: "Historical config" } },
  ];
  const response = () => ({
    site: { ...site, config: state.config },
    state,
    history,
  });
  await f.page.route("**/admin/api/sites/atlas", (route) =>
    route.fulfill({ json: response() }),
  );
  await f.page.route("**/admin/api/templates", (route) =>
    route.fulfill({ json: [{ id: "basic", name: "Basic" }] }),
  );
  const open = async () => {
    await f.page.goto(origins[3] + "/admin#site/atlas");
    await f.page.locator("#name").waitFor();
    await f.page.waitForFunction(
      () => !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
  };
  const prepare = async () => {
    await f.page.locator("#name").fill("Unsent local configuration");
    await f.page.locator("#replace").check();
  };
  const accept = (action: string, input: any) => {
    if (action === "save") {
      state.draft = input.snapshot.config;
      state.draft_version++;
    }
    if (action === "publish") {
      state.config = state.draft ?? state.config;
      state.draft = null;
      state.revision++;
      state.draft_version++;
    }
    if (action === "status") site.active = input.active;
    if (action === "rollback") {
      state.draft = history[0].config;
      state.draft_version++;
    }
  };
  return {
    ...f,
    config,
    state,
    site,
    history,
    response,
    open,
    prepare,
    accept,
  };
}
const configActions = [
  { path: "save", selector: "#save", success: "草稿已保存" },
  { path: "publish", selector: "#publish", success: "发布成功" },
  { path: "status", selector: "#toggle", success: "站点状态已更新" },
  { path: "rollback", selector: ".rollback", success: "历史修订已恢复为草稿" },
];
for (const action of configActions) {
  test(`config write review: pending ${action.path} prevents duplicate and competing actions`, async () => {
    const f = await configPageFixture();
    let release!: () => void,
      enter!: () => void,
      posts = 0;
    const gate = new Promise<void>((r) => (release = r)),
      entered = new Promise<void>((r) => (enter = r));
    try {
      await f.page.route(
        "**/admin/api/sites/atlas/" + action.path,
        async (route) => {
          posts++;
          enter();
          await gate;
          f.accept(action.path, route.request().postDataJSON());
          await route.fulfill({ json: { ok: true } });
        },
      );
      await f.open();
      await f.prepare();
      await f.page.locator(action.selector).evaluate((b: HTMLButtonElement) => {
        b.click();
        b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await entered;
      await f.settle();
      assert.equal(posts, 1);
      for (const other of configActions)
        assert.equal(await f.page.locator(other.selector).isDisabled(), true);
      assert.equal(await f.page.locator("#name").isDisabled(), true);
      assert.equal(await f.page.locator("#config").isDisabled(), true);
      release();
    } finally {
      release();
      await f.context.close();
      await f.browser.close();
    }
  });
  test(`config write review: committed ${action.path} keeps acknowledgement and recovers by reads`, async () => {
    const f = await configPageFixture();
    let gets = 0,
      posts = 0;
    try {
      await f.page.route("**/admin/api/sites/atlas", (route) => {
        gets++;
        return gets === 2
          ? route.fulfill({
              status: 503,
              json: { error: "CONFIG-READ-FAILED" },
            })
          : route.fulfill({ json: f.response() });
      });
      await f.page.route("**/admin/api/sites/atlas/" + action.path, (route) => {
        posts++;
        f.accept(action.path, route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      });
      await f.open();
      await f.prepare();
      await f.page.locator(action.selector).click();
      await f.page.waitForFunction(() =>
        document
          .querySelector("#message")
          ?.textContent?.includes("CONFIG-READ-FAILED"),
      );
      assert.match(
        await f.page.locator("#message").innerText(),
        new RegExp(action.success + ".*刷新失败"),
      );
      assert.equal(await f.page.locator(action.selector).isDisabled(), true);
      await f.page.locator("#refresh-config").click();
      await f.page.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>("#refresh-config")
            ?.disabled &&
          !document
            .querySelector("#message")
            ?.textContent?.includes("CONFIG-READ-FAILED"),
      );
      assert.equal(gets, 3);
      assert.equal(posts, 1);
      assert.equal(
        await f.page.locator("#name").inputValue(),
        "Unsent local configuration",
      );
      if (action.path !== "save")
        assert.match(
          await f.page.locator("#message").innerText(),
          /未保存.*保留/,
        );
    } finally {
      await f.context.close();
      await f.browser.close();
    }
  });
}
for (const action of configActions.filter((a) => a.path !== "save")) {
  test(`config write review: ${action.path} preserves unsent configuration and distinguishes it from server draft`, async () => {
    const f = await configPageFixture();
    try {
      await f.page.route("**/admin/api/sites/atlas/" + action.path, (route) => {
        f.accept(action.path, route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      });
      await f.open();
      await f.prepare();
      const response = f.page.waitForResponse((r) =>
        r.url().endsWith("/sites/atlas"),
      );
      await f.page.locator(action.selector).click();
      await (await response).finished();
      await f.settle();
      assert.equal(
        await f.page.locator("#name").inputValue(),
        "Unsent local configuration",
      );
      assert.match(
        await f.page.locator("#message").innerText(),
        /未保存.*保留/,
      );
      assert.equal(
        await f.page.locator("#replace").isChecked(),
        action.path === "status",
      );
      assert.notEqual(
        (f.state.draft ?? f.state.config).name,
        "Unsent local configuration",
      );
    } finally {
      await f.context.close();
      await f.browser.close();
    }
  });
}

test("config write review: rejected publish preserves input and reuses operation id on explicit retry", async () => {
  const f = await configPageFixture();
  const ids: string[] = [];
  try {
    await f.page.route("**/admin/api/sites/atlas/publish", (route) => {
      ids.push(route.request().postDataJSON().operationId);
      if (ids.length === 1)
        return route.fulfill({
          status: 409,
          json: { error: "CONFIG-CONFLICT" },
        });
      f.accept("publish", route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.prepare();
    await f.page.locator("#publish").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "CONFIG-CONFLICT",
    );
    assert.equal(
      await f.page.locator("#name").inputValue(),
      "Unsent local configuration",
    );
    assert.equal(await f.page.locator("#save").isEnabled(), true);
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/sites/atlas"),
    );
    await f.page.locator("#publish").click();
    await (await response).finished();
    await f.settle();
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("config write review: late rollback success cannot overwrite another view", async () => {
  const f = await configPageFixture();
  let release!: () => void,
    enter!: () => void,
    gets = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/sites/atlas", (route) => {
      gets++;
      return route.fulfill({ json: f.response() });
    });
    await f.page.route("**/admin/api/sites/atlas/rollback", async (route) => {
      enter();
      await gate;
      await route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.page.locator(".rollback").click();
    await entered;
    await f.page.evaluate(() => {
      location.hash = "team";
    });
    await f.page
      .locator("#member-email")
      .fill("kept-in-other-view@example.test");
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/atlas/rollback"),
    );
    release();
    await (await response).finished();
    await f.settle();
    assert.equal(gets, 1);
    assert.equal(
      await f.page.locator("#member-email").inputValue(),
      "kept-in-other-view@example.test",
    );
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("config write review: read recovery preserves incomplete JSON and explicit server load discards it only after success", async () => {
  const f = await configPageFixture();
  let gets = 0,
    release!: () => void,
    enter!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/sites/atlas", async (route) => {
      gets++;
      if (gets === 2) {
        await route.fulfill({
          status: 503,
          json: { error: "READ-RECOVERY-FAILED" },
        });
        return;
      }
      if (gets === 4) {
        enter();
        await gate;
      }
      await route.fulfill({ json: f.response() });
    });
    await f.open();
    await f.page.locator("summary").click();
    await f.page.locator("#config").fill('{"unfinished":');
    await f.page.locator("#refresh-config").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("READ-RECOVERY-FAILED"),
    );
    assert.equal(
      await f.page.locator("#config").inputValue(),
      '{"unfinished":',
    );
    assert.equal(await f.page.locator("#save").isEnabled(), true);
    const read = f.page.waitForResponse((r) =>
      r.url().endsWith("/sites/atlas"),
    );
    await f.page.locator("#refresh-config").click();
    await (await read).finished();
    await f.settle();
    assert.equal(
      await f.page.locator("#config").inputValue(),
      '{"unfinished":',
    );
    await f.page.locator("#load-server-config").click();
    await entered;
    assert.equal(
      await f.page.locator("#config").inputValue(),
      '{"unfinished":',
    );
    assert.equal(await f.page.locator("#save").isDisabled(), true);
    const loaded = f.page.waitForResponse((r) =>
      r.url().endsWith("/sites/atlas"),
    );
    release();
    await (await loaded).finished();
    await f.settle();
    assert.equal(await f.page.locator("#name").inputValue(), "Stored draft");
    assert.equal(
      JSON.parse(await f.page.locator("#config").inputValue()).name,
      "Stored draft",
    );
    assert.match(
      await f.page.locator("#message").innerText(),
      /已载入服务器配置/,
    );
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("config write review: late comparison cannot unlock controls held by a pending save", async () => {
  const f = await configPageFixture();
  let releaseCompare!: () => void,
    enterCompare!: () => void,
    releaseSave!: () => void,
    enterSave!: () => void;
  const compared = new Promise<void>((r) => (enterCompare = r)),
    comparing = new Promise<void>((r) => (releaseCompare = r));
  const saving = new Promise<void>((r) => (enterSave = r)),
    saved = new Promise<void>((r) => (releaseSave = r));
  try {
    await f.page.route("**/admin/api/sites/atlas/compare", async (route) => {
      enterCompare();
      await comparing;
      await route.fulfill({ json: { stale: false, changes: [] } });
    });
    await f.page.route("**/admin/api/sites/atlas/save", async (route) => {
      enterSave();
      await saved;
      f.accept("save", route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.prepare();
    await f.page.locator("summary").click();
    await f.page.locator("#compare").click();
    await compared;
    await f.page.locator("#save").click();
    await saving;
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/atlas/compare"),
    );
    releaseCompare();
    await (await response).finished();
    await f.settle();
    assert.equal(await f.page.locator("#compare").isDisabled(), true);
    assert.equal(await f.page.locator("#publish").isDisabled(), true);
    assert.equal(await f.page.locator("#name").isDisabled(), true);
    assert.equal(await f.page.locator("#diff").innerText(), "");
    releaseSave();
  } finally {
    releaseCompare();
    releaseSave();
    await f.context.close();
    await f.browser.close();
  }
});

test("config write review: status refresh preserves imported source versions instead of rebasing them", async () => {
  const f = await configPageFixture();
  const snapshot = {
    schemaVersion: 1,
    kind: "draft",
    siteId: "atlas",
    baseRevision: 0,
    sourceDraftVersion: 7,
    config: { ...f.config, name: "Imported local draft" },
  };
  let payload: any;
  try {
    await f.page.route("**/admin/api/sites/atlas/compare", (route) =>
      route.fulfill({ json: { stale: true, changes: [] } }),
    );
    await f.page.route("**/admin/api/sites/atlas/status", (route) => {
      f.accept("status", route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await f.page.route("**/admin/api/sites/atlas/save", (route) => {
      payload = route.request().postDataJSON();
      return route.fulfill({ status: 409, json: { error: "FILE-BASE-STALE" } });
    });
    await f.open();
    await f.page.locator("summary").click();
    await f.page.locator("#import").setInputFiles({
      name: "imported.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(snapshot)),
    });
    await f.page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>("#name")?.value ===
        "Imported local draft",
    );
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/sites/atlas"),
    );
    await f.page.locator("#toggle").click();
    await (await response).finished();
    await f.settle();
    assert.equal(
      await f.page.locator("#name").inputValue(),
      "Imported local draft",
    );
    await f.page.locator("#save").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "FILE-BASE-STALE",
    );
    assert.deepEqual(payload.snapshot, snapshot);
    assert.deepEqual(payload.expected, { revision: 1, draftVersion: 2 });
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

for (const action of configActions.filter((a) =>
  ["publish", "rollback"].includes(a.path),
)) {
  test(`config write review: clean ${action.path} shows the server result and advances expected versions`, async () => {
    const f = await configPageFixture();
    let payload: any;
    try {
      await f.page.route("**/admin/api/sites/atlas/" + action.path, (route) => {
        f.accept(action.path, route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      });
      await f.page.route("**/admin/api/sites/atlas/save", (route) => {
        payload = route.request().postDataJSON();
        return route.fulfill({
          status: 409,
          json: { error: "EXPECTED-VERSION-CAPTURE" },
        });
      });
      await f.open();
      const response = f.page.waitForResponse((r) =>
        r.url().endsWith("/sites/atlas"),
      );
      await f.page.locator(action.selector).click();
      await (await response).finished();
      await f.settle();
      assert.equal(
        await f.page.locator("#name").inputValue(),
        action.path === "publish" ? "Stored draft" : "Historical config",
      );
      assert.doesNotMatch(
        await f.page.locator("#message").innerText(),
        /未保存/,
      );
      await f.page.locator("#save").click();
      await f.page.waitForFunction(
        () =>
          document.querySelector("#message")?.textContent ===
          "EXPECTED-VERSION-CAPTURE",
      );
      assert.deepEqual(payload.expected, {
        revision: f.state.revision,
        draftVersion: f.state.draft_version,
      });
      assert.equal(payload.snapshot.baseRevision, f.state.revision);
    } finally {
      await f.context.close();
      await f.browser.close();
    }
  });
}

test("config write review: late export failure cannot replace a committed save recovery notice", async () => {
  const f = await configPageFixture();
  let release!: () => void,
    enter!: () => void,
    gets = 0;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/sites/atlas", (route) => {
      gets++;
      return gets === 2
        ? route.fulfill({ status: 503, json: { error: "SAVED-READ-FAILED" } })
        : route.fulfill({ json: f.response() });
    });
    await f.page.route("**/admin/api/sites/atlas/export", async (route) => {
      enter();
      await gate;
      await route.fulfill({ status: 503, json: { error: "OLD-EXPORT-ERROR" } });
    });
    await f.page.route("**/admin/api/sites/atlas/save", (route) => {
      f.accept("save", route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    await f.open();
    await f.prepare();
    await f.page.locator("#export").click();
    await entered;
    await f.page.locator("#save").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("SAVED-READ-FAILED"),
    );
    const notice = await f.page.locator("#message").innerText();
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/atlas/export"),
    );
    release();
    await (await response).finished();
    await f.settle();
    assert.equal(await f.page.locator("#message").innerText(), notice);
    assert.match(notice, /草稿已保存/);
    assert.equal(await f.page.locator("#save").isDisabled(), true);
    assert.equal(await f.page.locator("#refresh-config").isEnabled(), true);
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("config write review: editing while a published-config export waits still allows its download", async () => {
  const f = await configPageFixture();
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    entered = new Promise<void>((r) => (enter = r));
  try {
    await f.page.route("**/admin/api/sites/atlas/export", async (route) => {
      enter();
      await gate;
      await route.fulfill({
        json: {
          schemaVersion: 1,
          kind: "published",
          siteId: "atlas",
          baseRevision: f.state.revision,
          config: f.state.config,
        },
      });
    });
    await f.open();
    await f.page.locator("#export").click();
    await entered;
    await f.page.locator("#name").fill("Edited while exporting");
    const downloading = f.page.waitForEvent("download");
    release();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "atlas.json");
    assert.equal(
      await f.page.locator("#name").inputValue(),
      "Edited while exporting",
    );
  } finally {
    release();
    await f.context.close();
    await f.browser.close();
  }
});

test("config version consent review: refreshed shared draft invalidates old replacement consent", async () => {
  const f = await configPageFixture();
  let payload: any;
  try {
    await f.page.route("**/admin/api/sites/atlas/save", (route) => {
      payload = route.request().postDataJSON();
      return route.fulfill({
        status: 409,
        json: { error: "REPLACEMENT-REVIEW-REQUIRED" },
      });
    });
    await f.open();
    await f.prepare();
    f.state.draft = { ...f.config, name: "Another operator's new draft" };
    f.state.draft_version++;
    const response = f.page.waitForResponse((r) =>
      r.url().endsWith("/sites/atlas"),
    );
    await f.page.locator("#refresh-config").click();
    await (await response).finished();
    await f.settle();
    assert.equal(
      await f.page.locator("#name").inputValue(),
      "Unsent local configuration",
    );
    assert.equal(await f.page.locator("#replace").isChecked(), false);
    assert.match(
      await f.page.locator("#config-local-state").innerText(),
      /版本已更新.*重新比较/,
    );
    await f.page.locator("#save").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent ===
        "REPLACEMENT-REVIEW-REQUIRED",
    );
    assert.equal(payload.replace, false);
    assert.deepEqual(payload.expected, { revision: 1, draftVersion: 3 });
  } finally {
    await f.context.close();
    await f.browser.close();
  }
});

test("audit log is global for admins and scoped to granted sites for viewers", async () => {
  const global = await app.audit.list(admin, { limit: "5" });
  assert.ok(global.events.length > 0);
  assert.ok(global.events.every((event) => typeof event.action === "string"));
  const viewerId = await app.sites.operators.create(
    "audit-viewer@example.test",
    password,
  );
  await app.sites.operators.grant(admin, viewerId, "atlas", "viewer");
  const viewer = await app.sites.operators.current(
    new Headers({
      cookie:
        "network_operator=" +
        (await app.sites.operators.login("audit-viewer@example.test", password)),
    }),
  );
  assert.ok(viewer);
  const scoped = await app.audit.list(viewer, { site: "atlas", limit: "100" });
  assert.ok(scoped.events.length > 0);
  assert.ok(scoped.events.every((event) => event.site_id === "atlas"));
  await assert.rejects(app.audit.list(viewer, {}), /权限/);
  await assert.rejects(app.audit.list(viewer, { site: "notes" }), /权限/);
  await assert.rejects(app.audit.list(admin, { limit: "0" }));
  await assert.rejects(app.audit.list(admin, { site: "missing-site" }), /不存在/);
});
