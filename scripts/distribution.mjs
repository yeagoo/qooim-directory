import { createRequire } from "node:module";
import { readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyMutableInputEvidence } from "./mutable-inputs.mjs";
import { verifyPackagingSource } from "./packaging-source.mjs";
import { verifyNativeEnvironment } from "./native-environment.mjs";
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isHttpsSourceUrl = (value) => {
  try {
    const url = new URL(value);
    return (
      typeof value === "string" &&
      value.startsWith("https://") &&
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
export const distributionScopes = Object.freeze([
  "node-base",
  "global-pnpm",
  "next-swc",
  "esbuild",
  "postgres-image",
  "demo-proxy-image",
]);
const inputs = [
  "Dockerfile",
  ".dockerignore",
  "compose.yaml",
  "compose.demo.yaml",
  "pnpm-lock.yaml",
  "package.json",
];
export async function distributionBlockers(root = resolve(".")) {
  root = await realpath(root);
  const review = JSON.parse(
    await readFile(join(root, "third-party/image-review.json"), "utf8"),
  );
  if (review.format !== 1) throw new Error("Unsupported image review format");
  if (review.targetPlatform !== process.platform + "/" + process.arch)
    throw new Error("Image review target platform mismatch");
  if (
    Object.keys(review.inputs ?? {})
      .sort()
      .join() !== [...inputs].sort().join()
  )
    throw new Error("Image review input inventory is incomplete");
  for (const name of inputs)
    if (hash(await readFile(join(root, name))) !== review.inputs[name])
      throw new Error("Image review input changed: " + name);
  if (!Array.isArray(review.scopes))
    throw new Error("Image review scopes missing");
  const seen = new Set(),
    blockers = [];
  for (const item of review.scopes) {
    if (!distributionScopes.includes(item.id) || seen.has(item.id))
      throw new Error("Unknown or duplicate image review scope: " + item.id);
    seen.add(item.id);
    if (!["pending", "complete"].includes(item.status))
      throw new Error("Invalid image review status: " + item.id);
    if (typeof item.detail !== "string" || !item.detail.trim())
      throw new Error("Image review detail missing: " + item.id);
    if (item.status === "pending") {
      blockers.push("image distribution review pending: " + item.id);
      continue;
    }
    if (
      !item.reviewer?.trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.reviewedAt ?? "") ||
      !Array.isArray(item.evidence) ||
      !item.evidence.length
    )
      throw new Error(
        "Completed image review requires reviewer, date and evidence: " +
          item.id,
      );
    for (const evidence of item.evidence) {
      if (
        typeof evidence.file !== "string" ||
        !/^third-party\/[a-zA-Z0-9._/-]+$/.test(evidence.file) ||
        evidence.file.split("/").some((p) => p === "." || p === "..") ||
        !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? "")
      )
        throw new Error("Invalid image review evidence: " + item.id);
      const path = join(root, evidence.file);
      if (
        !(await lstat(path)).isFile() ||
        (await realpath(path)) !== path ||
        hash(await readFile(path)) !== evidence.sha256
      )
        throw new Error("Image review evidence integrity mismatch: " + item.id);
    }
  }
  for (const id of distributionScopes)
    if (!seen.has(id))
      blockers.push("image distribution review missing: " + id);
  return blockers;
}

export async function verifyNativeSourceEvidence(root = resolve(".")) {
  root = await realpath(root);
  const source = JSON.parse(
    await readFile(
      join(root, "third-party/libvips-source-review.json"),
      "utf8",
    ),
  );
  const collectionBytes = await readFile(
    join(root, "third-party/component-notices.json"),
  );
  if (source.componentNoticeCollectionSha256 !== hash(collectionBytes))
    throw new Error("Native notice collection digest mismatch");
  const collection = JSON.parse(collectionBytes);
  if (source.format !== 1 || collection.format !== 1)
    throw new Error("Unsupported native source evidence format");
  const verified = new Map();
  const asset = async (item) => {
    if (
      typeof item.file !== "string" ||
      !/^third-party\/[a-zA-Z0-9._/-]+$/.test(item.file) ||
      item.file.split("/").some((p) => p === "." || p === "..") ||
      !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")
    )
      throw new Error("Invalid native evidence asset");
    if (verified.has(item.file)) {
      if (verified.get(item.file).sha256 !== item.sha256)
        throw new Error("Conflicting native evidence digests");
      return verified.get(item.file).bytes;
    }
    const file = join(root, item.file),
      info = await lstat(file);
    if (
      !info.isFile() ||
      (await realpath(file)) !== file ||
      info.size > 2 * 1024 * 1024
    )
      throw new Error("Native evidence must be a bounded regular file");
    const bytes = await readFile(file);
    if (hash(bytes) !== item.sha256)
      throw new Error("Native evidence asset integrity mismatch: " + item.file);
    verified.set(item.file, { sha256: item.sha256, bytes: bytes.length });
    return bytes.length;
  };
  if (
    !Array.isArray(source.assets) ||
    !source.assets.length ||
    source.assets.length > 5000
  )
    throw new Error("Native source assets missing or oversized");
  for (const item of source.assets) await asset(item);
  await verifyNativePatchEvidence(root, source, asset);
  await verifyMutableInputEvidence(root, source, asset);
  await verifyPackagingSource(root, source, asset);
  await verifyNativeEnvironment(root, source, asset);
  if (
    collection.collectorSha256 !==
    hash(await readFile(join(root, "scripts/collect-native-sources.py")))
  )
    throw new Error("Native notice collector digest mismatch");
  if (
    !Array.isArray(source.componentDeclarations) ||
    !source.componentDeclarations.length ||
    source.componentDeclarations.length > 100
  )
    throw new Error("Invalid native source declarations");
  const declarations = new Map();
  for (const item of source.componentDeclarations) {
    if (
      !/^[a-z0-9-]+$/.test(item.id ?? "") ||
      !/^[a-zA-Z0-9.+_-]+$/.test(item.declaredVersion ?? "") ||
      typeof item.declaredSourceUrl !== "string" ||
      /[\r\n\t]/.test(item.declaredSourceUrl) ||
      !isHttpsSourceUrl(item.declaredSourceUrl) ||
      declarations.has(item.id)
    )
      throw new Error("Invalid or duplicate native source declaration");
    declarations.set(item.id, item);
  }
  const lines = [...declarations.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => `${c.id}\t${c.declaredVersion}\t${c.declaredSourceUrl}\n`)
    .join("");
  if (collection.declarationsSha256 !== hash(lines))
    throw new Error("Native source declaration digest mismatch");
  if (
    !Array.isArray(collection.components) ||
    collection.components.length !== declarations.size
  )
    throw new Error("Native notice collection omits components");
  const seen = new Set();
  let collected = 0;
  for (const item of collection.components) {
    const declared = declarations.get(item.id);
    if (
      !declared ||
      seen.has(item.id) ||
      item.declaredVersion !== declared.declaredVersion ||
      item.sourceUrl !== declared.declaredSourceUrl ||
      item.licenseClearance !== "not-assessed"
    )
      throw new Error("Native notice component identity or scope mismatch");
    seen.add(item.id);
    if (!Array.isArray(item.notices) || item.notices.length > 10000)
      throw new Error("Invalid native notice entries");
    if (item.status !== "collected") {
      if (
        !["download-failed", "archive-rejected"].includes(item.status) ||
        !item.error ||
        item.notices.length
      )
        throw new Error("Invalid failed native collection record");
      continue;
    }
    collected++;
    if (
      !/^[a-f0-9]{64}$/.test(item.archiveSha256 ?? "") ||
      !Number.isSafeInteger(item.archiveBytes) ||
      item.archiveBytes <= 0 ||
      item.archiveBytes > 96 * 1024 * 1024
    )
      throw new Error("Invalid native archive identity");
    if (
      declared.sourceArchiveStatus === "retrieved" &&
      (declared.retrieval?.sha256 !== item.archiveSha256 ||
        declared.retrieval?.bytes !== item.archiveBytes)
    )
      throw new Error("Native archive retrieval evidence mismatch");
    for (const notice of item.notices) {
      if (
        notice.file !==
          "third-party/component-notices/" + notice.sha256 + ".txt" ||
        typeof notice.archiveMember !== "string" ||
        notice.archiveMember.startsWith("/") ||
        notice.archiveMember.split("/").includes("..") ||
        notice.archiveMember.includes("\\")
      )
        throw new Error("Invalid native notice path");
      if ((await asset(notice)) !== notice.bytes)
        throw new Error("Native notice byte count mismatch");
    }
  }
  const rsvg = declarations.get("rsvg");
  if (rsvg) {
    if (
      source.rustLockInventory?.file !== "third-party/rust-lock/inventory.json"
    )
      throw new Error("Rust lock inventory required for rsvg");
    await asset(source.rustLockInventory);
    const rust = JSON.parse(
      await readFile(join(root, source.rustLockInventory.file), "utf8"),
    );
    if (
      rust.format !== 1 ||
      rust.scope !== "complete-lockfile-not-compiled-graph" ||
      rust.licenseClearance !== "not-assessed"
    )
      throw new Error("Invalid Rust inventory scope");
    if (
      rust.collectorSha256 !==
      hash(await readFile(join(root, "scripts/inventory-rust-lock.py")))
    )
      throw new Error("Rust inventory collector digest mismatch");
    if (
      rust.component?.id !== "rsvg" ||
      rust.component.version !== rsvg.declaredVersion ||
      rust.component.sourceUrl !== rsvg.declaredSourceUrl ||
      rust.component.archiveSha256 !== rsvg.retrieval?.sha256 ||
      rust.component.archiveBytes !== rsvg.retrieval?.bytes
    )
      throw new Error("Rust inventory source identity mismatch");
    if (
      !Array.isArray(rust.assets) ||
      !rust.assets.length ||
      rust.assets.length > 100
    )
      throw new Error("Invalid Rust inventory assets");
    const paths = new Set();
    for (const item of rust.assets) {
      if (
        typeof item.file !== "string" ||
        !item.file.startsWith("third-party/rust-lock/sources/") ||
        paths.has(item.file)
      )
        throw new Error("Invalid or duplicate Rust input path");
      paths.add(item.file);
      if ((await asset(item)) !== item.bytes)
        throw new Error("Rust input byte count mismatch");
    }
    for (const name of ["Cargo.lock", "Cargo.toml"])
      if (!paths.has("third-party/rust-lock/sources/" + name))
        throw new Error("Rust original lock or workspace manifest missing");
    if (
      !Array.isArray(rust.packages) ||
      !rust.packages.length ||
      rust.packages.length > 5000
    )
      throw new Error("Invalid Rust package inventory");
    const packages = new Set();
    let registry = 0,
      workspace = 0;
    for (const item of rust.packages) {
      if (
        !/^[A-Za-z0-9_-]+$/.test(item.name ?? "") ||
        !/^[A-Za-z0-9.+_-]+$/.test(item.version ?? "")
      )
        throw new Error("Invalid Rust package identity");
      const key = JSON.stringify([item.name, item.version, item.source]);
      if (packages.has(key)) throw new Error("Duplicate Rust package identity");
      packages.add(key);
      if (
        item.source ===
          "registry+https://github.com/rust-lang/crates.io-index" &&
        /^[a-f0-9]{64}$/.test(item.checksum ?? "")
      )
        registry++;
      else if (item.source === null && item.checksum === null) workspace++;
      else throw new Error("Invalid Rust package source or checksum");
      if (
        !Array.isArray(item.dependencies) ||
        item.dependencies.some(
          (d) => typeof d !== "string" || !d.trim() || /[\r\n\t]/.test(d),
        ) ||
        new Set(item.dependencies).size !== item.dependencies.length
      )
        throw new Error("Invalid Rust dependency references");
    }
    if (
      rust.counts?.total !== packages.size ||
      rust.counts.registry !== registry ||
      rust.counts.workspace !== workspace
    )
      throw new Error("Rust inventory counts mismatch");
    await verifyCrateEvidence(root, source, rust, asset);
    await verifyRustResolution(root, source, rust, asset);
  }
  await verifyGvdbSourceEvidence(root, source, declarations.get("glib"), asset);
  return {
    components: declarations.size,
    collected,
    filesVerified: verified.size,
    licenseClearance: "not-assessed",
  };
}

async function verifyGvdbSourceEvidence(root, source, glib, asset) {
  if (!glib) {
    if (source.gvdbSourceCollection)
      throw new Error("gvdb collection has no GLib parent");
    return;
  }
  const pointer = source.gvdbSourceCollection;
  if (pointer?.file !== "third-party/gvdb-source/collection.json")
    throw new Error("gvdb collection required for GLib");
  await asset(pointer);
  const report = JSON.parse(await readFile(join(root, pointer.file), "utf8"));
  if (
    report.format !== 1 ||
    report.scope !== "fixed-gvdb-source-and-notice-candidates-not-clearance" ||
    report.licenseClearance !== "not-assessed" ||
    report.historicalBinaryMatch !== "not-asserted" ||
    report.publisherSignatureVerified !== false ||
    report.sourceCodeExecuted !== false
  )
    throw new Error("Invalid gvdb evidence scope");
  const revision = "2b42fc75f09dbe1cd1057580b5782b08f2dcb400";
  const repository = "https://gitlab.gnome.org/GNOME/gvdb.git";
  const component = report.component;
  if (
    component?.id !== "gvdb" ||
    component.parent !== "glib" ||
    component.repository !== repository ||
    component.revision !== revision ||
    component.archiveCommitComment !== revision ||
    component.sourceUrl !==
      repository.slice(0, -4) +
        "/-/archive/" +
        revision +
        "/gvdb-" +
        revision +
        ".tar.gz" ||
    !/^[a-f0-9]{64}$/.test(component.archiveSha256 ?? "") ||
    !Number.isSafeInteger(component.archiveBytes) ||
    component.archiveBytes <= 0 ||
    component.archiveBytes > 8 * 1024 * 1024 ||
    component.archiveIncluded !== false
  )
    throw new Error("Invalid gvdb fixed source identity");
  const parent = report.parentWrap;
  const wrapFile = `third-party/sources/glib-${glib.declaredVersion}/gvdb.wrap`;
  const wraps = source.assets.filter((a) => a.file === wrapFile);
  if (
    wraps.length !== 1 ||
    parent?.file !== wrapFile ||
    parent.sha256 !== wraps[0].sha256 ||
    parent.archiveSha256 !== glib.retrieval?.sha256 ||
    parent.archiveSha256 !== wraps[0].archiveSha256 ||
    parent.archiveMember !==
      `glib-${glib.declaredVersion}/subprojects/gvdb.wrap` ||
    parent.archiveMember !== wraps[0].archiveMember ||
    parent.sourceUrl !== glib.declaredSourceUrl ||
    parent.sourceUrl !== wraps[0].sourceUrl ||
    (await asset(parent)) !== parent.bytes
  )
    throw new Error("gvdb parent wrap provenance mismatch");
  const wrapText = await readFile(join(root, parent.file), "utf8");
  if (
    wrapText !==
    `[wrap-git]\ndirectory=gvdb\nurl=${repository}\nrevision=${revision}\ndepth=1\n\n[provide]\ndependency_names = gvdb\n`
  )
    throw new Error("Unsupported gvdb parent wrap declaration");
  const recipe = report.recipe;
  if (
    recipe?.file !== source.patchRecipe.file ||
    recipe.sha256 !== source.patchRecipe.sha256 ||
    (await asset(recipe)) !== recipe.bytes ||
    recipe.selectionToken !== "--force-fallback-for=gvdb" ||
    !Number.isSafeInteger(recipe.selectionLine)
  )
    throw new Error("gvdb packaging recipe mismatch");
  const lines = (await readFile(join(root, recipe.file), "utf8")).split(
    /\r?\n/,
  );
  if (
    !lines[recipe.selectionLine - 1]?.includes(recipe.selectionToken) ||
    lines.filter((line) => line.includes(recipe.selectionToken)).length !== 1
  )
    throw new Error("gvdb fallback selection mismatch");
  const collectors = new Set([
    "scripts/collect-gvdb-source.py",
    "scripts/collect-native-sources.py",
  ]);
  if (
    !Array.isArray(report.collectors) ||
    report.collectors.length !== collectors.size
  )
    throw new Error("gvdb collector inventory missing");
  for (const entry of report.collectors) {
    if (
      !collectors.delete(entry.file) ||
      entry.sha256 !== hash(await readFile(join(root, entry.file)))
    )
      throw new Error("gvdb collector digest mismatch");
  }
  const members = new Set([
    ".gitignore",
    "COPYING",
    "LICENSES/LGPL-2.1-or-later.txt",
    "README.md",
    "gvdb.doap",
    "gvdb/gvdb-builder.c",
    "gvdb/gvdb-builder.h",
    "gvdb/gvdb-format.h",
    "gvdb/gvdb-reader.c",
    "gvdb/gvdb-reader.h",
    "gvdb/tests/gvdb.c",
    "gvdb/tests/meson.build",
    "meson.build",
    "meson.options",
  ]);
  if (!Array.isArray(report.assets) || report.assets.length !== members.size)
    throw new Error("gvdb source inventory incomplete");
  const originals = new Map(),
    unique = new Map();
  for (const entry of report.assets) {
    const prefix = "gvdb-" + revision + "/";
    if (
      typeof entry.archiveMember !== "string" ||
      !entry.archiveMember.startsWith(prefix) ||
      !members.delete(entry.archiveMember.slice(prefix.length)) ||
      entry.file !== "third-party/gvdb-source/texts/" + entry.sha256 + ".txt" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      (await asset(entry)) !== entry.bytes
    )
      throw new Error("Invalid gvdb original source asset");
    originals.set(entry.archiveMember, entry);
    unique.set(entry.file, entry.bytes);
  }
  const noticeMembers = new Set([
    "gvdb-" + revision + "/COPYING",
    "gvdb-" + revision + "/LICENSES/LGPL-2.1-or-later.txt",
  ]);
  if (
    !Array.isArray(report.notices) ||
    report.notices.length !== noticeMembers.size
  )
    throw new Error("gvdb original notice inventory incomplete");
  for (const entry of report.notices) {
    const original = originals.get(entry.archiveMember);
    if (
      !noticeMembers.delete(entry.archiveMember) ||
      !original ||
      entry.file !== original.file ||
      entry.sha256 !== original.sha256 ||
      entry.bytes !== original.bytes
    )
      throw new Error(
        "gvdb notice must match its complete original source member",
      );
  }
  if (
    report.counts?.regularFiles !== originals.size ||
    report.counts.noticeReferences !== 2 ||
    report.counts.assetFiles !== unique.size ||
    report.counts.assetBytes !==
      [...unique.values()].reduce((a, b) => a + b, 0) ||
    !Array.isArray(report.warnings) ||
    report.warnings.length
  )
    throw new Error("gvdb evidence counts or warnings mismatch");
}

async function verifyNativePatchEvidence(root, source, asset) {
  const recipe = source.patchRecipe;
  const packagingRecipes = source.assets.filter((a) =>
    a.file.endsWith("/build-posix.sh"),
  );
  if (
    !recipe ||
    packagingRecipes.length > 1 ||
    (packagingRecipes.length === 1 &&
      packagingRecipes[0].file !== recipe.file) ||
    !source.assets.some(
      (a) => a.file === recipe.file && a.sha256 === recipe.sha256,
    )
  )
    throw new Error("Patch recipe must reference a verified source asset");
  await asset(recipe);
  const lines = (await readFile(join(root, recipe.file), "utf8")).split(
    /\r?\n/,
  );
  const downloads = new Map();
  for (const [index, line] of lines.entries()) {
    if (!/\|\s*patch\b/.test(line)) continue;
    const match = line.match(/^\$CURL (https:\/\/\S+) \| patch -p1$/);
    if (!match || !isHttpsSourceUrl(match[1]))
      throw new Error("Unsupported patch recipe command");
    downloads.set(index + 1, match[1]);
  }
  if (
    !Array.isArray(source.patches) ||
    source.patches.length !== downloads.size ||
    source.patches.length > 100
  )
    throw new Error("Patch recipe inventory mismatch");
  for (const patch of source.patches) {
    if (
      !Number.isSafeInteger(patch.recipeLine) ||
      downloads.get(patch.recipeLine) !== patch.url ||
      patch.status !== "retrieved" ||
      patch.historicalBinaryMatch !== "not-asserted" ||
      patch.immutableReference !==
        /(?:\/commit\/[a-f0-9]{40}\.patch$|\/raw\/[a-f0-9]{40}\/)/.test(
          patch.url,
        ) ||
      patch.file !== "third-party/patches/" + patch.sha256 + ".patch" ||
      !Number.isSafeInteger(patch.bytes) ||
      patch.bytes <= 0
    )
      throw new Error(
        "Invalid patch identity, recipe reference or historical scope",
      );
    downloads.delete(patch.recipeLine);
    if ((await asset(patch)) !== patch.bytes)
      throw new Error("Patch original byte count mismatch");
  }
  if (downloads.size) throw new Error("Patch recipe inventory mismatch");
}

async function verifyCrateEvidence(root, source, rust, asset) {
  if (
    source.crateNoticeCollection?.file !==
    "third-party/crate-notices/collection.json"
  )
    throw new Error("Crate notice collection required for rsvg");
  await asset(source.crateNoticeCollection);
  const report = JSON.parse(
    await readFile(join(root, source.crateNoticeCollection.file), "utf8"),
  );
  if (
    report.format !== 1 ||
    report.scope !== "complete-registry-lock-not-compiled-graph" ||
    report.licenseClearance !== "not-assessed"
  )
    throw new Error("Invalid crate collection scope");
  if (
    report.buildLockStatus !== "original-before-recipe-cargo-update-workspace"
  )
    throw new Error("Invalid crate build lock scope");
  const recipe = report.buildRecipe;
  if (
    recipe?.file !==
      "third-party/sources/sharp-libvips-ebb95f8/build-posix.sh" ||
    !source.assets.some(
      (a) => a.file === recipe.file && a.sha256 === recipe.sha256,
    ) ||
    (await asset(recipe)) !== recipe.bytes
  )
    throw new Error("Crate build recipe evidence mismatch");
  const lines = (await readFile(join(root, recipe.file), "utf8")).split(
    /\r?\n/,
  );
  if (
    recipe.lockMutation?.command !== "cargo update --workspace" ||
    !Number.isSafeInteger(recipe.lockMutation.line) ||
    lines[recipe.lockMutation.line - 1]?.trim() !==
      recipe.lockMutation.command ||
    lines.filter((line) => line.trim() === recipe.lockMutation.command)
      .length !== 1
  )
    throw new Error("Crate recipe lock mutation evidence mismatch");
  if (
    report.inputSha256 !== source.rustLockInventory.sha256 ||
    report.lockFileSha256 !==
      rust.assets.find(
        (a) => a.file === "third-party/rust-lock/sources/Cargo.lock",
      )?.sha256
  )
    throw new Error("Crate collection Rust input mismatch");
  const collectors = new Set([
    "scripts/collect-crate-notices.py",
    "scripts/collect-native-sources.py",
    "scripts/inventory-rust-lock.py",
  ]);
  if (
    !Array.isArray(report.collectors) ||
    report.collectors.length !== collectors.size
  )
    throw new Error("Crate collector inventory missing");
  for (const item of report.collectors) {
    if (
      !collectors.delete(item.file) ||
      item.sha256 !== hash(await readFile(join(root, item.file)))
    )
      throw new Error("Crate collector digest mismatch");
  }
  if (
    report.registryConfig?.file !==
      "third-party/crate-notices/registry-config.json" ||
    (await asset(report.registryConfig)) !== report.registryConfig.bytes
  )
    throw new Error("Invalid crate registry configuration evidence");
  const config = JSON.parse(
    await readFile(join(root, report.registryConfig.file), "utf8"),
  );
  if (
    config.dl !== "https://static.crates.io/crates" ||
    config["auth-required"]
  )
    throw new Error("Unsupported crate registry configuration");
  const expected = new Map(
    rust.packages
      .filter((p) => p.source !== null)
      .map((p) => [p.name + "@" + p.version, p]),
  );
  if (
    !Array.isArray(report.packages) ||
    report.packages.length !== expected.size
  )
    throw new Error("Crate collection omits registry packages");
  const original = async (entry, prefix) => {
    if (
      !entry ||
      entry.file !==
        "third-party/crate-notices/texts/" + entry.sha256 + ".txt" ||
      typeof entry.archiveMember !== "string" ||
      !entry.archiveMember.startsWith(prefix) ||
      entry.archiveMember.split("/").some((p) => p === "." || p === "..") ||
      entry.archiveMember.includes("\\")
    )
      throw new Error("Invalid original crate asset path");
    if ((await asset(entry)) !== entry.bytes)
      throw new Error("Original crate asset byte count mismatch");
  };
  for (const item of report.packages) {
    const identity = item.name + "@" + item.version,
      declared = expected.get(identity);
    if (
      !declared ||
      item.checksum !== declared.checksum ||
      item.sourceUrl !==
        `https://static.crates.io/crates/${declared.name}/${declared.version}/download` ||
      item.licenseClearance !== "not-assessed"
    )
      throw new Error("Crate package identity or checksum mismatch");
    expected.delete(identity);
    if (!Array.isArray(item.notices) || item.notices.length > 10000)
      throw new Error("Invalid crate notice entries");
    if (item.status !== "collected") {
      if (
        !["download-failed", "checksum-mismatch", "archive-rejected"].includes(
          item.status,
        ) ||
        typeof item.error !== "string" ||
        !item.error.trim() ||
        item.notices.length ||
        item.manifest ||
        item.supplementary?.length ||
        item.supplementaryStatus
      )
        throw new Error("Invalid failed crate collection record");
      // Preserve failure evidence without claiming collection or clearance.
      continue;
    }
    if (
      item.archiveSha256 !== declared.checksum ||
      !Number.isSafeInteger(item.archiveBytes) ||
      item.archiveBytes <= 0 ||
      item.archiveBytes > 32 * 1024 * 1024
    )
      throw new Error("Crate archive checksum or size mismatch");
    if (
      !Array.isArray(item.warnings) ||
      item.warnings.some((w) => typeof w !== "string")
    )
      throw new Error("Invalid crate warning entries");
    if (
      !item.notices.length &&
      !item.warnings.includes(
        "No original notice candidates; license declaration alone is not clearance",
      )
    )
      throw new Error("Crate missing original notices warning");
    for (const field of ["declaredLicense", "declaredLicenseFile"])
      if (item[field] !== null && typeof item[field] !== "string")
        throw new Error("Invalid original crate license declaration");
    const prefix = `${item.name}-${item.version}/`;
    if (item.manifest?.archiveMember !== prefix + "Cargo.toml")
      throw new Error("Original crate manifest required");
    await original(item.manifest, prefix);
    for (const notice of item.notices) await original(notice, prefix);
    if (!Array.isArray(item.supplementary) || item.supplementary.length > 100)
      throw new Error("Invalid supplementary crate inventory");
    const status = item.notices.length
      ? "not-requested"
      : item.supplementary.length
        ? "captured"
        : "no-candidate-found";
    if (
      item.supplementaryStatus !== status ||
      (item.notices.length && item.supplementary.length)
    )
      throw new Error("Supplementary crate scope mismatch");
    let total = 0;
    const seen = new Set();
    for (const entry of item.supplementary) {
      if (
        !["readme", "rust-source-prefix"].includes(entry.kind) ||
        seen.has(entry.archiveMember) ||
        entry.offset !== 0 ||
        !Number.isSafeInteger(entry.memberBytes) ||
        entry.memberBytes < 0 ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.completeMember !== (entry.bytes === entry.memberBytes)
      )
        throw new Error("Invalid supplementary crate byte range");
      seen.add(entry.archiveMember);
      if (
        entry.kind === "rust-source-prefix"
          ? !entry.archiveMember.endsWith(".rs") ||
            entry.bytes !== Math.min(4096, entry.memberBytes)
          : !/\/README(?:\.[A-Za-z0-9_-]+)?$/i.test(entry.archiveMember) ||
            entry.bytes !== entry.memberBytes
      )
        throw new Error("Invalid supplementary crate capture scope");
      total += entry.bytes;
      if (total > 8 * 1024 * 1024)
        throw new Error("Supplementary crate byte limit exceeded");
      await original(entry, prefix);
    }
  }
}

async function verifyRustResolution(root, source, rust, asset) {
  if (
    source.rustResolution?.file !==
    "third-party/rust-resolution/resolution.json"
  )
    throw new Error("Offline Rust resolution evidence required");
  await asset(source.rustResolution);
  const report = JSON.parse(
    await readFile(join(root, source.rustResolution.file), "utf8"),
  );
  if (
    report.format !== 1 ||
    report.scope !==
      "current-offline-cargo-tree-scenarios-not-historical-build" ||
    report.licenseClearance !== "not-assessed" ||
    report.historicalBuildVerified !== false ||
    report.sourceCodeExecuted !== false ||
    report.sourcePatchesApplied !== false
  )
    throw new Error("Invalid offline Rust resolution scope");
  if (
    report.collector?.file !== "scripts/resolve-rust-scope.py" ||
    report.collector.sha256 !==
      hash(await readFile(join(root, report.collector.file)))
  )
    throw new Error("Rust resolution collector digest mismatch");
  const crates = JSON.parse(
    await readFile(join(root, source.crateNoticeCollection.file), "utf8"),
  );
  const declared = source.componentDeclarations.find((p) => p.id === "rsvg");
  if (
    report.inputs?.rustInventorySha256 !== source.rustLockInventory.sha256 ||
    report.inputs.crateCollectionSha256 !==
      source.crateNoticeCollection.sha256 ||
    report.inputs.nativeArchiveSha256 !== declared.retrieval.sha256 ||
    report.inputs.recipeSha256 !== crates.buildRecipe.sha256
  )
    throw new Error("Rust resolution input binding mismatch");
  if (
    !report.toolchain?.cargo?.startsWith("cargo ") ||
    !report.toolchain?.rustc?.startsWith("rustc ") ||
    !/^[A-Za-z0-9_.-]+$/.test(report.toolchain?.host ?? "")
  )
    throw new Error("Rust resolution toolchain evidence missing");
  const targets = ["aarch64-unknown-linux-gnu", "aarch64-unknown-linux-musl"];
  const scenarioIds = targets.flatMap((t) => [t + "-avif-off", t + "-avif-on"]);
  const required = [
    "inputs/meson.build",
    "inputs/meson_options.txt",
    "inputs/meson/cargo_wrapper.py",
    "inputs/rsvg/meson.build",
    "patched/rsvg/Cargo.toml",
    "patched/librsvg-c/Cargo.toml",
    "reconstructed-Cargo.lock",
    ...scenarioIds.map((id) => "scenarios/" + id + ".txt"),
  ].map((p) => "third-party/rust-resolution/" + p);
  if (!Array.isArray(report.assets) || report.assets.length !== required.length)
    throw new Error("Rust resolution assets missing");
  const assets = new Map();
  for (const item of report.assets) {
    if (
      !required.includes(item.file) ||
      assets.has(item.file) ||
      (await asset(item)) !== item.bytes
    )
      throw new Error("Rust resolution asset inventory mismatch");
    assets.set(item.file, item);
  }
  if (
    report.reconstructedLock?.file !==
      "third-party/rust-resolution/reconstructed-Cargo.lock" ||
    report.reconstructedLock.sha256 !==
      assets.get(report.reconstructedLock.file)?.sha256
  )
    throw new Error("Reconstructed Rust lock evidence mismatch");
  const original = new Map(
    rust.packages.map((p) => [p.name + "@" + p.version, p]),
  );
  const checkPackage = (p) => {
    const originalPackage = original.get(p.name + "@" + p.version);
    if (!originalPackage || p.checksum !== originalPackage.checksum)
      throw new Error("Uncollected offline Rust package identity");
    return p.name + "@" + p.version;
  };
  if (
    !Array.isArray(report.removedPackages) ||
    report.originalPackages !== original.size ||
    report.reconstructedPackages !==
      original.size - report.removedPackages.length
  )
    throw new Error("Rust reconstructed lock counts mismatch");
  const removed = new Set(report.removedPackages.map(checkPackage));
  if (removed.size !== report.removedPackages.length)
    throw new Error("Duplicate removed Rust package");
  if (
    !Array.isArray(report.scenarios) ||
    report.scenarios.length !== scenarioIds.length
  )
    throw new Error("Offline Rust scenarios missing");
  const seen = new Set(),
    memberships = new Map();
  for (const item of report.scenarios) {
    if (
      !scenarioIds.includes(item.id) ||
      seen.has(item.id) ||
      item.id !==
        item.target + (item.avif === true ? "-avif-on" : "-avif-off") ||
      typeof item.avif !== "boolean" ||
      item.rootPackage !== "librsvg-c" ||
      JSON.stringify(item.edges) !== '["normal","build"]' ||
      !Array.isArray(item.packages) ||
      !item.packages.length ||
      item.packages.length > original.size
    )
      throw new Error("Invalid offline Rust scenario scope");
    seen.add(item.id);
    const keys = item.packages.map(checkPackage);
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => removed.has(key)) ||
      !keys.includes("librsvg-c@" + declared.declaredVersion)
    )
      throw new Error("Invalid offline Rust scenario package set");
    memberships.set(item.id, new Set(keys));
    const expectedPath =
      "third-party/rust-resolution/scenarios/" + item.id + ".txt";
    if (
      item.listing?.file !== expectedPath ||
      item.listing.sha256 !== assets.get(expectedPath)?.sha256 ||
      (await readFile(join(root, expectedPath), "utf8")) !==
        keys.join("\n") + "\n"
    )
      throw new Error("Rust scenario listing mismatch");
  }
  const missing = crates.packages.filter((p) => !p.notices.length);
  if (
    !Array.isArray(report.missingNoticePackages) ||
    report.missingNoticePackages.length !== missing.length
  )
    throw new Error("Offline Rust missing-notice scope omitted");
  const expectedMissing = new Set(missing.map((p) => p.name + "@" + p.version));
  for (const item of report.missingNoticePackages) {
    const key = item.name + "@" + item.version;
    if (
      !expectedMissing.delete(key) ||
      JSON.stringify(item.presentInScenarios) !==
        JSON.stringify(scenarioIds.filter((id) => memberships.get(id).has(key)))
    )
      throw new Error("Offline Rust missing-notice membership mismatch");
  }
  const expectedCommands = [
    ["--version"],
    ["update", "--workspace", "--offline"],
    ...targets.flatMap((target) =>
      [false, true].map((avif) => [
        "tree",
        "--offline",
        "--locked",
        "--package",
        "librsvg-c",
        "--target",
        target,
        "--edges",
        "normal,build",
        "--prefix",
        "none",
        "--format",
        "{p}",
        "--charset",
        "ascii",
        ...(avif ? ["--features", "avif"] : []),
      ]),
    ),
  ];
  if (
    !Array.isArray(report.commands) ||
    JSON.stringify(report.commands.map((c) => c.arguments)) !==
      JSON.stringify(expectedCommands) ||
    report.commands.some((c) => c.exitCode !== 0)
  )
    throw new Error("Offline Rust command evidence mismatch");
  await verifyPriorityCrateReview(root, source, crates, report, asset);
}

