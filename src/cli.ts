import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { database } from "./server/database.js";
import { settings } from "./server/settings.js";
import { migrate } from "./server/migrate.js";
import { Application } from "./server/http.js";
import { runMaintenance } from "./server/maintenance.js";
import { reseal } from "./server/reseal.js";
const pool = database(),
  config = settings();
const app = new Application(pool, config);
const [command, ...args] = process.argv.slice(2);
let sessionHeaders: Headers | undefined;
try {
  if (command === "migrate") {
    await migrate(pool);
    console.log("Database migrations applied");
  } else if (command === "bootstrap") {
    const email = process.env.OPERATOR_EMAIL,
      password = process.env.OPERATOR_PASSWORD;
    if (!email || !password)
      throw new Error("OPERATOR_EMAIL and OPERATOR_PASSWORD required");
    if (!(await pool.query("SELECT 1 FROM operator_user LIMIT 1")).rowCount) {
      await app.sites.operators.create(email, password, true);
      console.log("Initial operator created");
    } else console.log("Operator already exists; credentials unchanged");
  } else {
    const email = process.env.OPERATOR_EMAIL,
      password = process.env.OPERATOR_PASSWORD;
    if (!email || !password) throw new Error("Operator credentials required");
    const token = await app.sites.operators.login(email, password);
    sessionHeaders = new Headers({ cookie: "network_operator=" + token });
    const actor = await app.sites.operators.current(sessionHeaders);
    if (command === "seed") {
      const base = new URL(config.adminOrigin);
      const origins = (
        process.env.DEMO_ORIGINS ??
        `${base.protocol}//atlas.localhost:${base.port || 8443},${base.protocol}//notes.localhost:${base.port || 8443},${base.protocol}//library.localhost:${base.port || 8443}`
      ).split(",");
      if (origins.length !== 3)
        throw new Error("DEMO_ORIGINS requires three origins");
      for (const [index, id] of ["atlas", "notes", "library"].entries()) {
        const existing = (
          await pool.query(
            "SELECT origin FROM auth_instance WHERE site_id=$1",
            [id],
          )
        ).rows[0];
        if (existing && existing.origin !== origins[index])
          throw new Error("Demo origin conflicts with existing site");
        if (!existing)
          await app.sites.create(actor, {
            id,
            name: ["灵感地图", "开发札记", "资源书房"][index],
            origin: origins[index],
            centerSite: index === 1 ? "atlas" : null,
            legacyShared: index === 1,
          });
        if (!(await app.auth.provision(id)))
          throw new Error(
            "Demo account provisioning failed; inspect task status",
          );
        const resourceId = "sample-" + id;
        const existingResource = (
          await pool.query(
            "SELECT version,public,internal_note FROM resource WHERE id=$1",
            [resourceId],
          )
        ).rows[0];
        if (!existingResource || existingResource.version === 0) {
          await app.content.saveResource(actor, {
            id: resourceId,
            expectedVersion: 0,
            public: existingResource?.public ?? true,
            internalNote: existingResource?.internal_note ?? "",
            data: {
              url: "https://example.com/" + id,
              source: "demo",
              translations: {
                zh: {
                  title: ["设计与灵感精选", "开发者学习笔记", "值得收藏的资源"][
                    index
                  ],
                  description: "这是一个示例资源，可以在内容后台编辑并发布。",
                },
                en: {
                  title: [
                    "Design inspiration",
                    "Developer notes",
                    "Useful resources",
                  ][index],
                  description:
                    "A sample resource managed independently by this site.",
                },
              },
            },
          });
        }
        const publication = (
          await pool.query(
            "SELECT version FROM publication WHERE site_id=$1 AND resource_id=$2 AND locale='zh'",
            [id, resourceId],
          )
        ).rows[0];
        const draft = (
          await pool.query(
            "SELECT 1 FROM content_draft WHERE site_id=$1 AND resource_id=$2 AND locale='zh'",
            [id, resourceId],
          )
        ).rowCount;
        if ((!publication || publication.version === 0) && !draft) {
          await app.content.stage(actor, id, resourceId, "zh", {
            candidate: { resourceVersion: 1, slug: "welcome" },
            expected: { published: 0, draft: 0 },
          });
          await app.content.publish(actor, id, resourceId, "zh", {
            expected: { published: 0, draft: 1 },
            operationId: randomUUID(),
          });
        }
      }
      console.log("Three example sites ready");
    } else if (command === "github-source-save") {
      console.log(
        JSON.stringify(
          await app.github.save(
            actor,
            JSON.parse(await readFile(args[0], "utf8")),
          ),
        ),
      );
    } else if (command === "github-sources") {
      console.log(
        JSON.stringify(
          await app.github.list(actor, Number(args[0] ?? 1)),
          null,
          2,
        ),
      );
    } else if (command === "github-source") {
      console.log(
        JSON.stringify(await app.github.detail(actor, args[0]), null, 2),
      );
    } else if (command === "github-sync") {
      console.log(
        JSON.stringify(
          await app.github.enqueue(actor, args[0], args[1] ?? randomUUID()),
        ),
      );
    } else if (command === "github-review") {
      console.log(
        JSON.stringify(
          await app.content.reviewGithub(
            actor,
            JSON.parse(await readFile(args[0], "utf8")),
          ),
        ),
      );
    } else if (command === "site-limit") {
      console.log(JSON.stringify(await app.limits.get(actor, args[0]), null, 2));
    } else if (command === "site-limit-set") {
      console.log(
        JSON.stringify(
          await app.limits.save(actor, {
            site: args[0],
            ...JSON.parse(await readFile(args[1], "utf8")),
          }),
        ),
      );
    } else if (command === "retention-run") {
      await app.sites.operators.require(actor);
      console.log(
        JSON.stringify(
          await runMaintenance(pool, {
            mediaRoot: config.mediaRoot,
            policy: config.retention,
            force: true,
          }),
        ),
      );
    } else if (command === "re-seal") {
      // Key rotation: run with the new AUTH_ENCRYPTION_KEY and the old one listed in
      // AUTH_ENCRYPTION_KEY_PREVIOUS; repeat until "failed" is 0 everywhere.
      await app.sites.operators.require(actor);
      console.log(JSON.stringify(await reseal(pool, config.key), null, 2));
    } else if (command === "visitor-list") {
      console.log(
        JSON.stringify(
          await app.visitors.list(actor, { site: args[0], q: args[1] ?? "" }),
          null,
          2,
        ),
      );
    } else if (command === "visitor-ban") {
      if (!["true", "false", undefined].includes(args[2]))
        throw new Error("Usage: visitor-ban SITE USER_ID [true|false]");
      console.log(
        JSON.stringify(await app.visitors.ban(actor, args[0], args[1], args[2] !== "false")),
      );
    } else if (command === "visitor-anonymize") {
      console.log(JSON.stringify(await app.visitors.anonymize(actor, args[0], args[1])));
    } else if (command === "audit-export") {
      // JSON lines of every audit event before the given date (oldest first),
      // for archiving before RETENTION_AUDIT_DAYS pruning.
      await app.sites.operators.require(actor);
      const before = new Date(args[0] ?? "");
      if (Number.isNaN(before.getTime()))
        throw new Error("Usage: audit-export YYYY-MM-DD");
      let after = 0;
      for (;;) {
        const { rows } = await pool.query(
          `SELECT e.id,e.actor_id,u.email AS actor_email,e.site_id,e.action,e.detail,e.created_at
             FROM audit_event e LEFT JOIN operator_user u ON u.id=e.actor_id
            WHERE e.created_at<$1 AND e.id>$2 ORDER BY e.id LIMIT 1000`,
          [before, after],
        );
        for (const row of rows) process.stdout.write(JSON.stringify(row) + "\n");
        if (rows.length < 1000) break;
        after = Number(rows[rows.length - 1].id);
      }
    } else if (command === "auth-provider-set") {
      console.log(
        JSON.stringify(
          await app.auth.providers.set(
            actor,
            args[0],
            JSON.parse(await readFile(args[1], "utf8")),
          ),
        ),
      );
    } else if (command === "auth-provider-check") {
      console.log(
        JSON.stringify(
          await app.auth.providers.inspect(
            actor,
            args[0],
            JSON.parse(await readFile(args[1], "utf8")),
          ),
          null,
          2,
        ),
      );
    } else if (command === "auth-provider-list") {
      console.log(
        JSON.stringify(await app.auth.providers.list(actor, args[0]), null, 2),
      );
    } else if (command === "resources-export")
      console.log(
        JSON.stringify(
          await app.content.exportResources(actor, "", Number(args[0] ?? 1)),
          null,
          2,
        ),
      );
    else if (command === "resources-import" || command === "resources-check")
      console.log(
        JSON.stringify(
          await app.content.importResources(
            actor,
            JSON.parse(await readFile(args[0], "utf8")),
            command === "resources-import",
          ),
          null,
          2,
        ),
      );
    else if (command === "content-stage")
      console.log(
        await app.content.stage(
          actor,
          args[0],
          args[1],
          args[2],
          JSON.parse(await readFile(args[3], "utf8")),
        ),
      );
    else if (command === "content-publish")
      console.log(
        await app.content.publish(actor, args[0], args[1], args[2], {
          expected: { published: Number(args[3]), draft: Number(args[4]) },
          operationId: args[5] ?? randomUUID(),
        }),
      );
    else if (command === "auth-upgrade") {
      await app.sites.operators.require(actor);
      await pool.query(
        "UPDATE auth_instance SET state='pending',attempts=0,retry_at=now() WHERE site_id=$1",
        [args[0]],
      );
      if (!(await app.auth.provision(args[0])))
        throw new Error(
          "Authentication migration pending or failed; inspect tasks",
        );
      console.log(
        "Authentication schema checked; identity and secrets retained",
      );
    } else if (command === "export")
      console.log(
        JSON.stringify(
          await app.sites.export(actor, args[0], args[1] === "draft"),
          null,
          2,
        ),
      );
    else if (command === "compare")
      console.log(
        JSON.stringify(
          await app.sites.preview(
            actor,
            args[0],
            JSON.parse(await readFile(args[1], "utf8")),
          ),
          null,
          2,
        ),
      );
    else if (command === "import") {
      const input = JSON.parse(await readFile(args[1], "utf8"));
      console.log(
        await app.sites.save(
          actor,
          args[0],
          input,
          { revision: input.baseRevision, draftVersion: Number(args[2]) },
          args.includes("--replace"),
        ),
      );
    } else if (command === "publish")
      console.log(
        await app.sites.publish(
          actor,
          args[0],
          { revision: Number(args[1]), draftVersion: Number(args[2]) },
          args[3] ?? randomUUID(),
        ),
      );
    else if (command === "rollback") {
      await app.sites.operators.require(actor, args[0], true);
      console.log(
        await app.sites.config(actor).rollback(args[0], Number(args[1]), {
          revision: Number(args[2]),
          draftVersion: Number(args[3]),
        }),
      );
    } else
      throw new Error(
        "Commands: migrate, bootstrap, seed, export, compare, import, publish, rollback, auth-upgrade, site-limit, site-limit-set, retention-run, audit-export, visitor-list, visitor-ban, visitor-anonymize, re-seal",
      );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
} finally {
  if (sessionHeaders) await app.sites.operators.logout(sessionHeaders);
  await app.close();
  await pool.end();
}
