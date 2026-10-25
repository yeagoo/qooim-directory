import {
  analyzeEnvironmentSources,
  summarizeEnvironmentCi,
  collectEnvironmentReview,
} from "../../scripts/native-environment.mjs";
import {
  verifyNativeSourceEvidence,
  scanNativeArtifacts,
  distributionBlockers,
  distributionScopes,
  inventoryImage,
} from "../../scripts/distribution.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  dependencyNotices,
  checkText,
  exportSource,
  sourceFiles,
  versionTagBlocker,
} from "../../scripts/release.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
let temp;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "navigation-release-"));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});
async function fixture(
  id,
  { reviewed = false, declared = true, transitive = false } = {},
) {
  const root = join(temp, id);
  await mkdir(join(root, "third-party/licenses"), { recursive: true });
  const base = join(
    root,
    "node_modules/.pnpm/example@1.0.0/node_modules/example",
  );
  await mkdir(base, { recursive: true });
  const data = {
    name: "example",
    version: "1.0.0",
    license: "MIT",
    ...(transitive ? { dependencies: { missing: "^1.0.0" } } : {}),
  };
  const bytes = JSON.stringify(data);
  await writeFile(join(base, "package.json"), bytes);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: declared ? { example: "1.0.0" } : { absent: "1.0.0" },
    }),
  );
  await symlink(
    ".pnpm/example@1.0.0/node_modules/example",
    join(root, "node_modules/example"),
  );
  const lock = "fixture-lock";
  await writeFile(join(root, "pnpm-lock.yaml"), lock);
  const notice =
    "MIT License\nCopyright Fixture\nPermission is hereby granted, free of charge.\nTHE SOFTWARE IS PROVIDED AS IS.\n";
  const record = {
    name: "example",
    version: "1.0.0",
    license: "MIT",
    file: "licenses/example.txt",
    sha256: hash(notice),
    packageJsonSha256: hash(bytes),
    registryIntegrity: "fixture-lock",
    sourceUrl: "https://example.test/license",
    revision: "fixture",
  };
  await writeFile(join(root, "third-party/licenses/example.txt"), notice);
  await writeFile(
    join(root, "third-party/review.json"),
    JSON.stringify({
      format: 1,
      lockfileSha256: hash(lock),
      notices: reviewed ? [record] : [],
      directDependencies: {
        dependencies: declared ? { example: "1.0.0" } : { absent: "1.0.0" },
      },
    }),
  );
  return { root, base, record };
}
test("release inventory fails when a direct declaration is absent even if the pnpm store has packages", async () => {
  const { root } = await fixture("absent", { declared: false });
  await assert.rejects(dependencyNotices(root), /ENOENT|missing|installed/);
});
test("release inventory rejects a different installed direct version and a missing required transitive dependency", async () => {
  const { root, base } = await fixture("version");
  await writeFile(
    join(base, "package.json"),
    JSON.stringify({ name: "example", version: "2.0.0", license: "MIT" }),
  );
  await assert.rejects(dependencyNotices(root), /identity\/version mismatch/);
  const nested = await fixture("transitive", { transitive: true });
  await assert.rejects(
    dependencyNotices(nested.root),
    /not installed: missing/,
  );
});
test("reviewed notices validate metadata, lockfile and text before supplying an offline notice", async () => {
  const { root, base } = await fixture("reviewed", { reviewed: true });
  const rows = await dependencyNotices(root);
  assert.equal(rows[0].notices[0].revision, "fixture");
  await writeFile(join(root, "third-party/licenses/example.txt"), "tampered");
  await assert.rejects(dependencyNotices(root), /integrity mismatch/);
  const f = await fixture("lock", { reviewed: true });
  await writeFile(join(f.root, "pnpm-lock.yaml"), "changed");
  await assert.rejects(dependencyNotices(f.root), /match lockfile/);
  const m = await fixture("metadata", { reviewed: true });
  const data = JSON.parse(await readFile(join(m.base, "package.json"), "utf8"));
  data.extra = "changed";
  await writeFile(join(m.base, "package.json"), JSON.stringify(data));
  await assert.rejects(dependencyNotices(m.root), /metadata mismatch/);
});
test("unreviewed MIT declarations remain unresolved and duplicate or symlinked evidence is rejected", async () => {
  const f = await fixture("unreviewed");
  assert.equal((await dependencyNotices(f.root))[0].notices.length, 0);
  const d = await fixture("duplicate", { reviewed: true });
  const file = join(d.root, "third-party/review.json");
  const review = JSON.parse(await readFile(file, "utf8"));
  review.notices.push(review.notices[0]);
  await writeFile(file, JSON.stringify(review));
  await assert.rejects(dependencyNotices(d.root), /Duplicate/);
  const s = await fixture("symlink", { reviewed: true });
  const path = join(s.root, "third-party/licenses/example.txt");
  await rm(path);
  await symlink(join(f.root, "third-party/licenses/example.txt"), path);
  await assert.rejects(dependencyNotices(s.root), /regular file/);
});
test("literal database passwords are rejected for loopback, database aliases and external hosts; references stay allowed", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "db",
    "db.example.com",
    "[::1]",
    "example.com",
  ]) {
    const url =
      "postgresql" + "://user:" + "real-password@" + host + "/network";
    assert.ok(
      checkText("fixture", url).includes("fixture: database credential"),
    );
  }
  assert.ok(
    checkText(
      "fixture",
      "postgresql" + "://:" + "real-password@localhost/network",
    ).length,
  );
  assert.ok(
    checkText(
      "fixture",
      "postgresql" +
        "://localhost/network?sslmode=require&password=" +
        "real-password",
    ).length,
  );
  for (const query of [
    "password=$PG_PASSWORD&password=real-password",
    "%70assword=real-password",
  ]) {
    assert.ok(
      checkText("fixture", "postgresql" + "://localhost/network?" + query)
        .length,
    );
  }
  for (const password of ["REPLACE", "${password}", "$POSTGRES_PASSWORD"])
    assert.deepEqual(
      checkText(
        "fixture",
        "postgresql" + "://user:" + password + "@localhost/network",
      ),
      [],
    );
});
test("installed reviewed notices carry fixed provenance and unresolved origins remain explicit", async () => {
  const rows = await dependencyNotices();
  const review = JSON.parse(await readFile("third-party/review.json", "utf8"));
  let reviewed = 0;
  for (const record of review.notices) {
    const entry = rows.find(
      (r) => r.name === record.name && r.version === record.version,
    );
    if (!entry) continue; // Other CPU/OS targets must not invent an installed package.
    reviewed++;
    assert.ok(entry.notices.some((n) => n.revision && n.sha256 && n.sourceUrl));
  }
  assert.ok(reviewed > 0);
  for (const pending of review.pending) {
    const entry = rows.find(
      (r) => r.name === pending.name && r.version === pending.version,
    );
    if (entry) assert.equal(entry.notices.length, 0);
  }
});
test("exported third-party notices are covered by the file manifest and reviewed evidence is included in source", async () => {
  const path = join(temp, "export");
  await exportSource(path);
  const manifest = JSON.parse(
    await readFile(join(path, "SOURCE-MANIFEST.json"), "utf8"),
  );
  const notice = manifest.files.find(
    (f) => f.path === "THIRD-PARTY-NOTICES.txt",
  );
  assert.ok(notice);
  assert.equal(notice.sha256, hash(await readFile(join(path, notice.path))));
  assert.ok(manifest.files.some((f) => f.path === "third-party/review.json"));
  const next = manifest.dependencies.find((d) => d.name === "@next/env");
  assert.equal(next.noticeEvidence[0].revision.length, 40);
  assert.ok(
    next.noticeEvidence[0].sourceUrl.startsWith(
      "https://raw.githubusercontent.com/",
    ),
  );
  assert.equal((await verifyNativeSourceEvidence(path)).components, 28);
  const collection = JSON.parse(
    await readFile(join(path, "third-party/component-notices.json"), "utf8"),
  );
  await writeFile(
    join(path, collection.components[0].notices[0].file),
    "tampered exported notice",
  );
  await assert.rejects(verifyNativeSourceEvidence(path), /integrity mismatch/);
});

test("quoted JSON encryption keys and passwords that only resemble references are still blocked", () => {
  assert.ok(
    checkText(
      "fixture",
      JSON.stringify({ AUTH_ENCRYPTION_KEY: "a".repeat(64) }),
    ).length,
  );
  for (const password of ["$123-password", "secret${reference}suffix"])
    assert.ok(
      checkText(
        "fixture",
        "postgresql" + "://user:" + password + "@localhost/network",
      ).length,
    );
});