async function verifyPriorityCrateReview(
  root,
  source,
  crates,
  resolution,
  asset,
) {
  if (
    source.priorityCrateReview?.file !==
    "third-party/priority-crates/review.json"
  )
    throw new Error("Priority crate source review required");
  await asset(source.priorityCrateReview);
  const report = JSON.parse(
    await readFile(join(root, source.priorityCrateReview.file), "utf8"),
  );
  if (
    report.format !== 1 ||
    report.scope !==
      "pinned-priority-crate-source-and-license-material-not-clearance" ||
    report.licenseClearance !== "not-assessed" ||
    report.publisherSignatureVerified !== false ||
    report.historicalBuildVerified !== false
  )
    throw new Error("Invalid priority crate review scope");
  if (
    report.collector?.file !== "scripts/review-priority-crates.py" ||
    report.collector.sha256 !==
      hash(await readFile(join(root, report.collector.file)))
  )
    throw new Error("Priority crate collector digest mismatch");
  if (
    report.inputs?.crateCollectionSha256 !==
      source.crateNoticeCollection.sha256 ||
    report.inputs.rustResolutionSha256 !== source.rustResolution.sha256
  )
    throw new Error("Priority crate input binding mismatch");
  if (
    !Array.isArray(report.assets) ||
    !report.assets.length ||
    report.assets.length > 200
  )
    throw new Error("Invalid priority crate assets");
  const assets = new Map();
  for (const item of report.assets) {
    if (
      item.file !==
        "third-party/priority-crates/texts/" + item.sha256 + ".txt" ||
      assets.has(item.file) ||
      (await asset(item)) !== item.bytes
    )
      throw new Error("Priority crate asset inventory mismatch");
    assets.set(item.file, item);
  }
  const original = async (ref) => {
    const declared = assets.get(ref?.file);
    if (
      !declared ||
      declared.sha256 !== ref.sha256 ||
      declared.bytes !== ref.bytes
    )
      throw new Error("Unindexed priority crate original material");
    return readFile(join(root, ref.file));
  };
  const expected = new Map([
    [
      "mutants",
      {
        version: "0.0.4",
        repository: "sourcefrog/cargo-mutants",
        path: "mutants_attrs",
        matches: 5,
        license: "MIT",
      },
    ],
    [
      "selectors",
      {
        version: "0.40.0",
        repository: "servo/stylo",
        path: "selectors",
        matches: 19,
        license: "MPL-2.0",
      },
    ],
  ]);
  if (
    !Array.isArray(report.packages) ||
    report.packages.length !== expected.size
  )
    throw new Error("Priority crate package inventory missing");
  for (const item of report.packages) {
    const definition = expected.get(item.name);
    const parent = crates.packages.find(
      (p) => p.name === item.name && p.version === item.version,
    );
    const priority = resolution.missingNoticePackages.find(
      (p) => p.name === item.name && p.version === item.version,
    );
    if (
      !definition ||
      !expected.delete(item.name) ||
      item.version !== definition.version ||
      item.repository !== definition.repository ||
      item.pathInVcs !== definition.path ||
      !parent ||
      parent.checksum !== item.checksum ||
      parent.declaredLicense !== definition.license ||
      parent.notices.length ||
      !priority?.presentInScenarios?.length ||
      item.licenseClearance !== "not-assessed" ||
      item.originalCrateNoticeMissing !== true ||
      item.vcsWorkingTreeStatus !== "not-asserted"
    )
      throw new Error("Priority crate identity or assessment scope mismatch");
    const prefix = item.name + "-" + item.version + "/";
    const vcs = JSON.parse((await original(item.vcsInfo)).toString("utf8"));
    if (
      item.vcsInfo.archiveMember !== prefix + ".cargo_vcs_info.json" ||
      !/^[a-f0-9]{40}$/.test(item.revision ?? "") ||
      vcs.git?.sha1 !== item.revision ||
      vcs.path_in_vcs !== item.pathInVcs
    )
      throw new Error("Priority crate VCS identity mismatch");
    const tree = JSON.parse((await original(item.rootTree)).toString("utf8"));
    if (
      item.rootTree.sourceUrl !==
        `https://api.github.com/repos/${item.repository}/git/trees/${item.revision}` ||
      tree.sha !== item.revision ||
      tree.truncated !== false ||
      !Array.isArray(tree.tree)
    )
      throw new Error("Priority crate pinned tree mismatch");
    if (
      !Array.isArray(item.matches) ||
      item.matches.length !== definition.matches
    )
      throw new Error("Priority crate source match inventory incomplete");
    const members = new Set();
    for (const match of item.matches) {
      if (
        typeof match.archiveMember !== "string" ||
        !match.archiveMember.startsWith(prefix) ||
        match.archiveMember.includes("\\") ||
        match.archiveMember.split("/").some((p) => p === "." || p === "..") ||
        members.has(match.archiveMember)
      )
        throw new Error("Invalid priority crate source member");
      members.add(match.archiveMember);
      const relative = match.archiveMember.slice(prefix.length);
      const upstream =
        item.pathInVcs +
        "/" +
        (relative === "Cargo.toml.orig" ? "Cargo.toml" : relative);
      if (
        ["Cargo.toml", "Cargo.lock", ".cargo_vcs_info.json"].includes(
          relative,
        ) ||
        match.upstreamPath !== upstream ||
        match.sourceUrl !==
          `https://raw.githubusercontent.com/${item.repository}/${item.revision}/${upstream}` ||
        match.archiveMemberSha256 !== match.sha256
      )
        throw new Error("Priority crate fixed source relation mismatch");
      await original(match);
    }
    if (!members.has(prefix + "Cargo.toml.orig"))
      throw new Error("Priority original manifest match missing");
    const license = item.license,
      data = await original(license);
    if (item.name === "mutants") {
      const node = tree.tree.filter(
        (n) => n.path === "LICENSE" && n.type === "blob",
      );
      const gitBlob = createHash("sha1")
        .update(Buffer.from("blob " + data.length + "\0"))
        .update(data)
        .digest("hex");
      if (
        license.kind !== "repository-license" ||
        license.immutableReference !== true ||
        license.sourceUrl !==
          `https://raw.githubusercontent.com/${item.repository}/${item.revision}/LICENSE` ||
        node.length !== 1 ||
        node[0].sha !== gitBlob ||
        license.gitBlobSha1 !== gitBlob
      )
        throw new Error("Priority pinned license Git blob mismatch");
    } else if (
      license.kind !== "official-standard-document-html" ||
      license.immutableReference !== false ||
      license.sourceUrl !== "https://www.mozilla.org/en-US/MPL/2.0/" ||
      !data.includes("Mozilla Public License") ||
      !data.includes("Version 2.0")
    )
      throw new Error("Priority official license document scope mismatch");
  }
}

