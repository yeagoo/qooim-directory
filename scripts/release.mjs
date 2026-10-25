import {
  distributionBlockers,
  verifyNativeSourceEvidence,
} from "./distribution.mjs";
import {
  readFile,
  writeFile,
  readdir,
  lstat,
  mkdir,
  rm,
  realpath,
  stat,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const roots = [
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
];
const top = [
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
];
const excluded = new Set(["docs/PROJECT-BACKGROUND.md"]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
export async function sourceFiles(root = resolve(".")) {
  const result = [];
  async function walk(name) {
    if (
      excluded.has(name) ||
      name.split("/").includes("__pycache__") ||
      name.endsWith(".pyc")
    )
      return;
    if (
      name
        .split("/")
        .some((part) =>
          ["node_modules", ".local", ".git", ".next"].includes(part),
        ) ||
      (name !== ".env.example" &&
        name
          .split("/")
          .some((part) => part === ".env" || part.startsWith(".env.")))
    )
      throw new Error(`Unexpected private source path: ${name}`);
    const stat = await lstat(join(root, name));
    if (stat.isSymbolicLink())
      throw new Error(`Source symlink rejected: ${name}`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(join(root, name))).sort())
        await walk(name + "/" + child);
    } else if (stat.isFile()) result.push(name);
    else throw new Error(`Unsupported source entry: ${name}`);
  }
  for (const name of [...top, ...roots]) await walk(name);
  return result.sort();
}
export function checkText(name, content) {
  const errors = [];
  if (/\/home\/(?!node\b)[a-z0-9_-]+\//i.test(content))
    errors.push(`${name}: internal absolute home path`);
  if (
    /(?:AUTH_ENCRYPTION_KEY|BACKUP_ENCRYPTION_KEY)['\"]?\s*[:=]\s*['\"]?[a-f0-9]{64}/i.test(
      content,
    )
  )
    errors.push(`${name}: literal encryption key`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))
    errors.push(`${name}: embedded private key`);
  if (
    /(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,})/.test(content)
  )
    errors.push(`${name}: provider token`);
  // Host locality does not make a password safe to distribute.
  const isReference = (value) =>
    value === "REPLACE" ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  for (const match of content.matchAll(
    /postgres(?:ql)?:\/\/[^\s:'"/]*:([^\s'"@]+)@/gi,
  )) {
    if (!isReference(match[1])) errors.push(`${name}: database credential`);
  }
  for (const match of content.matchAll(/postgres(?:ql)?:\/\/[^\s'"`]+/gi)) {
    const query = match[0].indexOf("?");
    if (query < 0) continue;
    for (const [key, value] of new URLSearchParams(match[0].slice(query + 1))) {
      if (key.toLowerCase() === "password" && !isReference(value))
        errors.push(`${name}: database credential`);
    }
  }
  return errors;
}
export async function dependencyNotices(projectRoot = resolve(".")) {
  projectRoot = await realpath(projectRoot);
  const review = JSON.parse(
    await readFile(join(projectRoot, "third-party/review.json"), "utf8"),
  );
  const lockfile = await readFile(join(projectRoot, "pnpm-lock.yaml"));
  if (review.format !== 1 || review.lockfileSha256 !== sha(lockfile))
    throw new Error("Dependency notice review does not match lockfile");
  const records = new Map();
  for (const record of review.notices) {
    const id = `${record.name}@${record.version}`;
    if (records.has(id))
      throw new Error("Duplicate reviewed dependency: " + id);
    if (
      !/^licenses\/[a-z0-9.-]+\.txt$/.test(record.file) ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    )
      throw new Error("Invalid reviewed notice record: " + id);
    const filename = join(projectRoot, "third-party", record.file);
    if (
      !(await lstat(filename)).isFile() ||
      (await realpath(filename)) !== filename
    )
      throw new Error("Reviewed notice must be a regular file: " + id);
    const bytes = await readFile(filename);
    if (
      sha(bytes) !== record.sha256 ||
      !lockfile.toString().includes(record.registryIntegrity)
    )
      throw new Error("Reviewed notice integrity mismatch: " + id);
    records.set(id, { ...record, text: bytes.toString() });
  }
  const rootPackage = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  for (const kind of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const normalize = (value) =>
      JSON.stringify(
        Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      );
    if (
      normalize(rootPackage[kind]) !==
      normalize(review.directDependencies?.[kind])
    )
      throw new Error(
        "Root dependency declarations do not match reviewed lockfile: " + kind,
      );
  }
  async function locate(name, base) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
      throw new Error("Invalid dependency name");
    for (let folder = base; ; folder = dirname(folder)) {
      const target = join(folder, "node_modules", name);
      try {
        await stat(join(target, "package.json"));
        return target;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (folder === projectRoot || dirname(folder) === folder) break;
    }
    throw new Error("Declared dependency is not installed: " + name);
  }

  const entries = [],
    seen = new Set();
  async function packageAt(path, expectedName, expectedVersion) {
    const actual = await realpath(path);
    if (!actual.startsWith(join(projectRoot, "node_modules") + "/"))
      throw new Error(
        "Dependency resolves outside project: " + (expectedName ?? path),
      );
    let data;
    try {
      data = JSON.parse(await readFile(join(actual, "package.json"), "utf8"));
    } catch (e) {
      throw new Error(
        "Dependency package metadata is missing or invalid: " + path,
        {
          cause: e,
        },
      );
    }
    if (!data.name || !data.version)
      throw new Error("Dependency package identity missing");
    if (
      (expectedName && data.name !== expectedName) ||
      (expectedVersion && data.version !== expectedVersion)
    )
      throw new Error(
        "Declared dependency identity/version mismatch: " +
          (expectedName ?? data.name),
      );
    if (seen.has(actual)) return;
    seen.add(actual);
    const notices = [];
    for (const name of (await readdir(actual)).sort()) {
      if (!/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name)) continue;
      const stat = await lstat(join(actual, name));
      if (stat.isFile() && stat.size < 2 * 1024 * 1024) {
        const text = await readFile(join(actual, name), "utf8");
        if (text.trim()) notices.push({ name, text });
      }
    }
    if (!notices.length) {
      for (const name of (await readdir(actual)).filter((n) =>
        /^readme(?:\..*)?$/i.test(n),
      )) {
        const info = await lstat(join(actual, name));
        if (!info.isFile() || info.size >= 2 * 1024 * 1024) continue;
        const text = await readFile(join(actual, name), "utf8");
        if (
          text.includes("Permission is hereby granted, free of charge") &&
          text.includes("THE SOFTWARE IS PROVIDED")
        )
          notices.push({ name, text });
      }
    }
    const record = records.get(`${data.name}@${data.version}`);
    if (record) {
      if (
        record.license !== data.license ||
        record.packageJsonSha256 !==
          sha(await readFile(join(actual, "package.json")))
      )
        throw new Error("Reviewed dependency metadata mismatch: " + data.name);
      if (!notices.length)
        notices.push({
          name: "reviewed:" + record.file,
          text: record.text,
          sourceUrl: record.sourceUrl,
          revision: record.revision,
          sha256: record.sha256,
        });
    }
    for (const name of Object.keys(data.dependencies ?? {})) {
      if (Object.hasOwn(data.optionalDependencies ?? {}, name)) continue;
      await packageAt(await locate(name, actual), name);
    }
    entries.push({
      name: data.name,
      version: data.version,
      license: data.license ?? null,
      notices,
    });
  }
  for (const [name, version] of Object.entries({
    ...rootPackage.dependencies,
    ...rootPackage.devDependencies,
  })) {
    if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version))
      throw new Error("Direct dependencies must be exactly pinned: " + name);
    // Resolve direct declarations at the project itself, never a parent workspace.
    const target = join(projectRoot, "node_modules", name);
    await packageAt(target, name, version);
  }
  const store = join(projectRoot, "node_modules/.pnpm");
  for (const slot of (await readdir(store, { withFileTypes: true })).filter(
    (e) => e.isDirectory() && e.name !== "node_modules",
  )) {
    const modules = join(store, slot.name, "node_modules");
    for (const name of (await readdir(modules)).filter((n) => n !== ".bin")) {
      if (name.startsWith("@"))
        for (const child of await readdir(join(modules, name)))
          await packageAt(join(modules, name, child));
      else await packageAt(join(modules, name));
    }
  }
  return entries.sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
}
export async function exportSource(destination) {
  const root = resolve("."),
    directory = resolve(destination);
  if (
    directory.startsWith(root + "/") &&
    !directory.startsWith(root + "/.local/")
  )
    throw new Error("Export inside the project must be under .local");
  // Require a new directory. No traversal from untrusted archive input and no overwrites.
  await mkdir(directory, { mode: 0o700 });
  try {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    if (pkg.license !== "AGPL-3.0-only")
      throw new Error("Project license must be explicitly AGPL-3.0-only");
    await verifyNativeSourceEvidence(root);
    const errors = [],
      manifest = [];
    for (const name of await sourceFiles(root)) {
      const bytes = await readFile(join(root, name));
      errors.push(...checkText(name, bytes.toString("utf8")));
      await mkdir(resolve(directory, name, ".."), { recursive: true });
      await writeFile(join(directory, name), bytes, {
        flag: "wx",
        mode: 0o644,
      });
      manifest.push({ path: name, sha256: sha(bytes) });
    }
    if (errors.length) throw new Error(errors.join("\n"));
    await verifyNativeSourceEvidence(directory);
    const dependencies = await dependencyNotices();
    const unknown = dependencies
      .filter((p) => !p.license || !p.notices.length)
      .map((p) => `${p.name}@${p.version}`);
    await writeFile(
      join(directory, "THIRD-PARTY-NOTICES.txt"),
      dependencies
        .map(
          (p) =>
            `${p.name}@${p.version}\nDeclared license: ${typeof p.license === "string" ? p.license : JSON.stringify(p.license)}\n${p.notices.map((n) => `${n.name}\n${n.text}`).join("\n")}`,
        )
        .join("\n\n" + "=".repeat(72) + "\n\n"),
    );
    manifest.push({
      path: "THIRD-PARTY-NOTICES.txt",
      sha256: sha(await readFile(join(directory, "THIRD-PARTY-NOTICES.txt"))),
    });
    await writeFile(
      join(directory, "SOURCE-MANIFEST.json"),
      JSON.stringify(
        {
          format: 1,
          application: { name: pkg.name, version: pkg.version },
          files: manifest,
          dependencies: dependencies.map(({ notices, ...p }) => ({
            ...p,
            noticeFiles: notices.map((n) => n.name),
            noticeEvidence: notices.map(({ text, ...notice }) => notice),
          })),
          manualLicenseReview: unknown,
        },
        null,
        2,
      ) + "\n",
    );
    return {
      directory,
      files: manifest.length,
      dependencies: dependencies.length,
      manualLicenseReview: unknown,
      digest: sha(JSON.stringify(manifest)),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
// A tagged commit must carry its own version: package.json is written into
// backups and SOURCE-MANIFEST.json, so a stale version mislabels them.
export function versionTagBlocker(version, tag) {
  if (!tag) return null;
  return tag === "v" + version
    ? null
    : `package.json version ${version} does not match tag ${tag}`;
}
async function exactTag() {
  try {
    const { stdout } = await exec("git", ["describe", "--tags", "--exact-match"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
export async function checkRelease({ image = false } = {}) {
  const temporary = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(process.env.TMPDIR ?? "/tmp", "navigation-release-")),
  );
  try {
    const report = await exportSource(join(temporary, "source"));
    const blockers = [];
    if (report.manualLicenseReview.length)
      blockers.push(
        "dependency license text requires review: " +
          report.manualLicenseReview.join(", "),
      );
    if (image) blockers.push(...(await distributionBlockers()));
    const tag = await exactTag();
    if (!tag)
      console.error("Not on an exact tag: skipping the version/tag check.");
    const mismatch = versionTagBlocker(
      JSON.parse(await readFile("package.json", "utf8")).version,
      tag,
    );
    if (mismatch) blockers.push(mismatch);
    if (blockers.length)
      throw new Error("Release blocked: " + blockers.join("; "));
    return {
      ...report,
      scope: image
        ? "source and recorded image distribution review; brand and external OAuth acceptance remain separate"
        : "source candidate only; image audit, brand and external OAuth acceptance remain separate",
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function bundleSource() {
  await mkdir(".local", { recursive: true });
  const directory = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(resolve(".local", "source-stage-")),
  );
  const stage = join(directory, "source");
  try {
    const report = await exportSource(stage);
    const archive = join(directory, "source.tar.gz");
    await exec("tar", ["-czf", archive, "-C", stage, "."]);
    // Atomic replace only the fixed generated artifact owned by this build.
    await import("node:fs/promises").then((fs) =>
      fs.rename(archive, resolve(".local/source.tar.gz")),
    );
    return { ...report, directory: ".local/source.tar.gz" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [action, destination, ...extra] = process.argv.slice(2);
    if (
      extra.length ||
      !["export", "bundle", "check", "check-image"].includes(action) ||
      (action === "export" && !destination) ||
      (action !== "export" && destination)
    )
      throw new Error(
        "Usage: release.mjs export NEW_DIRECTORY | bundle | check | check-image",
      );
    console.log(
      JSON.stringify(
        await (action === "bundle"
          ? bundleSource()
          : action === "check" || action === "check-image"
            ? checkRelease({ image: action === "check-image" })
            : exportSource(destination)),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