test("dependency audit cannot resolve an external linked package beyond the project image", async () => {
  const first = await fixture("external-first"),
    second = await fixture("external-second");
  await rm(join(first.root, "node_modules/example"));
  await symlink(second.base, join(first.root, "node_modules/example"));
  await assert.rejects(dependencyNotices(first.root), /outside project/);
});

test("changing root declarations without a new lock review fails even when cached packages exist", async () => {
  const f = await fixture("root-drift");
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ dependencies: { example: "2.0.0" } }),
  );
  await assert.rejects(
    dependencyNotices(f.root),
    /declarations do not match reviewed lockfile/,
  );
});

test("empty license files do not satisfy dependency notice review", async () => {
  const f = await fixture("empty-license");
  await writeFile(join(f.base, "LICENSE"), " \n\t");
  assert.equal((await dependencyNotices(f.root))[0].notices.length, 0);
});

test("README notice discovery never follows symlinks or reads oversized files", async () => {
  const f = await fixture("linked-readme");
  const outside = join(temp, "outside-readme");
  await writeFile(
    outside,
    "Permission is hereby granted, free of charge.\nTHE SOFTWARE IS PROVIDED\nPRIVATE-OUTSIDE-READ",
  );
  await symlink(outside, join(f.base, "README.md"));
  assert.equal((await dependencyNotices(f.root))[0].notices.length, 0);
  const large = await fixture("oversized-readme");
  await writeFile(
    join(large.base, "README.md"),
    "Permission is hereby granted, free of charge.\nTHE SOFTWARE IS PROVIDED\n" +
      "x".repeat(2 * 1024 * 1024),
  );
  assert.equal((await dependencyNotices(large.root))[0].notices.length, 0);
});

async function imageFixture(id) {
  const root = join(temp, id);
  await mkdir(join(root, "third-party"), { recursive: true });
  const inputs = {};
  for (const file of [
    "Dockerfile",
    ".dockerignore",
    "compose.yaml",
    "compose.demo.yaml",
    "pnpm-lock.yaml",
    "package.json",
  ]) {
    await writeFile(join(root, file), file);
    inputs[file] = hash(file);
  }
  const review = {
    format: 1,
    targetPlatform: process.platform + "/" + process.arch,
    inputs,
    scopes: distributionScopes.map((id) => ({
      id,
      status: "pending",
      detail: "Pending exact notice and source review",
      evidence: [],
    })),
  };
  const save = () =>
    writeFile(
      join(root, "third-party/image-review.json"),
      JSON.stringify(review),
    );
  await save();
  return { root, review, save };
}

test("image review cannot pass pending or omitted scopes and rejects input drift", async () => {
  const f = await imageFixture("image-pending");
  assert.equal(
    (await distributionBlockers(f.root)).length,
    distributionScopes.length,
  );
  f.review.scopes.pop();
  await f.save();
  assert.ok(
    (await distributionBlockers(f.root)).some((b) =>
      b.includes("review missing: demo-proxy-image"),
    ),
  );
  f.review.scopes.push(f.review.scopes[0]);
  await f.save();
  await assert.rejects(distributionBlockers(f.root), /duplicate/);
  f.review.scopes.pop();
  await f.save();
  f.review.targetPlatform = "other/architecture";
  await f.save();
  await assert.rejects(
    distributionBlockers(f.root),
    /target platform mismatch/,
  );
  f.review.targetPlatform = process.platform + "/" + process.arch;
  await f.save();
  await writeFile(join(f.root, "Dockerfile"), "changed-base-image");
  await assert.rejects(
    distributionBlockers(f.root),
    /input changed: Dockerfile/,
  );
});

test("completed image reviews require identified reviewers and immutable local evidence", async () => {
  const f = await imageFixture("image-complete");
  const text =
    "Fixture evidence: exact artifacts, permission notices and source fulfilment reviewed.";
  await writeFile(join(f.root, "third-party/evidence.txt"), text);
  for (const item of f.review.scopes) {
    item.status = "complete";
    item.reviewer = "Fixture reviewer";
    item.reviewedAt = "2026-10-18";
    item.evidence = [{ file: "third-party/evidence.txt", sha256: hash(text) }];
  }
  await f.save();
  assert.deepEqual(await distributionBlockers(f.root), []);
  f.review.scopes[0].evidence = [];
  await f.save();
  await assert.rejects(
    distributionBlockers(f.root),
    /requires reviewer, date and evidence/,
  );
  f.review.scopes[0].evidence = [
    { file: "third-party/evidence.txt", sha256: hash(text) },
  ];
  await f.save();
  await writeFile(join(f.root, "third-party/evidence.txt"), "changed");
  await assert.rejects(distributionBlockers(f.root), /integrity mismatch/);
  await rm(join(f.root, "third-party/evidence.txt"));
  const outside = join(temp, "image-evidence-outside");
  await writeFile(outside, text);
  await symlink(outside, join(f.root, "third-party/evidence.txt"));
  await assert.rejects(distributionBlockers(f.root), /integrity mismatch/);
});

test("the installed image gate accepts complete reviews and rejects invalid image references before Docker", async () => {
  const reviewed = JSON.parse(
    await readFile("third-party/image-review.json", "utf8"),
  );
  if (reviewed.targetPlatform === process.platform + "/" + process.arch) {
    assert.deepEqual(await distributionBlockers(), []);
  } else {
    await assert.rejects(distributionBlockers(), /target platform mismatch/);
  }
  await assert.rejects(
    inventoryImage("--privileged", join(temp, "never-created")),
    /Invalid image reference/,
  );
});

test("native inventory hashes in-package library aliases and records wasm files", async () => {
  const root = join(temp, "native-alias");
  await mkdir(join(root, "data"), { recursive: true });
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
  await writeFile(join(root, "data/library.bin"), binary);
  await symlink("data/library.bin", join(root, "libexample.so"));
  const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  await writeFile(join(root, "module.wasm"), wasm);
  const result = scanNativeArtifacts(root);
  assert.ok(
    result.files.some(
      (f) => f.path === "libexample.so" && f.sha256 === hash(binary),
    ),
  );
  assert.ok(
    result.files.some(
      (f) => f.path === "module.wasm" && f.sha256 === hash(wasm),
    ),
  );
  assert.deepEqual(result.warnings, []);
});

test("native inventory warns about depth truncation instead of claiming a clean scan", async () => {
  const root = join(temp, "native-depth");
  await mkdir(join(root, "a/b"), { recursive: true });
  await writeFile(join(root, "a/b/deep.node"), "deep artifact");
  const result = scanNativeArtifacts(root, { maxDepth: 1 });
  assert.equal(result.files.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("depth limit")));
});

test("native inventory refuses escaped library aliases and warns about broken aliases", async () => {
  const root = join(temp, "native-escape");
  await mkdir(root);
  const outside = join(temp, "outside-library.so");
  await writeFile(outside, "PRIVATE-OUTSIDE-NATIVE");
  await symlink(outside, join(root, "escaped.so"));
  await symlink("missing.so", join(root, "broken.so"));
  const result = scanNativeArtifacts(root);
  assert.equal(result.files.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("outside package")));
  assert.ok(result.warnings.some((w) => w.includes("broken link")));
});