export function scanNativeArtifacts(root, { maxDepth = 5 } = {}) {
  const fs = require("node:fs"),
    path = require("node:path"),
    crypto = require("node:crypto");
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32)
    throw new Error("Invalid native scan depth");
  root = fs.realpathSync(root);
  const files = [],
    warnings = [],
    visited = new Set();
  const scan = (folder, depth = 0) => {
    if (depth > maxDepth) {
      warnings.push("Native scan depth limit: " + path.relative(root, folder));
      return;
    }
    if (visited.has(folder)) return;
    visited.add(folder);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const file = path.join(folder, entry.name);
      let target = file;
      if (entry.isSymbolicLink()) {
        try {
          target = fs.realpathSync(file);
        } catch (error) {
          if (!["ENOENT", "ELOOP"].includes(error.code)) throw error;
          warnings.push(
            "Native scan broken link: " + path.relative(root, file),
          );
          continue;
        }
        if (target !== root && !target.startsWith(root + path.sep)) {
          warnings.push(
            "Native scan link outside package: " + path.relative(root, file),
          );
          continue;
        }
      }
      const info = fs.statSync(target);
      if (info.isDirectory()) scan(target, depth + 1);
      else if (
        info.isFile() &&
        (/\.(?:node|so(?:\..*)?|wasm)$/.test(entry.name) ||
          entry.name === "esbuild")
      ) {
        if (info.size > 256 * 1024 * 1024)
          throw new Error("Native artifact exceeds inventory limit");
        const record = {
          path: path.relative(root, file),
          sha256: crypto
            .createHash("sha256")
            .update(fs.readFileSync(target))
            .digest("hex"),
        };
        if (target !== file) record.symlinkTarget = path.relative(root, target);
        files.push(record);
      }
    }
  };
  scan(root);
  return { files, warnings };
}

