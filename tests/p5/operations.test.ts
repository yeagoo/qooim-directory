import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  cp,
  symlink,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { database } from "../../p0/tests/database.js";
import { migrate } from "../../src/server/migrate.js";
import { Application } from "../../src/server/http.js";
import { appendSourceOffer } from "../../src/server/templates.js";
import { unseal } from "../../src/server/crypto.js";
import { backup, restore } from "../../scripts/backup.mjs";
import {
  exportSource,
  checkText,
  sourceFiles,
  checkRelease,
} from "../../scripts/release.mjs";
import { runJobs } from "../../src/server/jobs.js";
let pool: Pool, app: Application, temp: string, cookie: string;
const key = randomBytes(32).toString("hex");
const origin = `https://${process.env.P0_HOSTS!.split(",")[0]}`;
const container = process.env.P0_CONTAINER!;
const options = (
  path: string,
  name = "navigation_p0",
  mediaPath?: string,
) => ({
  container,
  database: name,
  user: "postgres",
  path,
  mediaPath,
});
const password = "P5-restore-password-429!";
async function request(path: string, body?: unknown, session = "") {
  return app.respond(
    new Request(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        host: new URL(origin).host,
        origin,
        "content-type": "application/json",
        cookie: session,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
before(async () => {
  pool = await database();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(pool);
  temp = await mkdtemp(join(tmpdir(), "navigation-p5-"));
  process.env.AUTH_ENCRYPTION_KEY = key;
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.NAV_DOCKER_SUDO = "true";
  app = new Application(pool, {
    key,
    adminOrigin: `https://${process.env.P0_HOSTS!.split(",")[3]}`,
    databaseUrl: process.env.P0_DATABASE_URL!,
    development: false,
  });
  const id = await app.sites.operators.create(
    "owner@example.test",
    password,
    true,
  );
  const actor = { id, email: "owner@example.test", global_admin: true };
  await app.sites.create(actor, {
    id: "atlas",
    name: "Restore fixture",
    origin,
    centerSite: null,
  });
  await app.auth.provision("atlas");
  const signup = await request("/api/auth/sign-up/email", {
    email: "reader@example.test",
    name: "Reader",
    password,
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const user = await (await request("/api/session", undefined, cookie)).json();
  assert.equal(user.email, "reader@example.test");
  assert.equal(user.role, "reader");
  const identity = (
    await pool.query(
      `SELECT ss.id,ss.user_id FROM identity_session ss
       JOIN identity_user u ON u.id=ss.user_id AND u.space_id=ss.space_id
       WHERE ss.site_id='atlas' AND u.email='reader@example.test'
         AND NOT ss.revoked ORDER BY ss.created_at DESC LIMIT 1`,
    )
  ).rows[0];
  assert.ok(identity);
  await pool.query(
    "INSERT INTO resource(id,version,data,internal_note) VALUES('example',1,$1,'private restore note')",
    [
      {
        kind: "website",
        url: "https://example.com",
        source: "",
        translations: { zh: { title: "恢复资源", description: "Fixture" } },
      },
    ],
  );
  await pool.query("INSERT INTO resource_revision VALUES('example',1,$1)", [
    {
      kind: "website",
      url: "https://example.com",
      source: "",
      translations: { zh: { title: "恢复资源", description: "Fixture" } },
    },
  ]);
  await pool.query(
    "INSERT INTO publication(site_id,resource_id,locale,slug,title,status,url,version,source_version) VALUES('atlas','example','zh','example','恢复资源','published','https://example.com',1,1)",
  );
  await app.personal.favorite("atlas", identity, "example", true);
  await app.github
    .save(actor, {
      siteId: "atlas",
      resourceId: "repo",
      repository: "acme/project",
      expectedVersion: 0,
    })
    .then(() => assert.fail("module gate"))
    .catch((e) => assert.equal(e.status, 409));
  const snapshot = await app.sites.export(actor, "atlas");
  snapshot.config.tagline = "restored configuration";
  await app.sites.save(actor, "atlas", snapshot, {
    revision: 0,
    draftVersion: 0,
  });
  await app.sites.publish(
    actor,
    "atlas",
    { revision: 0, draftVersion: 1 },
    randomUUID(),
  );
});
after(async () => {
  await app?.close();
  await pool?.end();
  if (temp) await rm(temp, { recursive: true, force: true });
});
test("P5 encrypted backup restores identities, sessions, content, favorites, secrets and queued events into a new database", async () => {
  const path = join(temp, "snapshot"),
    media = join(temp, "media"),
    restoredMedia = join(temp, "media-restored");
  await mkdir(media, { recursive: true });
  await writeFile(join(media, "cover.png"), Buffer.from("MEDIA-FIXTURE"));
  const saved = await backup(options(path, "navigation_p0", media));
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(join(path, "database.enc"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, "media.tar.enc"))).mode & 0o777, 0o600);
  const encrypted = await readFile(join(path, "database.enc"));
  assert.equal(encrypted.includes(Buffer.from("private restore note")), false);
  const encryptedMedia = await readFile(join(path, "media.tar.enc"));
  assert.equal(encryptedMedia.includes(Buffer.from("MEDIA-FIXTURE")), false);
  const restored = await restore(
    options(path, "p5_restored", restoredMedia),
  );
  const target = new URL(process.env.P0_DATABASE_URL!);
  target.pathname = "/p5_restored";
  const restoredPool = new Pool({ connectionString: target.toString() });
  const original = app;
  app = new Application(restoredPool, {
    ...original.config,
    databaseUrl: target.toString(),
  });
  try {
    await migrate(restoredPool);
    assert.equal(
      (await (await request("/api/session", undefined, cookie)).json()).email,
      "reader@example.test",
    );
    assert.equal(
      await readFile(join(restoredMedia, "cover.png"), "utf8"),
      "MEDIA-FIXTURE",
    );
    assert.equal(
      (await restoredPool.query("SELECT count(*) FROM favorite")).rows[0].count,
      "1",
    );
    assert.equal(
      (
        await restoredPool.query(
          "SELECT internal_note FROM resource WHERE id='example'",
        )
      ).rows[0].internal_note,
      "private restore note",
    );
    const ctx = await app.catalog.resolve(new URL(origin).host);
    assert.equal((await app.catalog.browse(ctx, { locale: "zh" })).total, 1);
    assert.equal(
      (await app.catalog.configuration(ctx)).config.tagline,
      "restored configuration",
    );
    const secret = (
      await restoredPool.query("SELECT sealed_secret FROM auth_instance")
    ).rows[0].sealed_secret;
    assert.ok(unseal<{ secret: string }>(secret, key).secret);
    await runJobs(restoredPool, app.auth);
    assert.equal(
      (
        await restoredPool.query(
          "SELECT revision FROM config_delivery WHERE site_id='atlas'",
        )
      ).rows[0].revision,
      1,
    );
    assert.ok(await app.sites.operators.login("owner@example.test", password));
    const signed = await request("/api/auth/sign-in/email", {
      email: "reader@example.test",
      password,
    });
    assert.equal(signed.status, 200);
    await writeFile(
      ".local/p5-restore.json",
      JSON.stringify(
        {
          backupMs: saved.elapsedMs,
          restoreMs: restored.elapsedMs,
          backupCreatedAt: restored.createdAt,
          bytes: encrypted.length,
          verified: [
            "migrations",
            "encrypted auth secrets",
            "existing public session",
            "fresh public login",
            "operator login",
            "public content",
            "private master",
            "favorites",
            "config revision",
            "pending outbox recovery",
          ],
          scope: "isolated PostgreSQL; unchanged application and keys",
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    app = original;
    await restoredPool.end();
  }
  await assert.rejects(
    restore(options(path, "p5_restored", join(temp, "media-again"))),
    /database command failed/,
  );
  await assert.rejects(
    backup(options(path, "navigation_p0", media)),
    /EEXIST/,
  );
});
test("P5 wrong keys, corrupted ciphertext, modified metadata and migration drift are rejected before database creation", async () => {
  const source = join(temp, "snapshot"),
    keySaved = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  await assert.rejects(restore(options(source, "p5_wrong_key")));
  process.env.BACKUP_ENCRYPTION_KEY = keySaved;
  process.env.AUTH_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  await assert.rejects(
    restore(options(source, "p5_wrong_auth")),
    /key does not match/,
  );
  await assert.rejects(
    backup(options(join(temp, "wrong-auth-create"))),
    /cannot decrypt/,
  );
  process.env.AUTH_ENCRYPTION_KEY = key;
  for (const variant of ["cipher", "metadata", "version"]) {
    const path = join(temp, variant);
    await cp(source, path, { recursive: true });
    if (variant === "cipher") {
      const b = await readFile(join(path, "database.enc"));
      b[b.length - 1] ^= 1;
      await writeFile(join(path, "database.enc"), b);
    } else {
      const envelope = JSON.parse(
        await readFile(join(path, "manifest.json"), "utf8"),
      );
      const meta = JSON.parse(envelope.metadata);
      if (variant === "metadata") meta.createdAt = "tampered";
      else meta.application.version = "0.0.0";
      envelope.metadata = JSON.stringify(meta);
      await writeFile(join(path, "manifest.json"), JSON.stringify(envelope));
    }
    await assert.rejects(restore(options(path, "p5_bad_" + variant)));
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM pg_database WHERE datname LIKE 'p5_wrong_%' OR datname LIKE 'p5_bad_%'",
      )
    ).rows[0].count,
    "0",
  );
  await pool.query(
    "UPDATE schema_migration SET checksum='drift' WHERE name='001-foundation.sql'",
  );
  try {
    await assert.rejects(
      backup(options(join(temp, "drift"))),
      /migrations differ/,
    );
    await assert.rejects(stat(join(temp, "drift")), /ENOENT/);
  } finally {
    const envelope = JSON.parse(
      await readFile(join(source, "manifest.json"), "utf8"),
    );
    const migration = JSON.parse(envelope.metadata).application.migrations[0];
    await pool.query("UPDATE schema_migration SET checksum=$1 WHERE name=$2", [
      migration.checksum,
      migration.name,
    ]);
  }
});
test("P5 invalid arguments, protected database names, symlinks and same encryption keys fail safely", async () => {
  await assert.rejects(
    restore(options(join(temp, "snapshot"), "postgres")),
    /new dedicated/,
  );
  await assert.rejects(
    backup({ ...options(join(temp, "invalid")), container: "--privileged" }),
    /container/,
  );
  const saved = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_ENCRYPTION_KEY = key;
  await assert.rejects(backup(options(join(temp, "same-key"))), /independent/);
  process.env.BACKUP_ENCRYPTION_KEY = saved;
  const path = join(temp, "symlink");
  await mkdir(path);
  await symlink(
    join(temp, "snapshot", "manifest.json"),
    join(path, "manifest.json"),
  );
  await symlink(
    join(temp, "snapshot", "database.enc"),
    join(path, "database.enc"),
  );
  await assert.rejects(
    restore(options(path, "p5_symlink")),
    /Invalid backup file/,
  );
});
test("P5 authenticated backups from a different PostgreSQL major are rejected before creating a database", async () => {
  const path = join(temp, "postgres-major");
  await cp(join(temp, "snapshot"), path, { recursive: true });
  const envelope = JSON.parse(
    await readFile(join(path, "manifest.json"), "utf8"),
  );
  const metadata = JSON.parse(envelope.metadata);
  const encryptionKey = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY!, "hex");
  const decrypt = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(metadata.nonce, "hex"),
  );
  decrypt.setAAD(Buffer.from(envelope.metadata));
  decrypt.setAuthTag(Buffer.from(envelope.tag, "hex"));
  const plaintext = Buffer.concat([
    decrypt.update(await readFile(join(path, "database.enc"))),
    decrypt.final(),
  ]);
  metadata.postgresVersion = "17.9";
  metadata.nonce = randomBytes(12).toString("hex");
  envelope.metadata = JSON.stringify(metadata);
  const encrypt = createCipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(metadata.nonce, "hex"),
  );
  encrypt.setAAD(Buffer.from(envelope.metadata));
  await writeFile(
    join(path, "database.enc"),
    Buffer.concat([encrypt.update(plaintext), encrypt.final()]),
  );
  envelope.tag = encrypt.getAuthTag().toString("hex");
  await writeFile(join(path, "manifest.json"), JSON.stringify(envelope));
  await assert.rejects(
    restore(options(path, "p5_major_mismatch", join(temp, "media-major"))),
    /same PostgreSQL major/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM pg_database WHERE datname='p5_major_mismatch'",
      )
    ).rows[0].count,
    "0",
  );
});
test("P5 source export includes build and test sources plus dependency notices and excludes internal files", async () => {
  const target = join(temp, "source");
  const report = await exportSource(target);
  assert.ok(report.files > 100);
  assert.ok(report.dependencies > 50);
  for (const name of [
    ".env",
    "docs/PROJECT-BACKGROUND.md",
    "task_plan.md",
    "findings.md",
    "progress.md",
    ".local/source.tar.gz",
  ])
    await assert.rejects(stat(join(target, name)), /ENOENT/);
  assert.ok(
    (await readFile(join(target, "LICENSE"), "utf8")).includes(
      "GNU AFFERO GENERAL PUBLIC LICENSE",
    ),
  );
  const manifest = JSON.parse(
    await readFile(join(target, "SOURCE-MANIFEST.json"), "utf8"),
  );
  assert.ok(
    manifest.files.some(
      (f: { path: string }) => f.path === "tests/p5/operations.test.ts",
    ),
  );
  assert.ok(
    (await readFile(join(target, "THIRD-PARTY-NOTICES.txt"), "utf8")).includes(
      "better-auth@",
    ),
  );
  await assert.rejects(exportSource(target), /EEXIST/);
  await assert.rejects(exportSource("docs/p5-unwanted-export"), /under .local/);
  if (report.manualLicenseReview.length)
    await assert.rejects(checkRelease(), /Release blocked/);
  const isolated = join(temp, "source-path-check");
  await mkdir(isolated);
  for (const file of [
    "README.md",
    "LICENSE",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "next-env.d.ts",
    "next.config.mjs",
    "Dockerfile",
    "compose.yaml",
    "compose.demo.yaml",
    ".env.example",
    ".dockerignore",
    ".gitignore",
  ])
    await writeFile(join(isolated, file), "fixture");
  for (const folder of [
    "src",
    "app",
    "migrations",
    "scripts",
    "tests",
    "p0",
    "fixtures",
    "deploy",
    "docs",
    "third-party",
  ])
    await mkdir(join(isolated, folder));
  await symlink(
    join(temp, "snapshot", "manifest.json"),
    join(isolated, "src", "leak.ts"),
  );
  await assert.rejects(sourceFiles(isolated), /symlink/);
  await rm(join(isolated, "src", "leak.ts"));
  await writeFile(join(isolated, "src", ".env"), "PRIVATE=fixture");
  await assert.rejects(sourceFiles(isolated), /private source path/);
  assert.ok(checkText("secret", "-----BEGIN " + "PRIVATE KEY-----").length);
  assert.ok(checkText("secret", "ghp_" + "a".repeat(36)).length);
});
test("P5 source offer is available on known hosts and unknown hosts remain 404", async () => {
  for (const html of [
    "<html><body>Content</body></html>",
    "<HTML><BODY>Content</BODY></HTML>",
    "<main>Content</main>",
  ]) {
    const output = appendSourceOffer(html);
    assert.ok(output.includes("/source.tar.gz"));
    if (html.includes("</BODY>"))
      assert.ok(output.indexOf("/source.tar.gz") < output.indexOf("</BODY>"));
  }
  const response = await request("/source.tar.gz");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.equal(
    response.headers.get("content-length"),
    String((await stat(".local/source.tar.gz")).size),
  );
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    await readFile(".local/source.tar.gz"),
  );
  const page = await (await request("/")).text();
  assert.ok(page.includes("/source.tar.gz"));
  assert.equal((await request("/source.tar.gz", {})).status, 405);
  assert.equal(
    (
      await app.respond(
        new Request(origin + "/source.tar.gz", {
          method: "HEAD",
          headers: { host: new URL(origin).host },
        }),
      )
    ).status,
    405,
  );
  const adminDownload = await app.respond(
    new Request(app.config.adminOrigin + "/source.tar.gz", {
      headers: { host: new URL(app.config.adminOrigin).host },
    }),
  );
  assert.equal(adminDownload.status, 200);
  await adminDownload.body!.cancel();
  assert.equal(
    (
      await app.respond(
        new Request("https://unknown.invalid/source.tar.gz", {
          headers: { host: "unknown.invalid" },
        }),
      )
    ).status,
    404,
  );
});

test("P5 failed restore rolls back all schema changes and keeps only its newly created database", async () => {
  await pool.query("CREATE EXTENSION pg_stat_statements");
  await pool.query("CREATE ROLE p5_limited LOGIN CREATEDB");
  const path = join(temp, "transaction-failure");
  await backup(options(path));
  await assert.rejects(
    restore({ ...options(path, "p5_failed_restore"), user: "p5_limited" }),
    /database command failed/,
  );
  const target = new URL(process.env.P0_DATABASE_URL!);
  target.pathname = "/p5_failed_restore";
  const check = new Pool({ connectionString: target.toString() });
  try {
    assert.equal(
      (
        await check.query(
          "SELECT count(*) FROM pg_tables WHERE schemaname='public'",
        )
      ).rows[0].count,
      "0",
    );
  } finally {
    await check.end();
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='site'",
      )
    ).rows[0].count,
    "1",
  );
});