test("libvips source evidence binds the exact recipe, package files and declarations without asserting binary inclusion", async () => {
  const evidence = JSON.parse(
    await readFile("third-party/libvips-source-review.json", "utf8"),
  );
  assert.equal(evidence.status, "incomplete");
  assert.equal(evidence.componentDeclarations.length, 28);
  assert.equal(evidence.publishedPackages.length, 2);
  const lock = await readFile("pnpm-lock.yaml", "utf8");
  for (const asset of evidence.assets)
    assert.equal(hash(await readFile(asset.file)), asset.sha256);
  const recipe = await readFile(
    evidence.assets.find((a) => a.file.endsWith("build-posix.sh")).file,
    "utf8",
  );
  const lines = recipe.split("\n");
  const versions = Object.fromEntries(
    [
      ...(
        await readFile(
          evidence.assets.find((a) => a.file.endsWith("versions.properties"))
            .file,
          "utf8",
        )
      ).matchAll(/^VERSION_([A-Z0-9_]+)=(\S+)$/gm),
    ].map((m) => [m[1].toLowerCase().replaceAll("_", "-"), m[2]]),
  );
  assert.deepEqual(
    Object.fromEntries(
      evidence.componentDeclarations.map((c) => [c.id, c.declaredVersion]),
    ),
    versions,
  );
  for (const component of evidence.componentDeclarations) {
    assert.ok(lines[component.recipeLine - 1].includes("$CURL"));
    assert.ok(component.declaredSourceUrl.startsWith("https://"));
    assert.ok(!component.declaredSourceUrl.includes("$"));
    assert.equal(component.binaryPresence, "not-asserted");
  }
  const proxy = evidence.componentDeclarations.find(
    (c) => c.id === "proxy-libintl",
  );
  assert.equal(proxy.recipeApplicability["linux-arm64"], false);
  assert.equal(proxy.recipeApplicability["linuxmusl-arm64"], true);
  assert.ok(evidence.patches.some((p) => !p.immutableReference));
  assert.equal(evidence.inlineSourceEdits.length, 13);
  const inventory = JSON.parse(
    await readFile("third-party/native-inventory.json", "utf8"),
  );
  assert.equal(inventory.format, 2);
  assert.equal(
    evidence.componentDeclarations.filter(
      (c) => c.sourceArchiveStatus === "retrieved",
    ).length,
    28,
  );
  for (const patch of evidence.patches) {
    assert.equal(patch.status, "retrieved");
    assert.match(patch.sha256, /^[a-f0-9]{64}$/);
  }
  for (const pkg of evidence.publishedPackages) {
    // The optional sharp dependency was removed from distribution; the
    // historical package evidence is retained but no longer lock-bound.
    if (lock.includes(pkg.package))
      assert.ok(lock.includes(pkg.registryIntegrity));
    assert.equal(pkg.gitHead, evidence.packagingRevision);
    assert.equal(pkg.files.length, 6);
    const binary = inventory.nativeBinaries.find(
      (b) => b.package === pkg.package,
    );
    assert.equal(
      pkg.files.find((f) => f.path.endsWith(binary.path)).sha256,
      binary.sha256,
    );
    const bundle = inventory.libvipsBundles.find((b) => b.name === pkg.package);
    assert.deepEqual(bundle.declaredComponents, versions);
  }
});

test("image review binds Docker ignore rules that affect distributed files", async () => {
  const f = await imageFixture("image-ignore-drift");
  await writeFile(join(f.root, ".dockerignore"), "changed ignored contents");
  await assert.rejects(
    distributionBlockers(f.root),
    /input changed: .dockerignore/,
  );
});

async function nativeEvidenceFixture(id) {
  const root = join(temp, id);
  await mkdir(join(root, "third-party/component-notices"), { recursive: true });
  await mkdir(join(root, "scripts"));
  const collector = "fixture source collector";
  await writeFile(join(root, "scripts/collect-native-sources.py"), collector);
  const text = "Copyright Fixture\nOriginal permission notice\n";
  const notice = {
    file: "third-party/component-notices/" + hash(text) + ".txt",
    sha256: hash(text),
    bytes: Buffer.byteLength(text),
    archiveMember: "source/LICENSE",
  };
  await writeFile(join(root, notice.file), text);
  await writeFile(join(root, "third-party/recipe.txt"), "original recipe");
  const declared = {
    id: "example",
    declaredVersion: "1.0",
    declaredSourceUrl: "https://example.test/source.tar.gz",
    sourceArchiveStatus: "retrieved",
    retrieval: { sha256: "a".repeat(64), bytes: 7 },
  };
  const source = {
    format: 1,
    assets: [
      { file: "third-party/recipe.txt", sha256: hash("original recipe") },
    ],
    patchRecipe: {
      file: "third-party/recipe.txt",
      sha256: hash("original recipe"),
    },
    patches: [],
    componentDeclarations: [declared],
  };
  const collection = {
    format: 1,
    collectorSha256: hash(collector),
    declarationsSha256: hash(
      "example\t1.0\thttps://example.test/source.tar.gz\n",
    ),
    components: [
      {
        id: "example",
        declaredVersion: "1.0",
        sourceUrl: declared.declaredSourceUrl,
        licenseClearance: "not-assessed",
        status: "collected",
        archiveSha256: "a".repeat(64),
        archiveBytes: 7,
        notices: [notice],
      },
    ],
  };
  const save = async () => {
    source.componentNoticeCollectionSha256 = hash(JSON.stringify(collection));
    await writeFile(
      join(root, "third-party/libvips-source-review.json"),
      JSON.stringify(source),
    );
    await writeFile(
      join(root, "third-party/component-notices.json"),
      JSON.stringify(collection),
    );
  };
  await save();
  return { root, source, collection, notice, save };
}

test("native evidence rejects changed original notices, escaped links and collector drift", async () => {
  const f = await nativeEvidenceFixture("native-notice-integrity");
  const missing = await nativeEvidenceFixture("native-notice-index-loss");
  missing.collection.components[0].notices = [];
  await writeFile(
    join(missing.root, "third-party/component-notices.json"),
    JSON.stringify(missing.collection),
  );
  await assert.rejects(
    verifyNativeSourceEvidence(missing.root),
    /collection digest mismatch/,
  );

  assert.equal((await verifyNativeSourceEvidence(f.root)).collected, 1);
  await writeFile(join(f.root, f.notice.file), "changed original text");
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /integrity mismatch/,
  );
  const linked = await nativeEvidenceFixture("native-notice-link");
  const outside = join(temp, "outside-native-notice");
  await writeFile(outside, "Copyright Fixture\nOriginal permission notice\n");
  await rm(join(linked.root, linked.notice.file));
  await symlink(outside, join(linked.root, linked.notice.file));
  await assert.rejects(verifyNativeSourceEvidence(linked.root), /regular file/);
  const drift = await nativeEvidenceFixture("native-collector-drift");
  await writeFile(
    join(drift.root, "scripts/collect-native-sources.py"),
    "changed collector",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(drift.root),
    /collector digest mismatch/,
  );
});

test("native evidence rejects omitted components, changed version/source pairs and fake archive identities", async () => {
  const f = await nativeEvidenceFixture("native-identity");
  f.collection.components = [];
  await f.save();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /omits components/);
  const changed = await nativeEvidenceFixture("native-version-change");
  changed.collection.components[0].declaredVersion = "2.0";
  await changed.save();
  await assert.rejects(
    verifyNativeSourceEvidence(changed.root),
    /identity or scope mismatch/,
  );
  const archive = await nativeEvidenceFixture("native-archive-change");
  archive.collection.components[0].archiveSha256 = "b".repeat(64);
  await archive.save();
  await assert.rejects(
    verifyNativeSourceEvidence(archive.root),
    /retrieval evidence mismatch/,
  );
});

test("source exports verify all collected native notices while keeping clearance unassessed", async () => {
  const report = await verifyNativeSourceEvidence();
  assert.equal(report.components, 28);
  assert.equal(report.collected, 28);
  assert.equal(report.licenseClearance, "not-assessed");
  assert.ok(report.filesVerified >= 101);
});