// Runs only in an isolated, read-only image with no host mounts or network.
function probe() {
  const fs = require("node:fs"),
    path = require("node:path"),
    crypto = require("node:crypto");
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const notices = [],
    warnings = [],
    packages = [],
    binaries = [],
    seen = new Set();
  let noticeBytes = 0;
  const notice = (file) => {
    if (!fs.existsSync(file)) {
      warnings.push("Missing notice: " + file);
      return;
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error("Notice exceeds inventory limit: " + file);
    const bytes = fs.readFileSync(file);
    noticeBytes += bytes.length;
    if (noticeBytes > 32 * 1024 * 1024)
      throw new Error("Notice inventory exceeds 32 MiB");
    notices.push({
      path: file,
      sha256: sha(bytes),
      text: bytes.toString("utf8"),
    });
  };
  notice("/usr/local/LICENSE");
  for (const dir of fs.readdirSync("/usr/share/doc")) {
    const file = path.join("/usr/share/doc", dir, "copyright");
    if (fs.existsSync(file)) notice(file);
  }
  for (const name of fs.readdirSync("/usr/share/common-licenses"))
    if (fs.statSync("/usr/share/common-licenses/" + name).isFile())
      notice("/usr/share/common-licenses/" + name);
  const pnpmPath = "/usr/local/lib/node_modules/pnpm";
  const pnpm = fs.existsSync(pnpmPath + "/package.json")
    ? JSON.parse(fs.readFileSync(pnpmPath + "/package.json"))
    : null;
  if (pnpm) notice(pnpmPath + "/LICENSE");
  else
    warnings.push(
      "Global pnpm is absent; this is not the full application image",
    );
  const packageAt = (file) => {
    const dir = fs.realpathSync(file);
    if (seen.has(dir)) return;
    seen.add(dir);
    const bytes = fs.readFileSync(dir + "/package.json"),
      data = JSON.parse(bytes);
    const row = {
      name: data.name,
      version: data.version,
      license: data.license ?? null,
      packageJsonSha256: sha(bytes),
    };
    if (data.name?.startsWith("@img/sharp-libvips-")) {
      const versions = fs.readFileSync(dir + "/versions.json");
      row.declaredComponents = JSON.parse(versions);
      row.declaredComponentsSha256 = sha(versions);
      row.componentScope =
        "build version declarations, not proof of linked binary contents";
      notice(dir + "/README.md");
    }
    for (const name of fs.readdirSync(dir))
      if (
        /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name) &&
        fs.lstatSync(dir + "/" + name).isFile()
      )
        notice(dir + "/" + name);
    // Native hashes identify artifacts; they do not establish their licenses.
    if (
      data.name?.startsWith("@next/swc-") ||
      data.name?.startsWith("@img/") ||
      data.name?.startsWith("@esbuild/")
    ) {
      const scan = scanNativeArtifacts(dir);
      binaries.push(
        ...scan.files.map((file) => ({
          package: data.name,
          version: data.version,
          ...file,
        })),
      );
      warnings.push(
        ...scan.warnings.map((message) => data.name + ": " + message),
      );
    }
    packages.push(row);
  };
  const store = "/app/node_modules/.pnpm";
  if (fs.existsSync(store)) {
    for (const slot of fs.readdirSync(store, { withFileTypes: true })) {
      if (!slot.isDirectory() || slot.name === "node_modules") continue;
      const modules = path.join(store, slot.name, "node_modules");
      for (const name of fs.readdirSync(modules)) {
        if (name === ".bin") continue;
        if (name.startsWith("@"))
          for (const child of fs.readdirSync(path.join(modules, name)))
            packageAt(path.join(modules, name, child));
        else packageAt(path.join(modules, name));
      }
    }
  } else warnings.push("Application pnpm store absent");
  const osPackages = require("node:child_process")
    .execFileSync(
      "dpkg-query",
      ["-W", "-f=${Package}\t${Version}\t${Architecture}\n"],
      { encoding: "utf8" },
    )
    .trim()
    .split("\n")
    .map((row) => {
      const [name, version, architecture] = row.split("\t");
      return { name, version, architecture };
    });
  console.log(
    JSON.stringify({
      sourceArchiveSha256: fs.existsSync("/app/.local/source.tar.gz")
        ? sha(fs.readFileSync("/app/.local/source.tar.gz"))
        : null,
      appPackageJsonSha256: fs.existsSync("/app/package.json")
        ? sha(fs.readFileSync("/app/package.json"))
        : null,
      appLockfileSha256: fs.existsSync("/app/pnpm-lock.yaml")
        ? sha(fs.readFileSync("/app/pnpm-lock.yaml"))
        : null,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: fs.readFileSync("/etc/os-release", "utf8"),
      pnpm: pnpm ? { version: pnpm.version, license: pnpm.license } : null,
      osPackages,
      packages: packages.sort((a, b) => a.name.localeCompare(b.name)),
      nativeBinaries: binaries,
      notices,
      warnings,
    }),
  );
}
export async function inventoryImage(reference, destination) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(reference))
    throw new Error("Invalid image reference");
  const docker = async (args) => {
    const options = { timeout: 60000, maxBuffer: 48 * 1024 * 1024 };
    try {
      return (await exec("sudo", ["-n", "docker", ...args], options)).stdout;
    } catch (error) {
      // Rootless or containerized hosts can expose the Docker socket without a
      // usable sudo. Only fall back when the privilege wrapper itself failed.
      const message = String(error.stderr ?? "") + String(error.message ?? "");
      if (
        error.code !== "ENOENT" &&
        !/no new privileges|sudo:|not found|permission denied/i.test(message)
      )
        throw error;
      return (await exec("docker", args, options)).stdout;
    }
  };
  const image = JSON.parse(
    await docker([
      "image",
      "inspect",
      reference,
      "--format",
      '{"id":{{json .Id}},"architecture":{{json .Architecture}},"os":{{json .Os}},"repoDigests":{{json .RepoDigests}}}',
    ]),
  );
  const name = "navigation-inventory-" + randomUUID();
  try {
    const runtime = JSON.parse(
      await docker([
        "run",
        "--rm",
        "--pull=never",
        "--name",
        name,
        "--network",
        "none",
        "--pids-limit",
        "64",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--entrypoint",
        "node",
        image.id,
        "-e",
        scanNativeArtifacts.toString() + ";(" + probe.toString() + ")()",
      ]),
    );
    const bytes =
      JSON.stringify(
        {
          format: 2,
          collectedAt: new Date().toISOString(),
          collectorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
          reference,
          image,
          scope:
            "inventory only; no license clearance or vulnerability assessment",
          runtime,
        },
        null,
        2,
      ) + "\n";
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    return {
      file: destination,
      image: image.id,
      sha256: hash(bytes),
      packages: runtime.packages.length,
      osPackages: runtime.osPackages.length,
      notices: runtime.notices.length,
      nativeBinaries: runtime.nativeBinaries.length,
      warnings: runtime.warnings,
    };
  } finally {
    // Only the uniquely named probe created by this invocation may be removed.
    await docker(["rm", "-f", name]).catch(() => {});
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [action, reference, destination, ...extra] = process.argv.slice(2);
    if (action !== "inventory" || !reference || !destination || extra.length)
      throw new Error(
        "Usage: distribution.mjs inventory LOCAL_IMAGE NEW_JSON_FILE",
      );
    console.log(
      JSON.stringify(await inventoryImage(reference, destination), null, 2),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
