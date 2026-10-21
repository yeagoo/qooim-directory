import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  mkdtemp,
  readdir,
  lstat,
  open,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
const hash = (v) => createHash("sha256").update(v).digest("hex");
async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
const key = (name) => {
  const value = process.env[name];
  if (!/^[a-f0-9]{64}$/i.test(value ?? ""))
    throw new Error(`${name} must be 32 bytes in hex`);
  return value.toLowerCase();
};
export async function applicationIdentity() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const migrations = [];
  for (const name of (await readdir("migrations"))
    .filter((n) => /^\d{3}-[a-z-]+\.sql$/.test(n))
    .sort())
    migrations.push({
      name,
      checksum: hash(await readFile(join("migrations", name))),
    });
  return {
    name: pkg.name,
    version: pkg.version,
    migrations,
  };
}
function child(args, input = false) {
  const command =
    process.env.NAV_DOCKER_SUDO === "true"
      ? ["sudo", ["-n", "docker", ...args]]
      : ["docker", args];
  const proc = spawn(command[0], command[1], {
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (b) => {
    stderr = (stderr + b).slice(-8192);
  });
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Docker database command failed (${code}); inspect database logs`,
            ),
          ),
    );
  });
  // Attach a handler immediately; callers still await and receive the original rejection.
  done.catch(() => {});
  return { proc, done, warnings: () => stderr.trim().length > 0 };
}
async function collect(args) {
  const operation = child(args);
  let result = "";
  for await (const b of operation.proc.stdout) {
    result += b;
    if (result.length > 1024 * 1024) {
      operation.proc.kill();
      throw new Error("Unexpected command output size");
    }
  }
  await operation.done;
  return result.trim();
}
function validate(options) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(options.container ?? ""))
    throw new Error("Invalid container name");
  for (const name of ["database", "user"])
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options[name] ?? ""))
      throw new Error(`Invalid ${name}`);
  if (!options.path) throw new Error("A backup directory is required");
}
export async function backup(options) {
  validate(options);
  const encryptionKey = key("BACKUP_ENCRYPTION_KEY"),
    authKey = key("AUTH_ENCRYPTION_KEY");
  if (encryptionKey === authKey)
    throw new Error("Backup and application keys must be independent");
  const directory = resolve(options.path);
  // Exclusive creation; never remove or overwrite a directory we did not create.
  await mkdir(directory, { mode: 0o700 });
  const start = Date.now();
  try {
    const identity = await applicationIdentity();
    const secrets = JSON.parse(
      await collect([
        "exec",
        options.container,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        options.user,
        "-d",
        options.database,
        "-c",
        "SELECT coalesce(json_agg(sealed_secret),'[]') FROM auth_instance",
      ]),
    );
    try {
      for (const secret of secrets) {
        const [nonce, tag, payload] = secret
          .split(".")
          .map((v) => Buffer.from(v, "base64url"));
        const check = createDecipheriv(
          "aes-256-gcm",
          Buffer.from(authKey, "hex"),
          nonce,
        );
        check.setAuthTag(tag);
        check.update(payload);
        check.final();
      }
    } catch {
      throw new Error(
        "Application encryption key cannot decrypt stored authentication secrets",
      );
    }

    const applied = JSON.parse(
      await collect([
        "exec",
        options.container,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        options.user,
        "-d",
        options.database,
        "-c",
        "SELECT coalesce(json_agg(t ORDER BY name),'[]') FROM (SELECT name,checksum FROM schema_migration)t",
      ]),
    );
    if (JSON.stringify(applied) !== JSON.stringify(identity.migrations))
      throw new Error(
        "Database migrations differ from application; use the matching application revision",
      );
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      application: identity,
      authKeyFingerprint: hash(Buffer.from(authKey, "hex")),
      nonce: randomBytes(12).toString("hex"),
      postgresVersion: await collect([
        "exec",
        options.container,
        "psql",
        "-XAt",
        "-U",
        options.user,
        "-d",
        options.database,
        "-c",
        "SHOW server_version",
      ]),
    };
    const aad = JSON.stringify(manifest);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(encryptionKey, "hex"),
      Buffer.from(manifest.nonce, "hex"),
    );
    cipher.setAAD(Buffer.from(aad));
    const operation = child([
      "exec",
      options.container,
      "pg_dump",
      "-Fc",
      "--no-owner",
      "--no-privileges",
      "-U",
      options.user,
      "-d",
      options.database,
    ]);
    try {
      await Promise.all([
        pipeline(
          operation.proc.stdout,
          cipher,
          createWriteStream(join(directory, "database.enc"), {
            flags: "wx",
            mode: 0o600,
            flush: true,
          }),
        ),
        operation.done,
      ]);
    } catch (error) {
      operation.proc.kill();
      await operation.done.catch(() => {});
      throw error;
    }
    if (operation.warnings())
      throw new Error(
        "pg_dump emitted warnings; backup not accepted, inspect database logs",
      );
    const after = JSON.parse(
      await collect([
        "exec",
        options.container,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        options.user,
        "-d",
        options.database,
        "-c",
        "SELECT coalesce(json_agg(t ORDER BY name),'[]') FROM (SELECT name,checksum FROM schema_migration)t",
      ]),
    );
    if (JSON.stringify(after) !== JSON.stringify(identity.migrations))
      throw new Error(
        "Migration changed during backup; retry without concurrent upgrade",
      );

    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(
        { metadata: aad, tag: cipher.getAuthTag().toString("hex") },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600, flush: true },
    );
    // Persist file entries and the newly created directory before reporting success.
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
    return {
      path: directory,
      elapsedMs: Date.now() - start,
      application: identity,
      encrypted: true,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function restore(options) {
  validate(options);
  if (["postgres", "template0", "template1"].includes(options.database))
    throw new Error("Restore requires a new dedicated database name");
  const encryptionKey = key("BACKUP_ENCRYPTION_KEY"),
    authKey = key("AUTH_ENCRYPTION_KEY");
  const start = Date.now(),
    directory = resolve(options.path);
  for (const filename of ["manifest.json", "database.enc"]) {
    const info = await lstat(join(directory, filename));
    if (!info.isFile() || (filename === "manifest.json" && info.size > 65536))
      throw new Error("Invalid backup file");
  }
  const envelope = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  if (
    typeof envelope.metadata !== "string" ||
    !/^[a-f0-9]{32}$/.test(envelope.tag ?? "")
  )
    throw new Error("Invalid backup manifest");
  const manifest = JSON.parse(envelope.metadata);
  if (manifest.format !== 1 || !/^[a-f0-9]{24}$/.test(manifest.nonce ?? ""))
    throw new Error("Unsupported backup format");
  if (manifest.authKeyFingerprint !== hash(Buffer.from(authKey, "hex")))
    throw new Error("Application encryption key does not match backup");
  const current = await applicationIdentity();
  if (
    JSON.stringify(manifest.application?.migrations) !==
    JSON.stringify(current.migrations)
  )
    throw new Error(
      "Backup requires matching database migrations; source files may differ",
    );
  const temporary = await mkdtemp(join(tmpdir(), "navigation-restore-"));
  try {
    const plaintext = join(temporary, "database.dump");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(encryptionKey, "hex"),
      Buffer.from(manifest.nonce, "hex"),
    );
    decipher.setAAD(Buffer.from(envelope.metadata));
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    // Authentication must complete before creating a database or executing any SQL.
    await pipeline(
      createReadStream(join(directory, "database.enc")),
      decipher,
      createWriteStream(plaintext, { flags: "wx", mode: 0o600 }),
    );
    const targetVersion = await collect([
      "exec",
      options.container,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      options.user,
      "-d",
      "postgres",
      "-c",
      "SHOW server_version",
    ]);
    const major = (version) => /^(\d+)\./.exec(version ?? "")?.[1];
    if (
      !major(manifest.postgresVersion) ||
      major(manifest.postgresVersion) !== major(targetVersion)
    )
      throw new Error(
        "Restore requires the same PostgreSQL major version as the backup",
      );
    await collect([
      "exec",
      options.container,
      "createdb",
      "-U",
      options.user,
      "--template=template0",
      "--",
      options.database,
    ]);
    // On restore failure retain the newly created database for inspection; no DROP privilege is exercised.
    const operation = child(
      [
        "exec",
        "-i",
        options.container,
        "pg_restore",
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "-U",
        options.user,
        "-d",
        options.database,
      ],
      true,
    );
    try {
      await Promise.all([
        pipeline(createReadStream(plaintext), operation.proc.stdin),
        operation.done,
      ]);
    } catch (error) {
      operation.proc.kill();
      await operation.done.catch(() => {});
      throw error;
    }
    return {
      database: options.database,
      elapsedMs: Date.now() - start,
      createdAt: manifest.createdAt,
      application: manifest.application,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, container, database, user, path, ...extra] =
    process.argv.slice(2);
  try {
    if (!["create", "restore"].includes(action) || extra.length)
      throw new Error(
        "Usage: backup.mjs create|restore CONTAINER DATABASE USER DIRECTORY",
      );
    console.log(
      JSON.stringify(
        await (action === "create" ? backup : restore)({
          container,
          database,
          user,
          path,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