async function rustEvidenceFixture(id) {
  const f = await nativeEvidenceFixture(id);
  const inventory = JSON.parse(
    await readFile("third-party/rust-lock/inventory.json", "utf8"),
  );
  const d = f.source.componentDeclarations[0];
  Object.assign(d, {
    id: "rsvg",
    declaredVersion: inventory.component.version,
    declaredSourceUrl: inventory.component.sourceUrl,
    retrieval: {
      sha256: inventory.component.archiveSha256,
      bytes: inventory.component.archiveBytes,
    },
  });
  Object.assign(f.collection.components[0], {
    id: d.id,
    declaredVersion: d.declaredVersion,
    sourceUrl: d.declaredSourceUrl,
    archiveSha256: d.retrieval.sha256,
    archiveBytes: d.retrieval.bytes,
  });
  f.collection.declarationsSha256 = hash(
    `${d.id}\t${d.declaredVersion}\t${d.declaredSourceUrl}\n`,
  );
  await cp("third-party/rust-lock", join(f.root, "third-party/rust-lock"), {
    recursive: true,
  });
  await cp(
    "scripts/inventory-rust-lock.py",
    join(f.root, "scripts/inventory-rust-lock.py"),
  );
  await cp(
    "third-party/crate-notices",
    join(f.root, "third-party/crate-notices"),
    { recursive: true },
  );
  for (const name of ["collect-crate-notices.py", "collect-native-sources.py"])
    await cp("scripts/" + name, join(f.root, "scripts/" + name));
  // The base fixture deliberately uses its own native collector identity.
  f.collection.collectorSha256 = hash(
    await readFile("scripts/collect-native-sources.py"),
  );
  const crates = JSON.parse(
    await readFile("third-party/crate-notices/collection.json", "utf8"),
  );
  const recipeFile = "third-party/sources/sharp-libvips-ebb95f8/build-posix.sh";
  await mkdir(join(f.root, "third-party/sources/sharp-libvips-ebb95f8"), {
    recursive: true,
  });
  await cp(recipeFile, join(f.root, recipeFile));
  f.source.assets.push({
    file: recipeFile,
    sha256: hash(await readFile(recipeFile)),
  });
  const nativeSource = JSON.parse(
    await readFile("third-party/libvips-source-review.json", "utf8"),
  );
  f.source.patchRecipe = nativeSource.patchRecipe;
  f.source.patches = nativeSource.patches;
  await addMutableEvidence(f, nativeSource);
  await cp("third-party/patches", join(f.root, "third-party/patches"), {
    recursive: true,
  });
  await cp(
    "third-party/rust-resolution",
    join(f.root, "third-party/rust-resolution"),
    { recursive: true },
  );
  await cp(
    "scripts/resolve-rust-scope.py",
    join(f.root, "scripts/resolve-rust-scope.py"),
  );
  const resolution = JSON.parse(
    await readFile("third-party/rust-resolution/resolution.json", "utf8"),
  );
  await cp(
    "third-party/priority-crates",
    join(f.root, "third-party/priority-crates"),
    { recursive: true },
  );
  await cp(
    "scripts/review-priority-crates.py",
    join(f.root, "scripts/review-priority-crates.py"),
  );
  const priorityReview = JSON.parse(
    await readFile("third-party/priority-crates/review.json", "utf8"),
  );
  const saveRust = async () => {
    const raw = JSON.stringify(inventory);
    await writeFile(join(f.root, "third-party/rust-lock/inventory.json"), raw);
    f.source.rustLockInventory = {
      file: "third-party/rust-lock/inventory.json",
      sha256: hash(raw),
    };
    crates.inputSha256 = hash(raw);
    const crateRaw = JSON.stringify(crates);
    await writeFile(
      join(f.root, "third-party/crate-notices/collection.json"),
      crateRaw,
    );
    f.source.crateNoticeCollection = {
      file: "third-party/crate-notices/collection.json",
      sha256: hash(crateRaw),
    };
    resolution.inputs.rustInventorySha256 = hash(raw);
    resolution.inputs.crateCollectionSha256 = hash(crateRaw);
    const resolutionRaw = JSON.stringify(resolution);
    await writeFile(
      join(f.root, "third-party/rust-resolution/resolution.json"),
      resolutionRaw,
    );
    f.source.rustResolution = {
      file: "third-party/rust-resolution/resolution.json",
      sha256: hash(resolutionRaw),
    };
    priorityReview.inputs.crateCollectionSha256 = hash(crateRaw);
    priorityReview.inputs.rustResolutionSha256 = hash(resolutionRaw);
    const priorityRaw = JSON.stringify(priorityReview);
    await writeFile(
      join(f.root, "third-party/priority-crates/review.json"),
      priorityRaw,
    );
    f.source.priorityCrateReview = {
      file: "third-party/priority-crates/review.json",
      sha256: hash(priorityRaw),
    };
    await f.save();
  };
  await saveRust();
  return { ...f, inventory, crates, resolution, priorityReview, saveRust };
}

test("rsvg exports require bound Rust inventory and unchanged original Cargo inputs", async () => {
  const f = await rustEvidenceFixture("rust-original");
  await verifyNativeSourceEvidence(f.root);
  delete f.source.rustLockInventory;
  await f.save();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Rust lock inventory required/,
  );
  await f.saveRust();
  await writeFile(
    join(f.root, "third-party/rust-lock/sources/Cargo.lock"),
    "changed",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /integrity mismatch/,
  );
});

test("Rust evidence rejects altered scope, duplicate identities and lost package checksums", async () => {
  const f = await rustEvidenceFixture("rust-semantic");
  f.inventory.scope = "compiled-graph";
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /scope/);
  f.inventory.scope = "complete-lockfile-not-compiled-graph";
  f.inventory.packages.push(f.inventory.packages[0]);
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /Duplicate Rust/);
  f.inventory.packages.pop();
  f.inventory.packages[0].checksum = null;
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /source or checksum/,
  );
});

test("Rust evidence rejects collector drift, changed archive provenance and removed raw manifests", async () => {
  const f = await rustEvidenceFixture("rust-source");
  f.inventory.component.archiveSha256 = "f".repeat(64);
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /source identity/);
  f.inventory.component.archiveSha256 =
    f.source.componentDeclarations[0].retrieval.sha256;
  f.inventory.assets = f.inventory.assets.filter(
    (a) => !a.file.endsWith("/sources/Cargo.toml"),
  );
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /workspace manifest missing/,
  );
  await writeFile(join(f.root, "scripts/inventory-rust-lock.py"), "changed");
  await assert.rejects(verifyNativeSourceEvidence(f.root), /collector digest/);
});

test("crate collection cannot omit or duplicate locked packages or fake matching archive checksums", async () => {
  const f = await rustEvidenceFixture("crate-identity");
  const first = f.crates.packages[0];
  f.crates.packages.pop();
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /omits registry packages/,
  );
  f.crates.packages.push(first);
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /package identity or checksum/,
  );
  f.crates.packages.pop();
  f.crates.packages.push(
    JSON.parse(
      await readFile("third-party/crate-notices/collection.json", "utf8"),
    ).packages.at(-1),
  );
  first.archiveSha256 = "f".repeat(64);
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /archive checksum or size/,
  );
});

test("crate export rejects missing manifests, escaped original texts and unbound collection changes", async () => {
  const f = await rustEvidenceFixture("crate-assets");
  const first = f.crates.packages[0],
    manifest = first.manifest;
  delete first.manifest;
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /manifest required/);
  first.manifest = {
    ...manifest,
    file: "third-party/crate-notices/texts/../../escape.txt",
  };
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /asset path/);
  first.manifest = manifest;
  await f.saveRust();
  await writeFile(
    join(f.root, "third-party/crate-notices/collection.json"),
    "{}",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /integrity mismatch/,
  );
});

test("explicit crate failures preserve unresolved scope but never carry successful notice claims", async () => {
  const f = await rustEvidenceFixture("crate-failure");
  const first = f.crates.packages[0];
  delete first.manifest;
  first.status = "download-failed";
  delete first.supplementary;
  delete first.supplementaryStatus;
  first.error = "offline";
  const oldNotices = first.notices;
  first.notices = [];
  f.resolution.missingNoticePackages.push({
    name: first.name,
    version: first.version,
    presentInScenarios: f.resolution.scenarios
      .filter((s) =>
        s.packages.some(
          (p) => p.name === first.name && p.version === first.version,
        ),
      )
      .map((s) => s.id),
  });
  await f.saveRust();
  assert.equal(
    (await verifyNativeSourceEvidence(f.root)).licenseClearance,
    "not-assessed",
  );
  first.notices = oldNotices;
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /failed crate collection/,
  );
});

test("crate evidence rejects collector drift and changed original manifest bytes", async () => {
  const f = await rustEvidenceFixture("crate-collector");
  await writeFile(join(f.root, "scripts/collect-crate-notices.py"), "changed");
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Crate collector digest/,
  );
  await cp(
    "scripts/collect-crate-notices.py",
    join(f.root, "scripts/collect-crate-notices.py"),
  );
  await writeFile(join(f.root, f.crates.packages[0].manifest.file), "changed");
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /integrity mismatch/,
  );
});

test("crate warnings for missing independent notices cannot be silently removed", async () => {
  const f = await rustEvidenceFixture("crate-warning");
  const missing = f.crates.packages.find((p) => p.notices.length === 0);
  assert.ok(missing);
  missing.warnings = [];
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /missing original notices warning/,
  );
});

test("crate build lock scope cannot be promoted to a verified final build", async () => {
  const f = await rustEvidenceFixture("crate-build-lock");
  f.crates.buildLockStatus = "final-build-verified";
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /build lock scope/);
});

test("supplementary source prefixes cannot be promoted to complete members or lose their capture status", async () => {
  const f = await rustEvidenceFixture("crate-followup-range");
  const item = f.crates.packages.find((p) =>
    p.supplementary?.some(
      (s) => s.kind === "rust-source-prefix" && !s.completeMember,
    ),
  );
  assert.ok(item);
  const entry = item.supplementary.find(
    (s) => s.kind === "rust-source-prefix" && !s.completeMember,
  );
  entry.completeMember = true;
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /supplementary crate byte range/,
  );
  entry.completeMember = false;
  item.supplementaryStatus = "cleared";
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Supplementary crate scope/,
  );
});

