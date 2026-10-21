import { spawn, execFileSync } from "node:child_process";
import { request } from "node:https";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const id = "navigation-p1-" + randomUUID().slice(0, 8),
  dir = await mkdtemp(join(tmpdir(), "navigation-p1-"));
const { createServer } = await import("node:net");
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const tlsPort = probe.address().port;
await new Promise((r) => probe.close(r));
const { firefox } = await import("@playwright/test");
const envFile = join(dir, "env");
const password = randomBytes(24).toString("base64url");
await writeFile(
  envFile,
  `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}\nAUTH_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nADMIN_ORIGIN=https://admin.localhost:${tlsPort}\nALLOW_INSECURE_HTTP=false\nOPERATOR_EMAIL=owner@example.test\nOPERATOR_PASSWORD=${password}\nSEED_DEMO=true\nDEMO_ORIGINS=https://atlas.localhost:${tlsPort},https://notes.localhost:${tlsPort},https://library.localhost:${tlsPort}\nAPP_PORT=0\nDEMO_TLS_PORT=${tlsPort}\nIMAGE_TAG=${process.env.P1_DOCKER_IMAGE ?? id}\nPROXY_TRUST_TOKEN=${randomBytes(32).toString("hex")}\nSMTP_HOST=mailpit\nSMTP_PORT=1025\nSMTP_ALLOW_INSECURE=true\nMAIL_FROM=accounts@example.test\nAUTH_REQUIRE_EMAIL=true\n`,
  { mode: 0o600 },
);
const mailOverlay = join(dir, "mail.yaml");
await writeFile(
  mailOverlay,
  `services:
  mailpit:
    image: navigation-network:${process.env.P1_DOCKER_IMAGE ?? id}
    entrypoint: [node, --import, tsx, scripts/test-mail-server.ts]
    restart: "no"
    healthcheck: {disable: true}
`,
);
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", "docker", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(output.slice(-5000))),
    );
  });
}
const compose = (...args) =>
  run([
    "compose",
    "-f",
    "compose.yaml",
    "-f",
    "compose.demo.yaml",
    "-f",
    mailOverlay,
    "--env-file",
    envFile,
    "-p",
    id,
    ...args,
  ]);
