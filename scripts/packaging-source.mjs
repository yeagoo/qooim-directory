import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
const revision = "ebb95f8add54eee8bed840e3fb587e4cbec857d7";
const check = (condition, message) => {
  if (!condition) throw new Error("Packaging source: " + message);
};
const objectHash = (bytes, kind = "blob") =>
  createHash("sha1")
    .update(Buffer.from(kind + " " + bytes.length + "\0"))
    .update(bytes)
    .digest("hex");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyPackagingSource(root, source, asset) {
  if (!source.assets.some((a) => a.file.endsWith("/build-posix.sh"))) return;
  const pointer = source.packagingSourceCollection;
  if (pointer?.file !== "third-party/packaging-source/collection.json")
    throw new Error("Packaging source collection required");
  await asset(pointer);
  const report = JSON.parse(await readFile(join(root, pointer.file), "utf8"));
  check(
    report.format === 1 &&
      report.scope === "fixed-packaging-tree-not-historical-environment" &&
      report.revision === revision &&
      source.packagingRevision === revision &&
      report.historicalBuildVerified === false &&
      report.publisherSignatureVerified === false &&
      report.sourceCodeExecuted === false &&
      report.licenseClearance === "not-assessed",
    "invalid scope",
  );
  const collector = await readFile(
    join(root, "scripts/collect-packaging-source.py"),
  );
  if (report.collectorSha256 !== sha(collector))
    throw new Error("Packaging collector digest mismatch");
  check(
    report.archive?.sourceUrl ===
      "https://codeload.github.com/lovell/sharp-libvips/tar.gz/" + revision &&
      report.archive.commitComment === revision &&
      /^[a-f0-9]{64}$/.test(report.archive.sha256 ?? "") &&
      Number.isSafeInteger(report.archive.bytes) &&
      report.archive.bytes > 0 &&
      report.archive.bytes <= 8 * 1024 * 1024,
    "invalid archive identity",
  );
  const mutable = JSON.parse(
    await readFile(join(root, source.mutableInputReview.file), "utf8"),
  );
  const expectedCommit = mutable.assets.find(
    (a) => a.id === "packaging-commit",
  );
  const commitAsset = report.commitSnapshot;
  check(
    commitAsset?.file === expectedCommit.file &&
      commitAsset.sha256 === expectedCommit.sha256 &&
      (await asset(commitAsset)) === commitAsset.bytes &&
      commitAsset.bytes === expectedCommit.bytes,
    "commit snapshot mismatch",
  );
  const commit = JSON.parse(
    await readFile(join(root, commitAsset.file), "utf8"),
  );
  check(
    commit.sha === revision &&
      report.gitTreeSha1 === commit.commit?.tree?.sha &&
      /^[a-f0-9]{40}$/.test(report.gitTreeSha1 ?? ""),
    "commit tree mismatch",
  );
  const treeAsset = report.tree;
  check(
    treeAsset?.file ===
      "third-party/packaging-source/texts/" + treeAsset?.sha256 + ".txt" &&
      treeAsset.sourceUrl ===
        "https://api.github.com/repos/lovell/sharp-libvips/git/trees/" +
          report.gitTreeSha1 +
          "?recursive=1" &&
      (await asset(treeAsset)) === treeAsset.bytes,
    "tree asset mismatch",
  );
  const tree = JSON.parse(await readFile(join(root, treeAsset.file), "utf8"));
  check(
    tree.sha === report.gitTreeSha1 &&
      tree.truncated === false &&
      Array.isArray(tree.tree) &&
      tree.tree.length > 0 &&
      tree.tree.length <= 1000,
    "unbound or truncated tree",
  );
  const indexed = new Map();
  for (const entry of tree.tree) {
    check(
      typeof entry.path === "string" &&
        /^[A-Za-z0-9._/-]+$/.test(entry.path) &&
        !entry.path.split("/").some((p) => !p || p === "." || p === "..") &&
        !indexed.has(entry.path) &&
        /^[a-f0-9]{40}$/.test(entry.sha ?? ""),
      "unsafe or duplicate Git path",
    );
    check(
      (entry.type === "tree" && entry.mode === "040000") ||
        (entry.type === "blob" &&
          ["100644", "100755"].includes(entry.mode) &&
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0 &&
          entry.size <= 2 * 1024 * 1024),
      "unsupported Git member",
    );
    indexed.set(entry.path, entry);
  }
  for (const path of indexed.keys()) {
    const parent = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    check(
      !parent || indexed.get(parent)?.type === "tree",
      "missing Git parent",
    );
  }
  for (const folder of [
    "",
    ...[...indexed.values()]
      .filter((e) => e.type === "tree")
      .map((e) => e.path),
  ]) {
    const children = [...indexed.values()].filter(
      (e) =>
        (e.path.includes("/")
          ? e.path.slice(0, e.path.lastIndexOf("/"))
          : "") === folder,
    );
    const basename = (e) => e.path.split("/").at(-1);
    children.sort((a, b) =>
      Buffer.compare(
        Buffer.from(basename(a) + (a.type === "tree" ? "/" : "")),
        Buffer.from(basename(b) + (b.type === "tree" ? "/" : "")),
      ),
    );
    const encoded = Buffer.concat(
      children.map((e) =>
        Buffer.concat([
          Buffer.from(e.mode.replace(/^0+/, "") + " " + basename(e) + "\0"),
          Buffer.from(e.sha, "hex"),
        ]),
      ),
    );
    check(
      objectHash(encoded, "tree") ===
        (folder ? indexed.get(folder).sha : report.gitTreeSha1),
      "Git directory object mismatch",
    );
  }
  const blobs = new Map([...indexed].filter(([, e]) => e.type === "blob"));
  check(
    blobs.size === 63 &&
      Array.isArray(report.assets) &&
      report.assets.length === blobs.size,
    "incomplete source inventory",
  );
  const files = new Map();
  let total = 0;
  for (const entry of report.assets) {
    const git = blobs.get(entry.gitPath);
    check(
      git &&
        !files.has(entry.gitPath) &&
        entry.gitMode === git.mode &&
        entry.gitBlobSha1 === git.sha &&
        entry.bytes === git.size &&
        entry.archiveMember ===
          "sharp-libvips-" + revision + "/" + entry.gitPath &&
        entry.file ===
          "third-party/packaging-source/texts/" + entry.sha256 + ".txt" &&
        (await asset(entry)) === entry.bytes,
      "invalid source member",
    );
    const bytes = await readFile(join(root, entry.file));
    check(objectHash(bytes) === git.sha, "source Git blob mismatch");
    total += bytes.length;
    files.set(entry.gitPath, entry);
  }
  check(
    report.counts?.regularFiles === files.size &&
      report.counts.sourceBytes === total &&
      total <= 8 * 1024 * 1024,
    "source counts mismatch",
  );
  const aliases = {
    "build/posix.sh": "build-posix.sh",
    "versions.properties": "versions.properties",
    "THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",
    LICENSE: "LICENSE",
  };
  for (const [gitPath, filename] of Object.entries(aliases)) {
    const original = source.assets.find(
      (a) => a.file === "third-party/sources/sharp-libvips-ebb95f8/" + filename,
    );
    check(
      original && original.sha256 === files.get(gitPath)?.sha256,
      "previously retained source differs",
    );
    await asset(original);
  }
}