test("supplementary original material cannot disappear or escape its indexed archive path", async () => {
  const f = await rustEvidenceFixture("crate-followup-original");
  const item = f.crates.packages.find((p) => p.supplementary?.length);
  assert.ok(item);
  const entry = item.supplementary[0];
  entry.archiveMember = "../README.md";
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /asset path/);
  entry.archiveMember = `${item.name}-${item.version}/README.md`;
  await f.saveRust();
  await rm(join(f.root, entry.file));
  await assert.rejects(verifyNativeSourceEvidence(f.root), /ENOENT/);
});

test("crate recipe mutation must match its bound original line and digest", async () => {
  const f = await rustEvidenceFixture("crate-recipe-line");
  f.crates.buildRecipe.lockMutation.line += 1;
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /lock mutation evidence/,
  );
  f.crates.buildRecipe.lockMutation.line -= 1;
  f.crates.buildRecipe.sha256 = "f".repeat(64);
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /build recipe evidence/,
  );
});

test("offline Rust resolution rejects historical build claims and collector drift", async () => {
  const f = await rustEvidenceFixture("rust-resolution-scope");
  f.resolution.historicalBuildVerified = true;
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /resolution scope/);
  f.resolution.historicalBuildVerified = false;
  const host = f.resolution.toolchain.host;
  f.resolution.toolchain.host = "";
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /toolchain evidence/,
  );
  f.resolution.toolchain.host = host;
  await f.saveRust();
  await writeFile(join(f.root, "scripts/resolve-rust-scope.py"), "changed");
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /resolution collector digest/,
  );
});

test("offline Rust scenarios reject absent variants and unknown package identities", async () => {
  const f = await rustEvidenceFixture("rust-resolution-packages");
  const last = f.resolution.scenarios.pop();
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /scenarios missing/);
  f.resolution.scenarios.push(last);
  f.resolution.scenarios[0].packages[0].version = "uncollected";
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Uncollected offline Rust/,
  );
});

test("offline Rust missing-notice memberships cannot omit priority packages", async () => {
  const f = await rustEvidenceFixture("rust-resolution-missing");
  const last = f.resolution.missingNoticePackages.pop();
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /missing-notice scope omitted/,
  );
  f.resolution.missingNoticePackages.push(last);
  f.resolution.missingNoticePackages.find(
    (p) => p.name === "selectors",
  ).presentInScenarios = [];
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /missing-notice membership/,
  );
});

test("offline Rust command evidence and normalized listings stay bound to the selected scenarios", async () => {
  const f = await rustEvidenceFixture("rust-resolution-commands");
  const args = f.resolution.commands[2].arguments;
  f.resolution.commands[2].arguments = ["build"];
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /command evidence/);
  f.resolution.commands[2].arguments = args;
  await f.saveRust();
  await writeFile(
    join(f.root, f.resolution.scenarios[0].listing.file),
    "changed",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /integrity mismatch/,
  );
});

test("native source declarations reject credential-bearing and malformed HTTPS URLs", async () => {
  for (const [id, url] of [
    ["credentials", "https://review-user:fixture-only@example.test/source.tar"],
    ["missing-host", "https://"],
  ]) {
    const f = await nativeEvidenceFixture("source-url-" + id);
    f.source.componentDeclarations[0].declaredSourceUrl = url;
    f.collection.components[0].sourceUrl = url;
    f.collection.declarationsSha256 = hash(`example\t1.0\t${url}\n`);
    await f.save();
    await assert.rejects(
      verifyNativeSourceEvidence(f.root),
      /Invalid or duplicate native source declaration/,
    );
  }
});

test("priority source material cannot become publisher verification or license clearance", async () => {
  const f = await rustEvidenceFixture("priority-assessment");
  f.priorityReview.publisherSignatureVerified = true;
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /priority crate review scope/,
  );
  f.priorityReview.publisherSignatureVerified = false;
  f.priorityReview.packages[0].licenseClearance = "complete";
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /identity or assessment scope/,
  );
});

test("priority commit and source match inventories cannot drift from original VCS inputs", async () => {
  const f = await rustEvidenceFixture("priority-commit");
  const first = f.priorityReview.packages[0],
    revision = first.revision;
  first.revision = "f".repeat(40);
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /VCS identity/);
  first.revision = revision;
  first.matches.pop();
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /source match inventory/,
  );
});

test("priority source URLs stay pinned and official license snapshots stay explicitly mutable", async () => {
  const f = await rustEvidenceFixture("priority-url");
  const first = f.priorityReview.packages[0],
    original = first.matches[0].sourceUrl;
  first.matches[0].sourceUrl = original.replace(first.revision, "main");
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /fixed source relation/,
  );
  first.matches[0].sourceUrl = original;
  f.priorityReview.packages.find(
    (p) => p.name === "selectors",
  ).license.immutableReference = true;
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /official license document scope/,
  );
});

test("priority review rejects changed pinned-license blob identities and collector drift", async () => {
  const f = await rustEvidenceFixture("priority-license");
  const license = f.priorityReview.packages.find(
    (p) => p.name === "mutants",
  ).license;
  const original = license.gitBlobSha1;
  license.gitBlobSha1 = "f".repeat(40);
  await f.saveRust();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /license Git blob/);
  license.gitBlobSha1 = original;
  await f.saveRust();
  await writeFile(join(f.root, "scripts/review-priority-crates.py"), "changed");
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Priority crate collector digest/,
  );
});

async function patchEvidenceFixture(id) {
  const f = await nativeEvidenceFixture(id);
  const url =
    "https://github.com/example/source/commit/" + "a".repeat(40) + ".patch";
  const recipe = "$CURL " + url + " | patch -p1\n";
  await writeFile(join(f.root, "third-party/recipe.txt"), recipe);
  f.source.assets[0].sha256 = hash(recipe);
  f.source.patchRecipe.sha256 = hash(recipe);
  const text =
    "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
  const patch = {
    recipeLine: 1,
    url,
    immutableReference: true,
    status: "retrieved",
    sha256: hash(text),
    bytes: Buffer.byteLength(text),
    historicalBinaryMatch: "not-asserted",
    file: "third-party/patches/" + hash(text) + ".patch",
  };
  await mkdir(join(f.root, "third-party/patches"));
  await writeFile(join(f.root, patch.file), text);
  f.source.patches = [patch];
  await f.save();
  return { ...f, patch };
}

test("patch evidence refuses omitted recipe downloads and modified raw patches", async () => {
  const f = await patchEvidenceFixture("patch-omission");
  await verifyNativeSourceEvidence(f.root);
  f.source.patches = [];
  await f.save();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Patch recipe inventory mismatch/,
  );
  const changed = await patchEvidenceFixture("patch-changed");
  await writeFile(join(changed.root, changed.patch.file), "changed patch");
  await assert.rejects(
    verifyNativeSourceEvidence(changed.root),
    /integrity mismatch/,
  );
});

test("patch evidence binds recipe location, URL, byte count and historical scope", async () => {
  for (const [key, value] of [
    ["recipeLine", 2],
    ["url", "https://example.test/wrong.patch"],
    ["bytes", 1],
    ["immutableReference", false],
    ["historicalBinaryMatch", "verified"],
    ["status", "failed"],
    ["file", "third-party/../outside.patch"],
  ]) {
    const f = await patchEvidenceFixture("patch-field-" + key);
    f.patch[key] = value;
    await f.save();
    await assert.rejects(
      verifyNativeSourceEvidence(f.root),
      /[Pp]atch|native evidence asset/,
    );
  }
});

test("patch evidence refuses symlinks, duplicate references and unsupported recipe commands", async () => {
  const f = await patchEvidenceFixture("patch-link");
  await rm(join(f.root, f.patch.file));
  await symlink("../recipe.txt", join(f.root, f.patch.file));
  await assert.rejects(verifyNativeSourceEvidence(f.root), /regular file/);
  const duplicate = await patchEvidenceFixture("patch-duplicate");
  duplicate.source.patches.push({ ...duplicate.patch });
  await duplicate.save();
  await assert.rejects(
    verifyNativeSourceEvidence(duplicate.root),
    /Patch recipe inventory mismatch/,
  );
  const command = await patchEvidenceFixture("patch-command");
  const recipe = "$CURL https://example.test/change.patch | patch -p0\n";
  await writeFile(join(command.root, "third-party/recipe.txt"), recipe);
  command.source.assets[0].sha256 = hash(recipe);
  command.source.patchRecipe.sha256 = hash(recipe);
  await command.save();
  await assert.rejects(
    verifyNativeSourceEvidence(command.root),
    /Unsupported patch recipe command/,
  );
});

test("patch recipe cannot be redirected to an unrelated verified asset", async () => {
  const f = await rustEvidenceFixture("patch-recipe-redirection");
  f.source.patchRecipe = {
    file: "third-party/recipe.txt",
    sha256: hash("original recipe"),
  };
  await f.saveRust();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Patch recipe must reference/,
  );
});

