import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import {
  availableParallelism,
  totalmem,
  platform,
  arch,
  tmpdir,
} from "node:os";
import { chromium, type Browser } from "@playwright/test";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";
import { Application } from "../../src/server/http.js";
import { backup, restore } from "../../scripts/backup.mjs";
import { Pool } from "pg";
import { join } from "node:path";
const exec = promisify(execFile);
const quantiles = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    Math.round(v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)] ?? 0);
  return {
    samples: v.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: at(1),
  };
};
test(
  "P5 reproducible 30-site / 100k-master / 300k-publication baseline with 20 browser clients",
  { timeout: 570000 },
  async () => {
    const pool = await database();
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(pool);
    await pool.query("CREATE EXTENSION pg_stat_statements");
    let nextChild: ReturnType<typeof fork> | undefined,
      worker: ReturnType<typeof fork> | undefined,
      browser: Browser | undefined,
      nextPort = 0;
    const key = randomBytes(32).toString("hex"),
      password = "P5-capacity-password-429!";
    const proxy = createServer(
      {
        key: await readFile(process.env.P0_TLS_KEY!),
        cert: await readFile(process.env.P0_TLS_CERT!),
      },
      (req, res) => {
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: nextPort,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (r) => {
            res.writeHead(r.statusCode!, r.headers);
            r.pipe(res);
          },
        );
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.on("aborted", () => upstream.destroy());
        req.pipe(upstream);
      },
    );
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const port = (proxy.address() as AddressInfo).port,
      hosts = process.env.P0_HOSTS!.split(",");
    const adminOrigin = `https://${hosts[3]}:${port}`;
    const origins = Array.from(
      { length: 30 },
      (_, i) => `https://site-${i}.${hosts[0]}:${port}`,
    );
    const app = new Application(pool, {
      defaultTemplate: "basic",
      key,
      adminOrigin,
      databaseUrl: process.env.P0_DATABASE_URL!,
      development: false,
    });
    const metrics: Record<string, number[]> = {},
      errors: string[] = [],
      rssSamples: number[] = [];
    let responses = 0,
      background = true;
    let sampler: ReturnType<typeof setInterval> | undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      P0_NEXT_TEST: "false",
      AUTH_ENCRYPTION_KEY: key,
      ADMIN_ORIGIN: adminOrigin,
      DATABASE_URL: process.env.P0_DATABASE_URL!,
      ALLOW_INSECURE_HTTP: "false",
      AUTH_REQUIRE_EMAIL: "false",
      SMTP_HOST: "",
      GITHUB_SYNC_TOKEN: "",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    try {
      const id = await app.sites.operators.create(
          "owner@example.test",
          password,
          true,
        ),
        actor = { id, email: "owner@example.test", global_admin: true };
      console.log("Capacity: creating 30 independent sites");
      for (let i = 0; i < 30; i++) {
        await app.sites.create(actor, {
          id: `site-${i}`,
          name: `Capacity ${i}`,
          origin: origins[i],
          centerSite: null,
        });
        await pool.query(
          "UPDATE site SET config=jsonb_set(config,'{locales}','[\"zh\",\"en\"]') WHERE id=$1",
          [`site-${i}`],
        );
        await pool.query(
          "UPDATE config_revision SET config=(SELECT config FROM site WHERE id=$1) WHERE site_id=$1",
          [`site-${i}`],
        );
        await app.auth.provision(`site-${i}`);
        if (i < 20) {
          const response = await app.respond(
            new Request(origins[i] + "/api/auth/sign-up/email", {
              method: "POST",
              headers: {
                host: new URL(origins[i]).host,
                origin: origins[i],
                "content-type": "application/json",
              },
              body: JSON.stringify({
                email: `reader-${i}@example.test`,
                name: "Reader",
                password,
              }),
            }),
          );
          assert.equal(response.status, 200, await response.text());
        }
      }
      console.log(
        "Capacity: loading 100,000 resources and 300,000 publications",
      );
      const seeded = performance.now();
      await pool.query(
        `INSERT INTO resource(id,version,data) SELECT 'resource-'||g,1,jsonb_build_object('kind','website','url','https://example.com/'||g,'source','Capacity fixture','translations',jsonb_build_object('zh',jsonb_build_object('title','项目 '||g,'description',repeat('开发者工具 ',20)),'en',jsonb_build_object('title','Project '||g,'description',repeat('developer productivity ',10)))) FROM generate_series(1,100000) g`,
      );
      await pool.query(
        "INSERT INTO resource_revision SELECT id,version,data FROM resource",
      );
      await pool.query(
        `INSERT INTO category(site_id,id,labels,rank) SELECT s.id,'category-'||g,jsonb_build_object('zh','分类 '||g,'en','Category '||g),g FROM site s CROSS JOIN generate_series(0,9)g`,
      );
      await pool.query(
        `INSERT INTO publication(site_id,resource_id,locale,slug,title,description,url,status,category_id,rank,version,source_version) SELECT 'site-'||((g-1+k*10)%30),'resource-'||g,CASE WHEN ((g-1)/30+k)%2=0 THEN 'zh' ELSE 'en' END,'resource-'||g,'Project '||g,repeat('developer productivity ',10),'https://example.com/'||g,'published','category-'||(g%10),g%100000,1,1 FROM generate_series(1,100000)g CROSS JOIN generate_series(0,2)k`,
      );
      await pool.query(
        "INSERT INTO publication_revision SELECT site_id,resource_id,locale,version,to_jsonb(p) FROM publication p",
      );
      await pool.query("ANALYZE");
      const seedMs = Math.round(performance.now() - seeded);
      const counts = (
        await pool.query(
          "SELECT (SELECT count(*)::int FROM site) sites,(SELECT count(*)::int FROM resource) resources,(SELECT count(*)::int FROM publication) publications,(SELECT count(DISTINCT locale)::int FROM publication) locales",
        )
      ).rows[0];
      assert.deepEqual(counts, {
        sites: 30,
        resources: 100000,
        publications: 300000,
        locales: 2,
      });
      const examples: { locale: string; slug: string }[] = [];
      for (let i = 0; i < 20; i++)
        examples.push(
          (
            await pool.query(
              "SELECT locale,slug FROM public_listing WHERE site_id=$1 AND locale='zh' LIMIT 1",
              [`site-${i}`],
            )
          ).rows[0],
        );
      nextChild = fork(
        new URL("../../p0/internal/next-server.ts", import.meta.url),
        {
          env,
          execArgv: ["--import", "tsx", "--max-old-space-size=2048"],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      nextChild.stdout?.on("data", (b) => process.stdout.write(b));
      nextChild.stderr?.on("data", (b) => process.stderr.write(b));
      const [message] = await Promise.race([
        once(nextChild, "message"),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Next production startup timeout")),
            60000,
          ).unref(),
        ),
      ]);
      nextPort = message.port;
      worker = fork(new URL("../../src/worker.ts", import.meta.url), {
        env,
        execArgv: ["--import", "tsx", "--max-old-space-size=1024"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      worker.stdout?.on("data", (b) => process.stdout.write(b));
      worker.stderr?.on("data", (b) => process.stderr.write(b));
      browser = await chromium.launch({
        headless: true,
        args: ["--host-resolver-rules=MAP *.test 127.0.0.1"],
      });
      const contexts = await Promise.all(
        Array.from({ length: 20 }, () =>
          browser!.newContext({ ignoreHTTPSErrors: true }),
        ),
      );
      const pages = await Promise.all(contexts.map((c) => c.newPage()));
      for (const page of pages) {
        page.setDefaultTimeout(30000);
        page.on("response", (r) => {
          responses++;
          if (r.status() >= 400)
            errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
        });
        page.on("pageerror", (e) => errors.push("browser: " + e.message));
      }
      sampler = setInterval(() => {
        if (nextChild?.pid)
          void exec("ps", ["-o", "rss=", "-p", String(nextChild.pid)])
            .then((r) => {
              const value = Number(r.stdout.trim());
              if (Number.isFinite(value)) rssSamples.push(value * 1024);
            })
            .catch(() => {});
      }, 500);
      await pool.query("SELECT pg_stat_statements_reset()");
      const timed = async (kind: string, fn: () => Promise<unknown>) => {
        const start = performance.now();
        try {
          return await fn();
        } finally {
          (metrics[kind] ??= []).push(performance.now() - start);
        }
      };
      let publisherFailure: unknown;
      const publisher = (async () => {
        let revision = 0,
          draftVersion = 0;
        while (background && revision < 5) {
          await timed("configuration-service-publish", async () => {
            const current = await app.sites.config(actor).read("site-0");
            revision = current.revision;
            draftVersion = current.draft_version;
            const snapshot = await app.sites.export(actor, "site-0");
            snapshot.config.tagline = "Capacity revision " + (revision + 1);
            draftVersion = await app.sites.save(actor, "site-0", snapshot, {
              revision,
              draftVersion,
            });
            revision = await app.sites.publish(
              actor,
              "site-0",
              { revision, draftVersion },
              randomUUID(),
            );
          });
          await new Promise((r) => setTimeout(r, 1000));
        }
        return revision;
      })().catch((error) => {
        publisherFailure = error;
        return 0;
      });
      const started = performance.now();
      for (const [kind, path] of [
        ["application-cold-list", "/zh/tools"],
        ["warm-list", "/zh/tools"],
        ["search", "/zh/tools?q=productivity"],
        ["detail", "detail"],
      ] as const) {
        console.log("Capacity: 20 browser clients, " + kind);
        await Promise.all(
          pages.map((page, i) =>
            timed(kind, async () => {
              const response = await page.goto(
                origins[i] +
                  (path === "detail"
                    ? `/${examples[i].locale}/tools/${examples[i].slug}`
                    : path),
                { waitUntil: "load" },
              );
              assert.equal(response?.status(), 200);
              assert.ok(await page.locator("h1").textContent());
            }),
          ),
        );
      }
      await Promise.all(
        pages.map((page, i) =>
          timed("public-login", async () => {
            const result = await page.evaluate(
              async ({ email, password }) => {
                const r = await fetch("/api/auth/sign-in/email", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ email, password }),
                });
                return {
                  status: r.status,
                  session: await (await fetch("/api/session")).json(),
                };
              },
              { email: `reader-${i}@example.test`, password },
            );
            assert.equal(result.status, 200);
            assert.ok(result.session.user_id);
          }),
        ),
      );
      background = false;
      const finalRevision = await publisher;
      if (publisherFailure) throw publisherFailure;
      await new Promise((r) => setTimeout(r, 5200));
      assert.equal(
        (
          await pages[0].evaluate(async () =>
            (await fetch("/api/config")).json(),
          )
        ).revision,
        finalRevision,
      );
      const delivery = (
        await pool.query(
          "SELECT revision FROM config_delivery WHERE site_id='site-0'",
        )
      ).rows[0]?.revision;
      assert.equal(delivery, finalRevision);
      const workerState = (
        await pool.query(
          "SELECT completed_at FROM maintenance_status WHERE name='worker'",
        )
      ).rows[0];
      assert.ok(workerState);
      const stats = (
        await pool.query(
          "SELECT sum(calls)::int calls,round(sum(total_exec_time)::numeric,2)::float8 execution_ms FROM pg_stat_statements",
        )
      ).rows[0];
      const memory = (
        await exec("sudo", [
          "-n",
          "docker",
          "exec",
          process.env.P0_CONTAINER!,
          "cat",
          "/sys/fs/cgroup/memory.peak",
        ])
      ).stdout.trim();
      const dbSize = (
        await pool.query(
          "SELECT pg_database_size(current_database())::text bytes",
        )
      ).rows[0].bytes;
      const summary = Object.fromEntries(
        Object.entries(metrics).map(([k, v]) => [k, quantiles(v)]),
      );
      const report = {
        measuredAt: new Date().toISOString(),
        fixture: counts,
        seedMs,
        clients: 20,
        durationMs: Math.round(performance.now() - started),
        environment: {
          node: process.version,
          platform: platform(),
          architecture: arch(),
          hostLogicalCpus: availableParallelism(),
          hostMemoryBytes: totalmem(),
          databaseLimits: { cpus: 4, memoryBytes: 6 * 1024 ** 3 },
          nextHeapLimitMiB: 2048,
          workerHeapLimitMiB: 1024,
          scope:
            "Next production + separate worker on uncapped shared host; PostgreSQL capped separately. Not a whole-deployment 4-vCPU/8-GiB certification; application-cold does not flush OS/PostgreSQL caches.",
        },
        latencies: summary,
        httpResponses: responses,
        errors,
        sql: stats,
        memory: {
          nextPeakSampledRssBytes: Math.max(0, ...rssSamples),
          databaseCgroupPeakBytes: Number(memory),
        },
        databaseBytes: Number(dbSize),
        configuration: { published: finalRevision, delivered: delivery },
        acceptance: {
          httpErrors: 0,
          browserErrors: 0,
          readP95Ms: 3000,
          loginP95Ms: 5000,
          configurationServiceP95Ms: 2000,
        },
        limitations: [
          "single short run, not a soak test",
          "2 supported locales tested; no third-locale claim",
          "login is local email/password; external providers and cross-domain shared login are covered separately",
          "GitHub external fetch excluded to avoid load on external services",
          "license/backup tests run separately",
          "filesystem SSD class and host co-tenancy not controlled",
        ],
      };
      console.log("Capacity: full-size encrypted backup and isolated restore");
      const scratch = await mkdtemp(
        join(tmpdir(), "navigation-capacity-backup-"),
      );
      let recovery;
      try {
        process.env.AUTH_ENCRYPTION_KEY = key;
        process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
        process.env.NAV_DOCKER_SUDO = "true";
        const options = {
          container: process.env.P0_CONTAINER!,
          database: "navigation_p0",
          user: "postgres",
          path: join(scratch, "backup"),
        };
        const saved = await backup(options),
          restored = await restore({
            ...options,
            database: "p5_capacity_restore",
          });
        const target = new URL(process.env.P0_DATABASE_URL!);
        target.pathname = "/p5_capacity_restore";
        const restoredPool = new Pool({ connectionString: target.toString() });
        try {
          const restoredCounts = (
            await restoredPool.query(
              "SELECT (SELECT count(*)::int FROM site) sites,(SELECT count(*)::int FROM resource) resources,(SELECT count(*)::int FROM publication) publications,(SELECT count(DISTINCT locale)::int FROM publication) locales",
            )
          ).rows[0];
          assert.deepEqual(restoredCounts, counts);
          await migrate(restoredPool);
          recovery = {
            backupMs: saved.elapsedMs,
            restoreMs: restored.elapsedMs,
            restoredCounts,
            scope:
              "full-size database restore and migration/count verification; excludes application/DNS/TLS cutover",
          };
        } finally {
          await restoredPool.end();
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      const completeReport = { ...report, recovery };
      await mkdir(".local", { recursive: true });
      await writeFile(
        ".local/p5-capacity.json",
        JSON.stringify(completeReport, null, 2) + "\n",
      );
      console.log(JSON.stringify(completeReport, null, 2));
      assert.deepEqual(errors, []);
      for (const kind of [
        "application-cold-list",
        "warm-list",
        "search",
        "detail",
      ])
        assert.ok(
          summary[kind].p95Ms <= 3000,
          `${kind} exceeds read p95 baseline`,
        );
      assert.ok(
        summary["public-login"].p95Ms <= 5000,
        "login exceeds baseline",
      );
      assert.ok(
        summary["configuration-service-publish"].p95Ms <= 2000,
        "configuration exceeds baseline",
      );
    } finally {
      background = false;
      if (sampler) clearInterval(sampler);
      await browser?.close();
      for (const child of [worker, nextChild])
        if (child && child.exitCode === null) {
          child.kill("SIGTERM");
          await Promise.race([
            once(child, "exit"),
            new Promise<void>((r) => {
              setTimeout(() => {
                child.kill("SIGKILL");
                r();
              }, 10000).unref();
            }),
          ]);
        }
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await app.close();
      await pool.end();
    }
  },
);
