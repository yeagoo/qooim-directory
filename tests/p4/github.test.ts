import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";
import { Application } from "../../src/server/http.js";
import { GithubClient, GithubError } from "../../src/server/github-client.js";
import { GithubWorker, GithubSources } from "../../src/server/github.js";
import type { Operator } from "../../src/server/operators.js";
let pool: Pool,
  app: Application,
  admin: Operator,
  editor: Operator,
  server: ReturnType<typeof createServer>,
  origins: string[],
  worker: GithubWorker,
  client: GithubClient,
  adminCookie: string;
const password = "P4-test-password-429!";
let mode = "ok",
  stars = 42,
  calls = 0,
  lastHeaders: Headers,
  lastUrl = "",
  description = "A useful open project <script>fixture</script>",
  remoteId = 123;
const repo = (name = "acme/editor") => ({
  id: remoteId,
  full_name: name,
  private: false,
  description,
  stargazers_count: stars,
  forks_count: 8,
  open_issues_count: 3,
  language: "TypeScript",
  license: { spdx_id: "MIT" },
  topics: ["editor", "tools"],
  archived: false,
  disabled: false,
  pushed_at: "2026-10-01T10:00:00Z",
});
before(async () => {
  await mkdir(".local", { recursive: true });
  pool = await database();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(pool);
  server = createServer(
    {
      key: await readFile(process.env.P0_TLS_KEY!),
      cert: await readFile(process.env.P0_TLS_CERT!),
    },
    async (req, res) => {
      try {
        if (req.url?.startsWith("/repos/")) {
          calls++;
          lastHeaders = new Headers(req.headers as Record<string, string>);
          lastUrl = req.url;
          if (mode === "rate") {
            res.writeHead(429, { "retry-after": "120" }).end();
            return;
          }
          if (mode === "missing") {
            res.writeHead(404).end();
            return;
          }
          if (mode === "redirect") {
            res
              .writeHead(301, { location: "https://untrusted.invalid/private" })
              .end();
            return;
          }
          if (mode === "304") {
            res.writeHead(304).end();
            return;
          }
          res.setHeader("content-type", "application/json");
          res.setHeader("etag", '"repo-' + stars + '"');
          const data = repo(req.url.slice("/repos/".length));
          if (mode === "private") data.private = true;
          if (mode === "large") {
            res.end(JSON.stringify({ ...data, extra: "x".repeat(300000) }));
            return;
          }
          res.end(JSON.stringify(data));
          return;
        }
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
        res.writeHead(500).end("Test transport failed");
      }
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  origins = process.env.P0_HOSTS!.split(",").map((h) => `https://${h}:${port}`);
  app = new Application(pool, {
    key: randomBytes(32).toString("hex"),
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
  const editorId = await app.sites.operators.create(
    "editor@example.test",
    password,
  );
  editor = { id: editorId, email: "editor@example.test", global_admin: false };
  for (const [index, id] of ["atlas", "notes", "library"].entries())
    await app.sites.create(admin, {
      id,
      name: id,
      origin: origins[index],
      centerSite: null,
    });
  await app.sites.operators.grant(admin, editorId, "atlas", "editor");
  await modules("atlas", true);
  await modules("notes", true);
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    return fetch(origins[2] + url.pathname, options);
  };
  client = new GithubClient(transport, "TEST-GITHUB-TOKEN");
  worker = new GithubWorker(pool, client);
  adminCookie =
    "network_operator=" +
    (await app.sites.operators.login(admin.email, password));
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await app?.close();
  await pool?.end();
});
beforeEach(async () => {
  mode = "ok";
  stars = 42;
  remoteId = 123;
  await pool.query(
    "UPDATE github_budget SET next_at=now()-interval '1 second'",
  );
});
async function modules(site: string, enabled: boolean) {
  const state = await app.sites.config(admin).read(site),
    snapshot = await app.sites.export(admin, site);
  snapshot.config.locales = ["en"];
  snapshot.config.modules = enabled
    ? ["directory", "opensource"]
    : ["directory"];
  const draft = await app.sites.save(admin, site, snapshot, {
    revision: state.revision,
    draftVersion: state.draft_version,
  });
  await app.sites.publish(admin, site, {
    revision: state.revision,
    draftVersion: draft,
  });
  app.catalog.invalidate(site);
}
async function source(resourceId: string, repository = "acme/" + resourceId) {
  return app.github.save(admin, {
    siteId: "atlas",
    resourceId,
    repository,
    expectedVersion: 0,
  });
}
async function sync(s: { id: string }) {
  await app.github.enqueue(admin, s.id, randomUUID());
  await pool.query(
    "UPDATE github_budget SET next_at=now()-interval '1 second'",
  );
  return worker.runOnce();
}
async function latest(s: { id: string }) {
  return (await app.github.detail(admin, s.id)).candidates.find(
    (c) => c.status === "pending",
  );
}
async function approve(
  s: { id: string },
  fields = [
    "project",
    "url",
    "source",
    "translations.en.title",
    "translations.en.description",
  ],
  decision = "accept",
) {
  const detail = await app.github.detail(admin, s.id),
    candidate = detail.candidates.find((c) => c.status === "pending");
  assert.ok(candidate);
  return app.content.reviewGithub(admin, {
    candidateId: candidate.id,
    expectedCandidateVersion: candidate.version,
    expectedResourceVersion: detail.current?.version ?? 0,
    decision,
    fields,
  });
}
async function publish(
  site: string,
  resource: string,
  version: number,
  published = 0,
  draft = 0,
) {
  const next = await app.content.stage(admin, site, resource, "en", {
    candidate: {
      resourceVersion: version,
      slug: resource,
      overrides: { title: site + " curated title" },
    },
    expected: { published, draft },
  });
  return app.content.publish(admin, site, resource, "en", {
    expected: { published, draft: next },
    operationId: randomUUID(),
  });
}

test("P4 fixed GitHub API produces an unpublished review candidate and never exposes the sync token", async () => {
  const s = await source("project-one", "Acme/Editor");
  assert.equal(await sync(s), "done");
  assert.equal(lastUrl, "/repos/acme/editor");
  assert.equal(lastHeaders.get("authorization"), "Bearer TEST-GITHUB-TOKEN");
  assert.equal(lastHeaders.get("x-github-api-version"), "2026-03-10");
  const detail = await app.github.detail(admin, s.id);
  assert.equal(detail.current, undefined);
  assert.equal(detail.candidates.length, 1);
  assert.equal(detail.candidates[0].data.project.stars, 42);
  assert.ok(!JSON.stringify(detail).includes("TEST-GITHUB-TOKEN"));
  const ctx = await app.catalog.resolve(new URL(origins[0]).host);
  assert.equal((await app.catalog.browse(ctx, { locale: "en" })).total, 0);
  const applied = await approve(s);
  assert.equal(applied.version, 1);
  assert.equal((await app.catalog.browse(ctx, { locale: "en" })).total, 0);
  await publish("atlas", "project-one", 1);
  await publish("notes", "project-one", 1);
  assert.equal(
    (await app.catalog.detail(ctx, "en", "project-one")).project?.stars,
    42,
  );
  const response = await app.respond(
    new Request(origins[0] + "/en/tools/project-one", {
      headers: { host: new URL(origins[0]).host },
    }),
  );
  const html = await response.text();
  assert.ok(html.includes("★ 42"));
  assert.ok(!html.includes("<script>fixture</script>"));
});

test("P4 source updates are frozen until each site republishes; selected fields preserve manual content", async () => {
  const s = (await app.github.list(admin)).find(
    (s) => s.resource_id === "project-one",
  );
  const old = (await app.github.detail(admin, s.id)).current!;
  const data = structuredClone(old.data!);
  data.translations.en!.title = "Manual English";
  data.translations.zh = { title: "人工中文", description: "保留人工说明" };
  await app.content.saveResource(admin, {
    id: "project-one",
    expectedVersion: 1,
    data,
    public: true,
    internalNote: "PRIVATE-NOTE",
  });
  stars = 91;
  assert.equal(await sync(s), "done");
  const current = (await app.github.detail(admin, s.id)).current!;
  assert.equal(current.version, 3);
  assert.equal(current.data!.translations.en!.title, "Manual English");
  assert.equal(current.data!.translations.zh!.description, "保留人工说明");
  assert.equal(current.internal_note, "PRIVATE-NOTE");
  assert.equal(
    (await app.github.detail(admin, s.id)).candidates.filter(
      (candidate) => candidate.status === "pending",
    ).length,
    0,
  );
  const a = await app.catalog.resolve(new URL(origins[0]).host),
    b = await app.catalog.resolve(new URL(origins[1]).host);
  // Stats are the explicit exception to the publication freeze: both
  // published projections update without another review/publish cycle.
  assert.equal(
    (await app.catalog.detail(a, "en", "project-one")).project?.stars,
    91,
  );
  assert.equal(
    (await app.catalog.detail(b, "en", "project-one")).project?.stars,
    91,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT action FROM audit_event WHERE site_id='atlas' AND action='github.stats' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0]?.action,
    "github.stats",
  );
});

test("P4 conditional 304 and equal metadata do not duplicate candidates", async () => {
  const s = await source("conditional");
  await sync(s);
  const count = (await app.github.detail(admin, s.id)).candidates.length;
  mode = "304";
  await sync(s);
  assert.equal(lastHeaders.get("if-none-match"), '"repo-42"');
  mode = "ok";
  await sync(s);
  assert.equal((await app.github.detail(admin, s.id)).candidates.length, count);
});

test("P4 manual queue requests are idempotent even when coalesced into another open task", async () => {
  const s = await source("coalesced"),
    one = randomUUID(),
    two = randomUUID();
  const first = await app.github.enqueue(admin, s.id, one),
    same = await app.github.enqueue(admin, s.id, two);
  assert.equal(same.id, first.id);
  await worker.runOnce();
  assert.equal((await app.github.enqueue(admin, s.id, two)).id, first.id);
  assert.equal((await app.github.enqueue(admin, s.id, one)).status, "done");
});

test("P4 rate limits create durable provider cooldown shared by restarted workers", async () => {
  const s = await source("limited");
  mode = "rate";
  await sync(s);
  const task = (await app.github.detail(admin, s.id)).tasks[0];
  assert.equal(task.status, "pending");
  assert.equal(task.error_code, "rate_limited");
  const before = calls;
  assert.equal(await new GithubWorker(pool, client).runOnce(), "idle");
  assert.equal(calls, before);
  assert.ok(
    (
      await pool.query(
        "SELECT next_at>now()+interval '100 seconds' AS blocked FROM github_budget",
      )
    ).rows[0].blocked,
  );
  await pool.query(
    "UPDATE github_task SET available_at=now()-interval '1 second' WHERE id=$1",
    [task.id],
  );
  await pool.query(
    "UPDATE github_budget SET next_at=now()-interval '1 second'",
  );
  mode = "ok";
  assert.equal(await new GithubWorker(pool, client).runOnce(), "done");
});

test("P4 private, redirected, missing, oversized and replacement repositories fail without changing masters", async () => {
  for (const bad of ["private", "redirect", "missing", "large"]) {
    const s = await source("bad-" + bad);
    mode = bad;
    assert.equal(await sync(s), "failed");
    const detail = await app.github.detail(admin, s.id);
    assert.equal(detail.tasks[0].status, "failed");
    assert.equal(detail.candidates.length, 0);
    assert.equal(detail.current, undefined);
  }
  mode = "ok";
  const s = await source("replacement");
  await sync(s);
  await approve(s);
  remoteId = 999;
  assert.equal(await sync(s), "failed");
  assert.equal(
    (await app.github.detail(admin, s.id)).tasks[0].error_code,
    "repository_replaced",
  );
  assert.equal(
    (await app.github.detail(admin, s.id)).current!.data!.project!.repoId,
    "123",
  );
  await assert.rejects(client.repository("https://private.invalid/path"));
  await assert.rejects(client.repository("acme/.."));
});

test("P4 lost leases reject stale success/failure and permit one durable retry after restart", async () => {
  const s = await source("lease");
  await app.github.enqueue(admin, s.id, randomUUID());
  const stale = await worker.claim();
  assert.ok(stale);
  await pool.query(
    "UPDATE github_task SET lease_until=now()-interval '1 second' WHERE id=$1",
    [stale.id],
  );
  const result = await client.repository(stale.repository);
  assert.equal(await worker.complete(stale, result), false);
  assert.equal(
    await worker.fail(stale, new GithubError("network_failure", 30)),
    false,
  );
  await pool.query(
    "UPDATE github_budget SET next_at=now()-interval '1 second'",
  );
  const replacement = await new GithubWorker(pool, client).claim();
  assert.ok(replacement);
  assert.notEqual(replacement.lease_token, stale.lease_token);
  assert.equal(await worker.complete(replacement, result), true);
  assert.equal(await worker.complete(stale, result), false);
  assert.equal((await app.github.detail(admin, s.id)).candidates.length, 1);
});

test("P4 disabling a module blocks queued and in-flight effects and all public projections", async () => {
  await app.content.saveResource(admin, {
    id: "general-website",
    expectedVersion: 0,
    data: {
      url: "https://example.com",
      translations: {
        en: {
          title: "General website",
          description: "Independent of project module",
        },
      },
    },
    public: true,
  });
  await publish("atlas", "general-website", 1);
  const s = await source("paused");
  await app.github.enqueue(admin, s.id, randomUUID());
  await modules("atlas", false);
  assert.equal(await worker.claim(), undefined);
  await assert.rejects(app.github.enqueue(admin, s.id, randomUUID()));
  const ctx = await app.catalog.resolve(new URL(origins[0]).host);
  assert.equal((await app.catalog.browse(ctx, { locale: "en" })).total, 1);
  await assert.rejects(app.catalog.detail(ctx, "en", "project-one"));
  assert.equal((await app.catalog.entries(ctx)).length, 1);
  assert.equal(
    (await app.catalog.detail(ctx, "en", "general-website")).project,
    null,
  );
  await modules("atlas", true);
  const job = await worker.claim();
  assert.ok(job);
  const result = await client.repository(job.repository);
  await modules("atlas", false);
  assert.equal(await worker.complete(job, result), false);
  assert.equal((await app.github.detail(admin, s.id)).candidates.length, 0);
  await modules("atlas", true);
});

test("P4 source edits cancel old tasks/candidates and global-only writes reject site editors", async () => {
  const s = await source("edited");
  await sync(s);
  await app.github.enqueue(admin, s.id, randomUUID());
  await app.github.save(admin, {
    siteId: "atlas",
    resourceId: "edited",
    repository: "acme/edited",
    expectedVersion: 1,
    enabled: false,
  });
  const detail = await app.github.detail(admin, s.id);
  assert.ok(detail.tasks.some((t) => t.status === "cancelled"));
  assert.ok(detail.candidates.every((c) => c.status === "superseded"));
  await assert.rejects(app.github.list(editor));
  await assert.rejects(
    app.github.save(editor, {
      siteId: "atlas",
      resourceId: "forbidden",
      repository: "acme/forbidden",
      expectedVersion: 0,
    }),
  );
  await assert.rejects(approve(s));
});

test("P4 candidate review has optimistic concurrency and exact retry idempotency", async () => {
  const s = await source("review");
  await sync(s);
  const candidate = await latest(s);
  const input = {
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
  };
  const first = await app.content.reviewGithub(admin, input);
  assert.deepEqual(await app.content.reviewGithub(admin, input), first);
  await assert.rejects(
    app.content.reviewGithub(admin, { ...input, fields: ["project"] }),
  );
  description = "Changed content for concurrency";
  await sync(s);
  const next = await latest(s);
  const previous = (await app.github.detail(admin, s.id)).current!;
  await app.content.saveResource(admin, {
    id: "review",
    expectedVersion: 1,
    data: previous.data,
    public: true,
    internalNote: "concurrent",
  });
  await assert.rejects(
    app.content.reviewGithub(admin, {
      ...input,
      candidateId: next.id,
      expectedResourceVersion: 1,
      fields: ["project"],
    }),
  );
  await approve(s, ["project"]);
  assert.equal(
    (await app.github.detail(admin, s.id)).current!.internal_note,
    "concurrent",
  );
});

test("P4 failed review rolls back master revision, audit and candidate status atomically", async () => {
  const s = await source("atomic");
  await sync(s);
  await pool.query(
    "CREATE FUNCTION reject_github_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='github.candidate.review' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_github_review BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION reject_github_review()",
  );
  try {
    await assert.rejects(approve(s));
    const detail = await app.github.detail(admin, s.id);
    assert.equal(detail.current, undefined);
    assert.equal(detail.candidates[0].status, "pending");
  } finally {
    await pool.query(
      "DROP TRIGGER reject_github_review ON audit_event; DROP FUNCTION reject_github_review()",
    );
  }
  assert.equal((await approve(s)).version, 1);
});

test("P4 periodic scheduling coalesces work and exhaustion ends a run without an immediate reschedule loop", async () => {
  const s = await source("scheduled");
  await worker.schedule();
  await worker.schedule();
  let detail = await app.github.detail(admin, s.id);
  assert.equal(detail.tasks.filter((t) => t.status === "pending").length, 1);
  const task = detail.tasks[0];
  await pool.query("UPDATE github_task SET attempts=5 WHERE id=$1", [task.id]);
  assert.equal(await worker.runOnce(), "idle");
  await worker.schedule();
  detail = await app.github.detail(admin, s.id);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].status, "failed");
});