test("all five original patch snapshots and the nested gvdb declaration remain bound", async () => {
  const source = JSON.parse(
    await readFile("third-party/libvips-source-review.json", "utf8"),
  );
  assert.equal(source.patches.length, 5);
  let total = 0;
  for (const patch of source.patches) {
    const bytes = await readFile(patch.file);
    assert.equal(hash(bytes), patch.sha256);
    assert.equal(bytes.length, patch.bytes);
    total += bytes.length;
  }
  assert.equal(total, 29054);
  const pr = source.patches.find((p) => p.url.includes("/pull/383.patch"));
  assert.equal(pr.immutableReference, false);
  const wrap = source.assets.find((a) => a.file.endsWith("/gvdb.wrap"));
  const glib = source.componentDeclarations.find((c) => c.id === "glib");
  assert.equal(wrap.archiveSha256, glib.retrieval.sha256);
  assert.equal(wrap.archiveMember, "glib-2.90.0/subprojects/gvdb.wrap");
  const bytes = await readFile(wrap.file);
  assert.equal(hash(bytes), wrap.sha256);
  assert.match(
    bytes.toString(),
    /^revision=2b42fc75f09dbe1cd1057580b5782b08f2dcb400$/m,
  );
  assert.match(
    await readFile(source.patchRecipe.file, "utf8"),
    /--force-fallback-for=gvdb/,
  );
  await verifyNativeSourceEvidence();
});

test("mutable PR patch snapshots cannot claim an immutable historical input", async () => {
  const f = await patchEvidenceFixture("mutable-patch");
  const recipe =
    "$CURL https://patch-diff.githubusercontent.com/raw/google/libultrahdr/pull/383.patch | patch -p1\n";
  await writeFile(join(f.root, "third-party/recipe.txt"), recipe);
  f.source.assets[0].sha256 = hash(recipe);
  f.source.patchRecipe.sha256 = hash(recipe);
  f.patch.url = recipe.split(" ")[1];
  f.patch.immutableReference = false;
  await f.save();
  await verifyNativeSourceEvidence(f.root);
  f.patch.immutableReference = true;
  await f.save();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Invalid patch identity/,
  );
  f.patch.immutableReference = false;
  await f.save();
  await rm(join(f.root, f.patch.file));
  await assert.rejects(verifyNativeSourceEvidence(f.root), /ENOENT/);
});

async function gvdbEvidenceFixture(id) {
  const f = await nativeEvidenceFixture(id);
  const actual = JSON.parse(
    await readFile("third-party/libvips-source-review.json", "utf8"),
  );
  const glib = actual.componentDeclarations.find((c) => c.id === "glib");
  f.source.componentDeclarations = [glib];
  Object.assign(f.collection.components[0], {
    id: "glib",
    declaredVersion: glib.declaredVersion,
    sourceUrl: glib.declaredSourceUrl,
    archiveSha256: glib.retrieval.sha256,
    archiveBytes: glib.retrieval.bytes,
  });
  f.collection.declarationsSha256 = hash(
    `glib\t${glib.declaredVersion}\t${glib.declaredSourceUrl}\n`,
  );
  await cp(
    "scripts/collect-native-sources.py",
    join(f.root, "scripts/collect-native-sources.py"),
  );
  await cp(
    "scripts/collect-gvdb-source.py",
    join(f.root, "scripts/collect-gvdb-source.py"),
  );
  f.collection.collectorSha256 = hash(
    await readFile("scripts/collect-native-sources.py"),
  );
  f.source.assets = actual.assets.filter(
    (a) => a.file.endsWith("/gvdb.wrap") || a.file.endsWith("/build-posix.sh"),
  );
  for (const a of f.source.assets) {
    await mkdir(join(f.root, a.file, ".."), { recursive: true });
    await cp(a.file, join(f.root, a.file));
  }
  f.source.patchRecipe = actual.patchRecipe;
  f.source.patches = actual.patches;
  await addMutableEvidence(f, actual);
  await cp("third-party/patches", join(f.root, "third-party/patches"), {
    recursive: true,
  });
  await cp("third-party/gvdb-source", join(f.root, "third-party/gvdb-source"), {
    recursive: true,
  });
  const nested = JSON.parse(
    await readFile("third-party/gvdb-source/collection.json", "utf8"),
  );
  const saveNested = async () => {
    const raw = JSON.stringify(nested);
    await writeFile(
      join(f.root, "third-party/gvdb-source/collection.json"),
      raw,
    );
    f.source.gvdbSourceCollection = {
      file: "third-party/gvdb-source/collection.json",
      sha256: hash(raw),
    };
    await f.save();
  };
  await saveNested();
  return { ...f, nested, saveNested };
}

test("GLib exports require the fixed gvdb collection and unchanged original source", async () => {
  const f = await gvdbEvidenceFixture("gvdb-absent");
  await verifyNativeSourceEvidence(f.root);
  delete f.source.gvdbSourceCollection;
  await f.save();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /gvdb collection required/,
  );
  const changed = await gvdbEvidenceFixture("gvdb-source-changed");
  await writeFile(
    join(changed.root, changed.nested.assets[0].file),
    "changed source",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(changed.root),
    /integrity mismatch/,
  );
});

test("gvdb evidence cannot lose a source file, notification or fixed revision", async () => {
  for (const [id, mutate] of [
    [
      "source",
      (n) => {
        n.assets.pop();
        n.counts.regularFiles--;
      },
    ],
    [
      "notice",
      (n) => {
        n.notices.pop();
        n.counts.noticeReferences--;
      },
    ],
    [
      "revision",
      (n) => {
        n.component.revision = "main";
      },
    ],
    [
      "parent",
      (n) => {
        n.parentWrap.archiveSha256 = "a".repeat(64);
      },
    ],
    [
      "line",
      (n) => {
        n.recipe.selectionLine++;
      },
    ],
    [
      "scope",
      (n) => {
        n.historicalBinaryMatch = "verified";
      },
    ],
    [
      "signature",
      (n) => {
        n.publisherSignatureVerified = true;
      },
    ],
    [
      "bytes",
      (n) => {
        n.assets[0].bytes++;
      },
    ],
  ]) {
    const f = await gvdbEvidenceFixture("gvdb-" + id);
    mutate(f.nested);
    await f.saveNested();
    await assert.rejects(verifyNativeSourceEvidence(f.root), /[Gg]vdb/);
  }
});

test("gvdb evidence refuses escaped source paths, symlinks, unbound indexes and collector drift", async () => {
  const f = await gvdbEvidenceFixture("gvdb-path");
  f.nested.assets[0].file = "third-party/../escape.txt";
  await f.saveNested();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /[Gg]vdb|native evidence asset/,
  );
  const link = await gvdbEvidenceFixture("gvdb-link");
  await rm(join(link.root, link.nested.assets[0].file));
  await symlink(
    "../../recipe.txt",
    join(link.root, link.nested.assets[0].file),
  );
  await assert.rejects(verifyNativeSourceEvidence(link.root), /regular file/);
  const drift = await gvdbEvidenceFixture("gvdb-collector");
  await writeFile(
    join(drift.root, "scripts/collect-gvdb-source.py"),
    "changed",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(drift.root),
    /gvdb collector digest/,
  );
  const unbound = await gvdbEvidenceFixture("gvdb-index");
  await writeFile(
    join(unbound.root, "third-party/gvdb-source/collection.json"),
    "{}",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(unbound.root),
    /integrity mismatch/,
  );
});

test("gvdb notice references and archive commit metadata cannot be reclassified", async () => {
  const f = await gvdbEvidenceFixture("gvdb-notice-source");
  f.nested.notices[0] = {
    ...f.nested.assets.find((a) => a.archiveMember.endsWith("/README.md")),
  };
  await f.saveNested();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /gvdb notice must match/,
  );
  const commit = await gvdbEvidenceFixture("gvdb-archive-commit");
  commit.nested.component.archiveCommitComment = "b".repeat(40);
  await commit.saveNested();
  await assert.rejects(
    verifyNativeSourceEvidence(commit.root),
    /gvdb fixed source identity/,
  );
});