let created = false;
try {
  created = true;
  console.log("Building isolated Docker installation");
  await compose(
    "up",
    "-d",
    ...(process.env.P1_DOCKER_IMAGE ? [] : ["--build"]),
  );
  await compose("cp", "proxy:/trust/root.crt", join(dir, "root.crt"));
  const ca = await readFile(join(dir, "root.crt"));
  const port = tlsPort;
  const call = (host, path, body, cookie) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          hostname: "127.0.0.1",
          servername:
            host.split(":")[0] === "unknown.invalid"
              ? "atlas.localhost"
              : host.split(":")[0],
          ca,
          port,
          path,
          method: data ? "POST" : "GET",
          headers: {
            host,
            origin: `https://admin.localhost:${tlsPort}`,
            ...(data
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(data),
                }
              : {}),
            ...(cookie ? { cookie } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              text: Buffer.concat(chunks).toString(),
              bytes: Buffer.concat(chunks),
              contentLength: res.headers["content-length"],
              cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
            }),
          );
        },
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  async function wait(fn, timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (await fn()) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Docker readiness deadline exceeded");
  }
  await wait(
    async () =>
      (await call(`admin.localhost:${tlsPort}`, "/health")).status === 200,
  );
  const source = await call(`atlas.localhost:${tlsPort}`, "/source.tar.gz");
  assert.equal(source.status, 200);
  assert.equal(source.contentLength, String(source.bytes.length));
  const archive = join(dir, "source.tar.gz");
  await writeFile(archive, source.bytes, { mode: 0o600 });
  const archiveEntries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n").map(name => name.replace(/^\.\//, ""));
  for (const required of ["LICENSE", "SOURCE-MANIFEST.json", "scripts/backup.mjs", "src/server/http.ts"]) assert.ok(archiveEntries.includes(required));
  for (const forbidden of [".env", "docs/PROJECT-BACKGROUND.md", "task_plan.md", "findings.md", "progress.md"]) assert.ok(!archiveEntries.includes(forbidden));
  assert.ok(!archiveEntries.some(name => name.startsWith(".local/") || name.startsWith("node_modules/")));
  assert.equal((await call("unknown.invalid", "/source.tar.gz")).status, 404);
  assert.ok((await call(`atlas.localhost:${tlsPort}`, "/")).text.includes("/source.tar.gz"));
  console.log("Docker source download contains corresponding build/test sources and excludes local secrets");
  const login = await call(`admin.localhost:${tlsPort}`, "/admin/api/login", {
    email: "owner@example.test",
    password,
  });
  assert.equal(login.status, 200);
  const cookie = login.cookie;
  assert.ok(cookie);
  const sites = await call(
    `admin.localhost:${tlsPort}`,
    "/admin/api/sites",
    undefined,
    cookie,
  );
  assert.equal(JSON.parse(sites.text).length, 3);
  for (const host of [
    `atlas.localhost:${tlsPort}`,
    `notes.localhost:${tlsPort}`,
    `library.localhost:${tlsPort}`,
  ])
    assert.equal((await call(host, "/")).status, 200);
  assert.equal((await call("unknown.invalid", "/")).status, 404);
  const adminHost = `admin.localhost:${tlsPort}`;
  const resourceData = {
    url: "https://example.com/docker",
    translations: {
      zh: {
        title: "Docker content snapshot",
        description: "A persistent content snapshot",
      },
    },
  };
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/resources",
        {
          id: "docker-content",
          expectedVersion: 0,
          data: resourceData,
          public: true,
          internalNote: "docker-private",
        },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/content/atlas/docker-content/zh/stage",
        {
          candidate: { resourceVersion: 1, slug: "docker-content" },
          expected: { published: 0, draft: 0 },
        },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/content/atlas/docker-content/zh/publish",
        { expected: { published: 0, draft: 1 }, operationId: randomUUID() },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/resources",
        {
          id: "docker-content",
          expectedVersion: 1,
          data: {
            ...resourceData,
            translations: {
              zh: {
                title: "Unpublished master update",
                description: "A later master",
              },
            },
          },
          public: true,
        },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    JSON.parse(
      (await call(`atlas.localhost:${tlsPort}`, "/api/items/zh/docker-content"))
        .text,
    ).title,
    "Docker content snapshot",
  );
  console.log(
    "Content master, frozen site publication and public detail passed",
  );
  console.log(
    "Empty database, HTTPS routing and operator login passed; verifying shared browser login",
  );
  let readerCookie;
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    page.on("requestfailed", (req) =>
      console.error(
        "Browser transport:",
        new URL(req.url()).pathname,
        req.failure()?.errorText,
      ),
    );
    page.on("response", (res) => {
      if (res.status() >= 400)
        console.error(
          "Browser response:",
          new URL(res.url()).pathname,
          res.status(),
        );
    });
    page.setDefaultTimeout(15000);
    await page.goto(`https://notes.localhost:${tlsPort}/login`);
    await page.locator("button").click();
    await page.waitForURL(`https://atlas.localhost:${tlsPort}/login?**`);
    await page.locator("#email").fill("docker-reader@example.test");
    await page.locator("#password").fill(password);
    await page.locator("#register").click();
    try {
      await page.waitForFunction(() =>
        document.querySelector("#message")?.textContent?.includes("请验证邮箱"),
      );
      let verification;
      await wait(async () => {
        const messages = JSON.parse(
          await compose(
            "exec",
            "-T",
            "web",
            "node",
            "-e",
            "fetch('http://mailpit:8025/messages').then(r=>r.text()).then(t=>process.stdout.write(t))",
          ),
        );
        verification = messages.find(
          (m) => m.to === "docker-reader@example.test",
        )?.url;
        return !!verification;
      });
      await page.goto(verification);
      await page.waitForURL(`https://atlas.localhost:${tlsPort}/login?**`);
      await page.locator("#email").fill("docker-reader@example.test");
      await page.locator("#password").fill(password);
      await page.locator("button").filter({ hasText: "登录" }).first().click();
      await page.waitForURL(`https://notes.localhost:${tlsPort}/`);
    } catch (error) {
      const current = new URL(page.url());
      console.error(
        "Shared login stopped at:",
        current.origin + current.pathname,
        "error:",
        current.searchParams.get("error"),
        "message:",
        await page
          .locator("#message")
          .textContent()
          .catch(() => ""),
      );
      throw error;
    }
    assert.ok(
      (await page.evaluate(() => fetch("/api/session").then((r) => r.json())))
        .email,
    );
    await page.locator("button.favorite").first().click();
    await page.waitForFunction(
      () =>
        document.querySelector("#message")?.textContent === "已加入本站收藏。",
    );
    assert.equal(
      (
        await page.evaluate(() =>
          fetch("/api/me/favorites").then((r) => r.json()),
        )
      ).total,
      1,
    );
    readerCookie = (await context.cookies(`https://notes.localhost:${tlsPort}`))
      .map((c) => c.name + "=" + c.value)
      .join("; ");
  } finally {
    await context.close();
    await browser.close();
  }
  console.log(
    "Shared browser login passed; verifying process and database recovery",
  );
  await compose("stop", "worker");
  const exported = JSON.parse(
    (
      await call(
        `admin.localhost:${tlsPort}`,
        "/admin/api/sites/atlas/export",
        undefined,
        cookie,
      )
    ).text,
  );
  exported.config.name = "Docker durable publication";
  exported.config.modules = ["directory", "opensource"];
  exported.config.locales = ["zh", "en"];
  exported.config.template = "editorial";
  exported.config.templateParams = { accent: "indigo" };
  assert.equal(
    (
      await call(
        `admin.localhost:${tlsPort}`,
        "/admin/api/sites/atlas/save",
        {
          snapshot: exported,
          expected: { revision: 0, draftVersion: 0 },
          replace: false,
        },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `admin.localhost:${tlsPort}`,
        "/admin/api/sites/atlas/publish",
        {
          expected: { revision: 0, draftVersion: 1 },
          operationId: randomUUID(),
        },
        cookie,
      )
    ).status,
    200,
  );
  const githubSource = await call(
    adminHost,
    "/admin/api/github/sources",
    {
      siteId: "atlas",
      resourceId: "docker-github",
      repository: "acme/docker-project",
      expectedVersion: 0,
    },
    cookie,
  );
  assert.equal(githubSource.status, 200);
  const githubId = JSON.parse(githubSource.text).id;
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/github/sources/" + githubId + "/sync",
        { operationId: randomUUID() },
        cookie,
      )
    ).status,
    200,
  );
  await compose(
    "exec",
    "-T",
    "web",
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    "import {database} from './src/server/database.ts';import {GithubWorker} from './src/server/github.ts';import {GithubClient} from './src/server/github-client.ts';const pool=database();try{const client=new GithubClient((url,options)=>{const parsed=new URL(String(url));if(parsed.origin!=='https://api.github.com')throw new Error('Unexpected provider');return fetch('http://mailpit:8025'+parsed.pathname,options)},'');if(await new GithubWorker(pool,client).runOnce()!=='done')throw new Error('Sync failed');}finally{await pool.end();}",
  );
  const githubDetail = JSON.parse(
    (
      await call(
        adminHost,
        "/admin/api/github/sources/" + githubId,
        undefined,
        cookie,
      )
    ).text,
  );
  assert.equal(githubDetail.candidates.length, 1);
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/github/review",
        {
          candidateId: githubDetail.candidates[0].id,
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
        },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/content/atlas/docker-github/en/stage",
        {
          candidate: { resourceVersion: 1, slug: "docker-github" },
          expected: { published: 0, draft: 0 },
        },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/content/atlas/docker-github/en/publish",
        { expected: { published: 0, draft: 1 }, operationId: randomUUID() },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        adminHost,
        "/admin/api/github/sources",
        {
          siteId: "atlas",
          resourceId: "docker-github",
          repository: "acme/docker-project",
          enabled: false,
          expectedVersion: 1,
        },
        cookie,
      )
    ).status,
    200,
  );
  console.log(
    "GitHub candidate, manual review and frozen project publication passed with an owned API fixture",
  );
  await compose("restart", "web");
  await wait(
    async () =>
      (await call(`admin.localhost:${tlsPort}`, "/health")).status === 200,
  );
  assert.equal(
    JSON.parse((await call(`atlas.localhost:${tlsPort}`, "/api/config")).text)
      .config.name,
    "Docker durable publication",
  );
  assert.equal(
    (
      await call(
        `admin.localhost:${tlsPort}`,
        "/admin/api/me",
        undefined,
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    JSON.parse(
      (await call(`atlas.localhost:${tlsPort}`, "/api/items/zh/docker-content"))
        .text,
    ).title,
    "Docker content snapshot",
  );
  assert.equal(
    JSON.parse(
      (
        await call(
          `notes.localhost:${tlsPort}`,
          "/api/me/favorites",
          undefined,
          readerCookie,
        )
      ).text,
    ).total,
    1,
  );
  const templatePage = await call(`atlas.localhost:${tlsPort}`, "/");
  assert.match(templatePage.text, /template-editorial/);
  assert.match(templatePage.text, /accent-indigo/);
  assert.equal(
    JSON.parse(
      (await call(`atlas.localhost:${tlsPort}`, "/api/items/en/docker-github"))
        .text,
    ).project.stars,
    42,
  );
  await compose("start", "worker");
  await wait(async () => {
    const t = JSON.parse(
      (
        await call(
          `admin.localhost:${tlsPort}`,
          "/admin/api/tasks",
          undefined,
          cookie,
        )
      ).text,
    );
    return (
      t.events.some((e) => e.status === "done" && e.count >= 1) &&
      t.maintenance.some((m) => m.name === "worker")
    );
  });
  await compose("stop", "db");
  assert.equal(
    (await call(`atlas.localhost:${tlsPort}`, "/api/config")).status,
    503,
  );
  await compose("start", "db");
  await wait(
    async () =>
      (await call(`admin.localhost:${tlsPort}`, "/health")).status === 200,
  );
  assert.equal((await call(`atlas.localhost:${tlsPort}`, "/")).status, 200);
  console.log(
    "Docker acceptance passed: empty database, three sites, HTTPS shared browser login, operator login, persistent configuration/template/content/favorites/session, SMTP verification, GitHub project persistence, worker restart, database recovery",
  );
} catch (error) {
  console.error("Docker acceptance failed:", error.message);
  console.error(
    await compose(
      "logs",
      "--no-color",
      "--tail",
      "60",
      "init",
      "web",
      "worker",
      "proxy",
    ).catch(() => ""),
  );
  process.exitCode = 1;
} finally {
  if (created)
    await compose("down", "-v", "--remove-orphans").catch(() => {
      console.error("Owned Docker project cleanup failed: " + id);
      process.exitCode = 1;
    });
  await rm(dir, { recursive: true, force: true });
}