test("P4 browser edits a source, refreshes candidates and reviews selected fields through the operator API", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  try {
    await context.addCookies([
      {
        name: "network_operator",
        value: adminCookie.split("=")[1],
        url: origins[3] + "/admin",
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    // A refresh intentionally retains an inert old DOM while fetching details.
    // Delay the response so this readiness boundary is exercised deterministically.
    await page.route("**/admin/api/github/sources/*", async (route) => {
      if (route.request().method() === "GET")
        await new Promise((resolve) => setTimeout(resolve, 150));
      await route.continue();
    });
    await page.goto(origins[3] + "/admin#github");
    await page.locator("#github-resource").fill("browser-project");
    await page.locator("#github-repository").fill("acme/browser-project");
    await page.locator("#source-save").click();
    await page.waitForSelector("#source-sync");
    await page.locator("#source-sync").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#message")
          ?.textContent?.includes("同步已排队") &&
        !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
    await page.waitForSelector("#source-refresh");
    await pool.query(
      "UPDATE github_budget SET next_at=now()-interval '1 second'",
    );
    assert.equal(await worker.runOnce(), "done");
    await page.locator("#source-refresh").click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#workspace")?.hasAttribute("aria-busy") &&
        document.querySelector("#github-candidate")?.children.length === 2,
    );
    const option = await page
      .locator("#github-candidate option")
      .nth(1)
      .getAttribute("value");
    await page.locator("#github-candidate").selectOption(option!);
    await page.locator("#candidate-accept").click();
    await page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("已更新主档"),
    );
    await page.waitForFunction(
      () => !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
    assert.equal(
      await page.locator("#source-content-link").getAttribute("href"),
      "#content/atlas",
    );
    await page.screenshot({
      path: ".local/p4-github-admin.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: ".local/p4-github-mobile.png",
      fullPage: true,
    });
    const s = (await app.github.list(admin)).find(
      (s) => s.resource_id === "browser-project",
    );
    assert.equal((await app.github.detail(admin, s.id)).current!.version, 1);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("P4 CLI saves, queues, exports and reviews through the same authorized services", async () => {
  const dir = await mkdtemp(join(tmpdir(), "navigation-p4-cli-"));
  async function run(...args: string[]) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", ...args],
        {
          env: {
            ...process.env,
            DATABASE_URL: process.env.P0_DATABASE_URL,
            AUTH_ENCRYPTION_KEY: app.config.key,
            ADMIN_ORIGIN: origins[3],
            OPERATOR_EMAIL: admin.email,
            OPERATOR_PASSWORD: password,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve(out) : reject(new Error(err)),
      );
    });
  }
  try {
    const file = join(dir, "source.json");
    await writeFile(
      file,
      JSON.stringify({
        siteId: "atlas",
        resourceId: "cli-project",
        repository: "acme/cli-project",
        expectedVersion: 0,
      }),
    );
    const saved = JSON.parse(await run("github-source-save", file));
    const operation = randomUUID();
    const task = JSON.parse(await run("github-sync", saved.id, operation));
    assert.equal(
      JSON.parse(await run("github-sync", saved.id, operation)).id,
      task.id,
    );
    await pool.query(
      "UPDATE github_budget SET next_at=now()-interval '1 second'",
    );
    assert.equal(await worker.runOnce(), "done");
    const detail = JSON.parse(await run("github-source", saved.id));
    const candidate = detail.candidates[0];
    const review = join(dir, "review.json");
    await writeFile(
      review,
      JSON.stringify({
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
      }),
    );
    assert.equal(JSON.parse(await run("github-review", review)).version, 1);
    assert.ok(
      JSON.parse(await run("github-sources")).some(
        (s: { id: string }) => s.id === saved.id,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P4 concurrent workers create one candidate; database failure rolls back candidate, cursor and acknowledgement", async () => {
  const s = await source("worker-atomic");
  await app.github.enqueue(admin, s.id, randomUUID());
  const jobs = await Promise.all([
    worker.claim(),
    new GithubWorker(pool, client).claim(),
  ]);
  assert.equal(jobs.filter(Boolean).length, 1);
  const job = jobs.find(Boolean)!;
  const result = await client.repository(job.repository);
  await pool.query(
    "CREATE FUNCTION reject_github_done() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result='candidate_created' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_github_done BEFORE UPDATE ON github_task FOR EACH ROW EXECUTE FUNCTION reject_github_done()",
  );
  try {
    await assert.rejects(worker.complete(job, result));
    const detail = await app.github.detail(admin, s.id);
    assert.equal(detail.candidates.length, 0);
    assert.equal(detail.source.etag, null);
    assert.equal(detail.tasks[0].status, "processing");
  } finally {
    await pool.query(
      "DROP TRIGGER reject_github_done ON github_task; DROP FUNCTION reject_github_done()",
    );
  }
  assert.equal(await worker.complete(job, result), true);
  assert.equal((await app.github.detail(admin, s.id)).candidates.length, 1);
});

test("P4 a delayed GitHub page response cannot replace a later operator navigation", async () => {
  const browser = await chromium.launch(),
    context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const pending = new Promise<void>((r) => (started = r));
  try {
    await context.addCookies([
      {
        name: "network_operator",
        value: adminCookie.split("=")[1],
        url: origins[3] + "/admin",
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await page.route("**/admin/api/github/sources?*", async (route) => {
      started();
      await gate;
      await route.continue();
    });
    await page.goto(origins[3] + "/admin#github");
    await pending;
    await page.evaluate(() => (location.hash = "#resources"));
    await page.waitForSelector("#resource-id");
    const response = page.waitForResponse((r) =>
      r.url().includes("/github/sources?"),
    );
    release();
    await response;
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#resource-id").count(), 1);
    assert.equal(await page.locator("#github-repository").count(), 0);
    assert.equal(
      await page.locator("#workspace").evaluate((el: HTMLElement) => el.inert),
      false,
    );
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test("P4 interrupted response streams retry, while malformed metadata is a terminal validation error", async () => {
  const interrupted = new GithubClient(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            controller.error(new Error("Fixture connection interrupted"));
          },
        }),
      ),
    "",
  );
  await assert.rejects(
    interrupted.repository("acme/editor"),
    (error: unknown) =>
      error instanceof GithubError &&
      error.code === "network_failure" &&
      error.retrySeconds === 30,
  );
  const malformed = new GithubClient(async () => new Response("{not-json"), "");
  await assert.rejects(
    malformed.repository("acme/editor"),
    (error: unknown) =>
      error instanceof GithubError &&
      error.code === "invalid_repository" &&
      error.retrySeconds === null,
  );
});

async function githubInteractionFixture() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "network_operator",
      value: adminCookie.split("=")[1],
      url: origins[3] + "/admin",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  const source = {
    id: randomUUID(),
    site_id: "atlas",
    resource_id: "fixture-project",
    repository: "acme/editor",
    interval_seconds: 86400,
    enabled: true,
    site_active: true,
    module_enabled: true,
    version: 1,
  };
  const candidate = {
    id: randomUUID(),
    version: 1,
    base_version: 1,
    status: "pending",
    created_at: "2026-10-20",
    data: { project: { stars: 42 } },
  };
  const detail = {
    source,
    current: { version: 1, data: { project: { stars: 1 } } },
    candidates: [candidate],
    tasks: [],
  };
  let failRead = false;
  await page.route("**/admin/api/me", (r) => r.fulfill({ json: admin }));
  await page.route("**/admin/api/sites", (r) =>
    r.fulfill({ json: [{ id: "atlas", config: { name: "Atlas" } }] }),
  );
  await page.route("**/admin/api/github/**", (r) => {
    if (r.request().method() !== "GET")
      return r.fulfill({ json: { id: source.id } });
    if (failRead)
      return r.fulfill({ status: 503, json: { error: "fixture read failed" } });
    return r.fulfill({
      json: r.request().url().includes("?page=") ? [source] : detail,
    });
  });
  const ready = () =>
    page.waitForFunction(
      () => !document.querySelector("#workspace")?.hasAttribute("aria-busy"),
    );
  const open = async () => {
    await page.goto(origins[3] + "/admin#github");
    await page.locator(".source-edit").click();
    await page.locator("#source-sync").waitFor();
    await ready();
    await page.locator("#github-candidate").selectOption(candidate.id);
  };
  return {
    page,
    source,
    candidate,
    detail,
    ready,
    open,
    fail: (value: boolean) => {
      failRead = value;
    },
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
for (const operation of [
  { button: "source-save", path: "/sources", success: "来源已保存" },
  { button: "source-sync", path: "/sources/ID/sync", success: "同步已排队" },
  { button: "candidate-accept", path: "/review", success: "已更新主档" },
  { button: "candidate-reject", path: "/review", success: "已拒绝候选" },
]) {
  test(`github interaction review: ${operation.button} freezes competing writes and recovers committed reads`, async () => {
    const f = await githubInteractionFixture();
    let release!: () => void,
      enter!: () => void,
      posts = 0;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      entered = new Promise<void>((r) => {
        enter = r;
      });
    try {
      await f.open();
      await f.page.route(
        "**/admin/api/github" + operation.path.replace("ID", f.source.id),
        async (r) => {
          if (r.request().method() === "GET") return r.fallback();
          posts++;
          enter();
          await gate;
          f.fail(true);
          await r.fulfill({ json: { id: f.source.id } });
        },
      );
      await f.page.locator("#" + operation.button).click();
      await entered;
      assert.equal(
        await f.page.locator("#github-repository").isDisabled(),
        true,
      );
      for (const id of [
        "source-save",
        "source-sync",
        "candidate-accept",
        "candidate-reject",
      ])
        assert.equal(await f.page.locator("#" + id).isDisabled(), true, id);
      release();
      await f.page.waitForFunction(() =>
        document
          .querySelector("#message")
          ?.textContent?.includes("fixture read failed"),
      );
      assert.match(
        await f.page.locator("#message").innerText(),
        new RegExp(operation.success),
      );
      assert.equal(await f.page.locator("#source-save").isDisabled(), true);
      f.fail(false);
      await f.page.locator("#github-reload").click();
      await f.ready();
      assert.equal(await f.page.locator("#source-save").isDisabled(), false);
      assert.equal(posts, 1);
    } finally {
      release();
      await f.close();
    }
  });
}
test("github interaction review: refresh keeps unsaved source and original optimistic version", async () => {
  const f = await githubInteractionFixture();
  try {
    await f.open();
    await f.page.locator("#github-repository").fill("acme/unsaved");
    f.source.version = 2;
    await f.page.locator("#source-refresh").click();
    await f.ready();
    assert.equal(
      await f.page.locator("#github-repository").inputValue(),
      "acme/unsaved",
    );
    let submitted: Record<string, unknown> | undefined;
    await f.page.route("**/admin/api/github/sources", async (r) => {
      submitted = r.request().postDataJSON();
      await r.fulfill({ status: 409, json: { error: "version conflict" } });
    });
    await f.page.locator("#source-save").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "version conflict",
    );
    assert.equal(submitted?.expectedVersion, 1);
    await f.page.locator("#github-load-source").click();
    await f.ready();
    assert.equal(
      await f.page.locator("#github-repository").inputValue(),
      "acme/editor",
    );
  } finally {
    await f.close();
  }
});
for (const changed of ["none", "source", "candidate", "resource"]) {
  test(`github interaction review: candidate consent after ${changed} version refresh`, async () => {
    const f = await githubInteractionFixture();
    try {
      await f.open();
      await f.page.locator('.github-field[value="url"]').check();
      if (changed === "source") f.source.version++;
      if (changed === "candidate") f.candidate.version++;
      if (changed === "resource") f.detail.current.version++;
      await f.page.locator("#source-refresh").click();
      await f.ready();
      assert.equal(
        await f.page.locator("#github-candidate").inputValue(),
        changed === "none" ? f.candidate.id : "",
      );
      if (changed === "none")
        assert.equal(
          await f.page.locator('.github-field[value="url"]').isChecked(),
          true,
        );
    } finally {
      await f.close();
    }
  });
}

test("github interaction review: created source recovery reads returned identity without creating twice", async () => {
  const f = await githubInteractionFixture();
  let posts = 0;
  try {
    await f.open();
    await f.page.locator("#source-new").click();
    await f.ready();
    await f.page.locator("#github-resource").fill("new-project");
    await f.page.locator("#github-repository").fill("acme/new");
    await f.page.route("**/admin/api/github/sources", async (r) => {
      posts++;
      f.fail(true);
      await r.fulfill({ json: { id: f.source.id } });
    });
    await f.page.locator("#source-save").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#message")
        ?.textContent?.includes("fixture read failed"),
    );
    assert.match(await f.page.locator("#message").innerText(), /来源已保存/);
    f.fail(false);
    await f.page.locator("#github-reload").click();
    await f.ready();
    assert.equal(await f.page.locator("#source-sync").count(), 1);
    assert.equal(
      await f.page.locator("#github-resource").inputValue(),
      f.source.resource_id,
    );
    assert.equal(posts, 1);
  } finally {
    await f.close();
  }
});
test("github interaction review: failed sync retries operation identity and preserves unsaved source", async () => {
  const f = await githubInteractionFixture();
  const operations: string[] = [];
  try {
    await f.open();
    await f.page.locator("#github-repository").fill("acme/unsent");
    await f.page.route(
      "**/admin/api/github/sources/" + f.source.id + "/sync",
      async (r) => {
        operations.push(r.request().postDataJSON().operationId);
        await r.fulfill(
          operations.length === 1
            ? { status: 503, json: { error: "retry fixture" } }
            : { json: {} },
        );
      },
    );
    await f.page.locator("#source-sync").click();
    await f.page.waitForFunction(
      () => document.querySelector("#message")?.textContent === "retry fixture",
    );
    await f.page.locator("#source-sync").click();
    await f.page.waitForFunction(() =>
      document.querySelector("#message")?.textContent?.includes("同步已排队"),
    );
    await f.ready();
    assert.equal(operations.length, 2);
    assert.equal(operations[0], operations[1]);
    assert.equal(
      await f.page.locator("#github-repository").inputValue(),
      "acme/unsent",
    );
  } finally {
    await f.close();
  }
});