async function addMutableEvidence(f, actual) {
  f.source.packagingRevision = actual.packagingRevision;
  f.source.nativeEnvironmentReview = { ...actual.nativeEnvironmentReview };
  await cp(
    "third-party/native-environment",
    join(f.root, "third-party/native-environment"),
    { recursive: true },
  );
  await cp(
    "scripts/native-environment.mjs",
    join(f.root, "scripts/native-environment.mjs"),
  );

  f.source.packagingSourceCollection = { ...actual.packagingSourceCollection };
  await cp(
    "third-party/packaging-source",
    join(f.root, "third-party/packaging-source"),
    { recursive: true },
  );
  await cp(
    "scripts/collect-packaging-source.py",
    join(f.root, "scripts/collect-packaging-source.py"),
  );

  f.source.mutableInputReview = { ...actual.mutableInputReview };
  for (const suffix of ["/versions.properties", "/LICENSE"]) {
    const extra = actual.assets.find((a) => a.file.endsWith(suffix));
    if (!f.source.assets.some((a) => a.file === extra.file))
      f.source.assets.push(extra);
    await mkdir(join(f.root, extra.file, ".."), { recursive: true });
    await cp(extra.file, join(f.root, extra.file));
  }

  const notice = actual.assets.find((a) =>
    a.file.endsWith("/THIRD-PARTY-NOTICES.md"),
  );
  f.source.assets.push(notice);
  await mkdir(join(f.root, notice.file, ".."), { recursive: true });
  await cp(notice.file, join(f.root, notice.file));
  await cp(
    "third-party/mutable-inputs",
    join(f.root, "third-party/mutable-inputs"),
    { recursive: true },
  );
  await cp(
    "scripts/mutable-inputs.mjs",
    join(f.root, "scripts/mutable-inputs.mjs"),
  );
}

async function mutableEvidenceFixture(id) {
  const f = await gvdbEvidenceFixture(id);
  const observed = JSON.parse(
    await readFile(join(f.root, f.source.mutableInputReview.file), "utf8"),
  );
  const saveObserved = async () => {
    const raw = JSON.stringify(observed);
    await writeFile(join(f.root, f.source.mutableInputReview.file), raw);
    f.source.mutableInputReview.sha256 = hash(raw);
    await f.save();
  };
  const replaceSnapshot = async (id, value) => {
    const entry = observed.assets.find((a) => a.id === id);
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    entry.sha256 = hash(bytes);
    entry.bytes = Buffer.byteLength(bytes);
    entry.file = "third-party/mutable-inputs/texts/" + entry.sha256 + ".txt";
    await writeFile(join(f.root, entry.file), bytes);
    await saveObserved();
  };
  return { ...f, observed, saveObserved, replaceSnapshot };
}

test("mutable input review is required and rejects unbound raw snapshots", async () => {
  const f = await mutableEvidenceFixture("mutable-review-required");
  await verifyNativeSourceEvidence(f.root);
  delete f.source.mutableInputReview;
  await f.save();
  await assert.rejects(verifyNativeSourceEvidence(f.root), /review required/);
  const changed = await mutableEvidenceFixture("mutable-raw-changed");
  await writeFile(
    join(changed.root, changed.observed.assets[0].file),
    "changed",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(changed.root),
    /integrity mismatch/,
  );
});

test("current observations cannot become historical verification or fixed mutable URLs", async () => {
  for (const [id, mutate] of [
    [
      "history",
      (r) => {
        r.historicalBuildVerified = true;
      },
    ],
    [
      "signature",
      (r) => {
        r.publisherSignatureVerified = true;
      },
    ],
    [
      "immutable",
      (r) => {
        r.assets.find((a) => a.id === "current-notice").immutableReference =
          true;
      },
    ],
    [
      "missing",
      (r) => {
        r.assets.pop();
      },
    ],
    [
      "line",
      (r) => {
        r.recipe.noticeFetchLine++;
      },
    ],
    [
      "summary",
      (r) => {
        r.summary.currentNoticeMatchesFixed = false;
      },
    ],
  ]) {
    const f = await mutableEvidenceFixture("mutable-scope-" + id);
    mutate(f.observed);
    await f.saveObserved();
    await assert.rejects(
      verifyNativeSourceEvidence(f.root),
      /Mutable input evidence/,
    );
  }
});

test("mutable provenance checks PR identities, exact diff bytes and original notice Git blobs", async () => {
  const patch = await mutableEvidenceFixture("mutable-fixed-diff");
  const entry = patch.observed.assets.find((a) => a.id === "commit-patch-1");
  const raw = await readFile(join(patch.root, entry.file), "utf8");
  await patch.replaceSnapshot("commit-patch-1", raw + "changed-diff-line\n");
  await assert.rejects(
    verifyNativeSourceEvidence(patch.root),
    /fixed commit diff differs/,
  );
  const blob = await mutableEvidenceFixture("mutable-notice-blob");
  const meta = blob.observed.assets.find(
    (a) => a.id === "fixed-notice-metadata",
  );
  const json = JSON.parse(await readFile(join(blob.root, meta.file), "utf8"));
  json.sha = "a".repeat(40);
  await blob.replaceSnapshot("fixed-notice-metadata", json);
  await assert.rejects(
    verifyNativeSourceEvidence(blob.root),
    /fixed notice Git blob mismatch/,
  );
  const pr = await mutableEvidenceFixture("mutable-pr-identity");
  const prEntry = pr.observed.assets.find((a) => a.id === "pr");
  const prJson = JSON.parse(
    await readFile(join(pr.root, prEntry.file), "utf8"),
  );
  prJson.number = 384;
  await pr.replaceSnapshot("pr", prJson);
  await assert.rejects(
    verifyNativeSourceEvidence(pr.root),
    /PR metadata mismatch/,
  );
});

test("mutable review rejects linked snapshots and verifier drift while permitting summary key reordering", async () => {
  const f = await mutableEvidenceFixture("mutable-summary-order");
  f.observed.summary = Object.fromEntries(
    Object.entries(f.observed.summary).reverse(),
  );
  await f.saveObserved();
  await verifyNativeSourceEvidence(f.root);
  const link = await mutableEvidenceFixture("mutable-snapshot-link");
  const entry = link.observed.assets[0];
  await rm(join(link.root, entry.file));
  await symlink("../../recipe.txt", join(link.root, entry.file));
  await assert.rejects(verifyNativeSourceEvidence(link.root), /regular file/);
  const drift = await mutableEvidenceFixture("mutable-verifier-drift");
  await writeFile(join(drift.root, "scripts/mutable-inputs.mjs"), "changed");
  await assert.rejects(
    verifyNativeSourceEvidence(drift.root),
    /verifier digest mismatch/,
  );
});

test("reviewed notice paths refuse linked ancestor directories", async () => {
  const f = await fixture("reviewed-ancestor-link", { reviewed: true });
  const external = join(temp, "reviewed-external-licenses");
  await mkdir(external);
  await cp(
    join(f.root, "third-party/licenses/example.txt"),
    join(external, "example.txt"),
  );
  await rm(join(f.root, "third-party/licenses"), { recursive: true });
  await symlink(external, join(f.root, "third-party/licenses"));
  await assert.rejects(
    dependencyNotices(f.root),
    /Reviewed notice.*regular file/,
  );
});

async function packagingEvidenceFixture(id) {
  const f = await gvdbEvidenceFixture(id);
  const report = JSON.parse(
    await readFile(
      join(f.root, f.source.packagingSourceCollection.file),
      "utf8",
    ),
  );
  const savePackaging = async () => {
    const raw = JSON.stringify(report);
    await writeFile(join(f.root, f.source.packagingSourceCollection.file), raw);
    f.source.packagingSourceCollection.sha256 = hash(raw);
    await f.save();
  };
  return { ...f, packaging: report, savePackaging };
}

test("fixed packaging source is required and raw helper changes are rejected", async () => {
  const f = await packagingEvidenceFixture("packaging-required");
  await verifyNativeSourceEvidence(f.root);
  delete f.source.packagingSourceCollection;
  await f.save();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Packaging source collection required/,
  );
  const raw = await packagingEvidenceFixture("packaging-raw");
  const helper = raw.packaging.assets.find((a) =>
    a.gitPath.endsWith("/Toolchain.cmake"),
  );
  await writeFile(join(raw.root, helper.file), "changed");
  await assert.rejects(
    verifyNativeSourceEvidence(raw.root),
    /integrity mismatch/,
  );
});

test("packaging evidence rejects missing helpers, wrong Git objects and historical claims", async () => {
  for (const [id, mutate] of [
    [
      "missing",
      (r) => {
        r.assets.pop();
        r.counts.regularFiles--;
      },
    ],
    [
      "tree",
      (r) => {
        r.gitTreeSha1 = "a".repeat(40);
      },
    ],
    [
      "blob",
      (r) => {
        r.assets[0].gitBlobSha1 = "a".repeat(40);
      },
    ],
    [
      "mode",
      (r) => {
        r.assets[0].gitMode = "120000";
      },
    ],
    [
      "historical",
      (r) => {
        r.historicalBuildVerified = true;
      },
    ],
    [
      "archive",
      (r) => {
        r.archive.commitComment = "main";
      },
    ],
    [
      "path",
      (r) => {
        r.assets[0].gitPath = "../escape";
      },
    ],
  ]) {
    const f = await packagingEvidenceFixture("packaging-" + id);
    mutate(f.packaging);
    await f.savePackaging();
    await assert.rejects(verifyNativeSourceEvidence(f.root), /[Pp]ackaging/);
  }
});

test("packaging evidence rejects collector drift and linked original files", async () => {
  const f = await packagingEvidenceFixture("packaging-collector");
  await writeFile(
    join(f.root, "scripts/collect-packaging-source.py"),
    "changed",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /Packaging collector digest/,
  );
  const link = await packagingEvidenceFixture("packaging-link");
  await rm(join(link.root, link.packaging.assets[0].file));
  await symlink(
    "../../recipe.txt",
    join(link.root, link.packaging.assets[0].file),
  );
  await assert.rejects(verifyNativeSourceEvidence(link.root), /regular file/);
});

async function environmentEvidenceFixture(id) {
  const f = await gvdbEvidenceFixture(id);
  const report = JSON.parse(
    await readFile(join(f.root, f.source.nativeEnvironmentReview.file), "utf8"),
  );
  const saveEnvironment = async () => {
    const raw = JSON.stringify(report);
    await writeFile(join(f.root, f.source.nativeEnvironmentReview.file), raw);
    f.source.nativeEnvironmentReview.sha256 = hash(raw);
    await f.save();
  };
  return { ...f, environment: report, saveEnvironment };
}

test("environment review is required and cannot turn declarations into historical capture", async () => {
  const absent = await environmentEvidenceFixture("environment-required");
  await verifyNativeSourceEvidence(absent.root);
  delete absent.source.nativeEnvironmentReview;
  await absent.save();
  await assert.rejects(
    verifyNativeSourceEvidence(absent.root),
    /Native environment: review required/,
  );
  for (const key of [
    "historicalBuildVerified",
    "historicalEnvironmentCaptured",
    "baselineBuilt",
  ]) {
    const f = await environmentEvidenceFixture("environment-scope-" + key);
    f.environment[key] = true;
    await f.saveEnvironment();
    await assert.rejects(
      verifyNativeSourceEvidence(f.root),
      /Native environment: invalid historical/,
    );
  }
});

test("environment declarations and CI summaries must match their original inputs", async () => {
  for (const [id, mutate] of [
    [
      "missing",
      (r) => {
        r.inputs.pop();
      },
    ],
    [
      "declaration",
      (r) => {
        r.analysis.observations[0].detail.historicalImageCaptured = true;
      },
    ],
    [
      "runner",
      (r) => {
        r.ci.selectedRuns[0].targetJobs[0].runnerLabelsReported = [
          "container-toolchain-verified",
        ];
      },
    ],
    [
      "ci-index",
      (r) => {
        r.assets.pop();
      },
    ],
    [
      "mutable",
      (r) => {
        r.assets[0].immutableReference = true;
      },
    ],
  ]) {
    const f = await environmentEvidenceFixture("environment-derived-" + id);
    mutate(f.environment);
    await f.saveEnvironment();
    await assert.rejects(
      verifyNativeSourceEvidence(f.root),
      /Native environment/,
    );
  }
});

test("environment CI snapshots cannot mix run attempts even after rebinding hashes", async () => {
  const f = await environmentEvidenceFixture("environment-ci-attempt");
  const asset = f.environment.assets.find((a) => a.id.startsWith("jobs-"));
  const raw = JSON.parse(await readFile(join(f.root, asset.file), "utf8"));
  raw.jobs[0].run_attempt = 2;
  const text = JSON.stringify(raw);
  asset.sha256 = hash(text);
  asset.bytes = Buffer.byteLength(text);
  asset.file = "third-party/native-environment/texts/" + asset.sha256 + ".txt";
  await writeFile(join(f.root, asset.file), text);
  await f.saveEnvironment();
  await assert.rejects(
    verifyNativeSourceEvidence(f.root),
    /job run\/attempt identity mismatch/,
  );
  const drift = await environmentEvidenceFixture("environment-analyzer");
  await writeFile(
    join(drift.root, "scripts/native-environment.mjs"),
    "changed",
  );
  await assert.rejects(
    verifyNativeSourceEvidence(drift.root),
    /analyzer or packaging input digest mismatch/,
  );
});

const fakeEnvironmentInputs = (dockerfile) => [
  { gitPath: "build.sh", content: "docker build --pull -t local .\n" },
  { gitPath: "platforms/linux-arm64v8/Dockerfile", content: dockerfile },
  {
    gitPath: "platforms/linuxmusl-arm64v8/Dockerfile",
    content: "FROM alpine:3.20\n",
  },
];

test("environment digest syntax and explicit version declarations never establish installed versions", () => {
  const report = analyzeEnvironmentSources(
    fakeEnvironmentInputs(
      "FROM example@sha256:" +
        "a".repeat(64) +
        "\nRUN cargo install cargo-c --version 0.10.0 --locked\nRUN rustup toolchain install nightly-2026-09-27\n",
    ),
  );
  const base = report.observations.find(
    (o) => o.kind === "base-image-reference",
  );
  assert.equal(base.detail.referenceHasDigest, true);
  assert.equal(base.detail.historicalImageCaptured, false);
  const cargo = report.observations.find((o) => o.kind === "cargo-c-selection");
  assert.equal(cargo.detail.explicitVersionArgument, true);
  assert.equal(cargo.detail.installedVersionCaptured, false);
  assert.equal(report.missingCaptures.length, 6);
});

test("environment analysis ignores command names inside echo and comment text", () => {
  const report = analyzeEnvironmentSources(
    fakeEnvironmentInputs(
      "FROM example:tag\n# RUN cargo install cargo-c\nRUN echo 'cargo install cargo-c'\nRUN echo 'dnf install meson'\nRUN echo 'pip install meson'\n",
    ),
  );
  assert.equal(
    report.observations.filter((o) =>
      [
        "cargo-c-selection",
        "os-repository-operation",
        "python-tool-install",
      ].includes(o.kind),
    ).length,
    0,
  );
});

test("environment CI metadata validates head identities and keeps runner labels as reported metadata", async () => {
  const report = JSON.parse(
    await readFile("third-party/native-environment/review.json", "utf8"),
  );
  const raw = new Map();
  for (const asset of report.assets)
    raw.set(asset.id, JSON.parse(await readFile(asset.file, "utf8")));
  const jobs = new Map(
    [36315645944, 36315646015].map((id) => [id, raw.get("jobs-" + id)]),
  );
  const ci = summarizeEnvironmentCi(raw.get("runs"), jobs);
  assert.equal(ci.selectedRuns.length, 2);
  assert.equal(ci.historicalEnvironmentCaptured, false);
  const altered = structuredClone(raw.get("runs"));
  altered.workflow_runs.find((r) => r.id === 36315645944).head_sha = "a".repeat(
    40,
  );
  assert.throws(
    () => summarizeEnvironmentCi(altered, jobs),
    /CI run identity mismatch/,
  );
  assert.throws(
    () =>
      analyzeEnvironmentSources(
        fakeEnvironmentInputs("FROM example:tag").slice(1),
      ),
    /three exact source inputs/,
  );
});

test("environment collection is offline and refuses to overwrite existing outputs", async () => {
  const source = JSON.parse(
    await readFile("third-party/native-environment/review.json", "utf8"),
  );
  const directory = join(temp, "ci-snapshots");
  await mkdir(directory);
  for (const asset of source.assets)
    await cp(asset.file, join(directory, asset.id + ".raw"));
  const destination = join(temp, "environment-collection");
  const report = await collectEnvironmentReview(
    process.cwd(),
    directory,
    destination,
  );
  assert.equal(report.ci.selectedRuns.length, 2);
  assert.equal(report.baselineBuilt, false);
  await writeFile(join(destination, "keep"), "keep");
  await assert.rejects(
    collectEnvironmentReview(process.cwd(), directory, destination),
    /EEXIST/,
  );
  assert.equal(await readFile(join(destination, "keep"), "utf8"), "keep");
});

test("a tagged commit must match package.json version; untagged commits skip", () => {
  assert.equal(versionTagBlocker("0.2.0-rc.3", null), null);
  assert.equal(versionTagBlocker("0.2.0-rc.3", "v0.2.0-rc.3"), null);
  assert.match(
    versionTagBlocker("0.2.0-rc.1", "v0.2.0-rc.3"),
    /does not match tag v0.2.0-rc.3/,
  );
});
