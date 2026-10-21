import { readFile, lstat, realpath, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { verifyMutableInputEvidence } from "./mutable-inputs.mjs";
import { verifyPackagingSource } from "./packaging-source.mjs";
const revision = "ebb95f8add54eee8bed840e3fb587e4cbec857d7";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const check = (value, message) => {
  if (!value) throw new Error("Native environment: " + message);
};
export const environmentPaths = [
  "build.sh",
  "platforms/linux-arm64v8/Dockerfile",
  "platforms/linuxmusl-arm64v8/Dockerfile",
];
const runIds = [36315645944, 36315646015];
const missing = [
  "historical-image-digests",
  "os-package-snapshots-and-versions",
  "rust-toolchain-and-installer",
  "cargo-c-version-and-dependencies",
  "python-tool-versions-and-artifact-hashes",
  "final-inputs-and-output-comparison",
];

export function analyzeEnvironmentSources(inputs) {
  check(
    inputs.length === 3 &&
      new Set(inputs.map((x) => x.gitPath)).size === 3 &&
      environmentPaths.every((p) => inputs.some((x) => x.gitPath === p)),
    "three exact source inputs required",
  );
  const observations = [];
  for (const input of inputs) {
    const lines = input.content.split(/\r?\n/);
    let inRun = false;
    for (let i = 0; i < lines.length; i++) {
      const value = lines[i].trim();
      if (!value || value.startsWith("#")) continue;
      const base = value.match(
        /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?$/i,
      );
      const add = (kind, detail) =>
        observations.push({
          gitPath: input.gitPath,
          line: i + 1,
          kind,
          detail,
        });
      if (input.gitPath.endsWith("/Dockerfile")) {
        if (base)
          add("base-image-reference", {
            reference: base[1],
            referenceHasDigest: /@sha256:[a-f0-9]{64}$/.test(base[1]),
            historicalImageCaptured: false,
          });
        if (/^RUN\b/.test(value)) inRun = true;
        if (inRun) {
          if (/^(?:RUN\s+)?(?:dnf|apk)\s/.test(value))
            add("os-repository-operation", {
              declaration: value,
              repositorySnapshotCaptured: false,
            });
          if (/^(?:RUN\s+)?curl\s+https:\/\/sh\.rustup\.rs(?:\s|$)/.test(value))
            add("rustup-network-installer", {
              declaration: value,
              installerResponseCaptured: false,
            });
          const rust = value.match(/^--default-toolchain(?:=|\s+)(\S+)/);
          if (rust)
            add("rust-toolchain-selection", {
              selection: rust[1],
              floatingChannel: /^(?:nightly|beta|stable)$/.test(rust[1]),
              installedToolchainCaptured: false,
            });
          if (/^(?:RUN\s+)?cargo\s+install\s+cargo-c\b/.test(value))
            add("cargo-c-selection", {
              declaration: value,
              explicitVersionArgument: /--version(?:=|\s+)\S+/.test(value),
              installedVersionCaptured: false,
            });
          if (/^(?:RUN\s+)?(?:pip[0-9.]*|pipx)\s+install\s/.test(value))
            add("python-tool-install", {
              declaration: value,
              installedArtifactsCaptured: false,
            });
          if (!value.endsWith("\\")) inRun = false;
        }
      } else if (/^docker\s+build\s+--pull\b/.test(value))
        add("build-driver-pull", {
          declaration: value,
          historicalImageCaptured: false,
        });
    }
  }
  return {
    scope: "declarations-only-not-installed-versions",
    observations,
    missingCaptures: [...missing],
  };
}

export function summarizeEnvironmentCi(runs, jobSnapshots) {
  check(
    Array.isArray(runs.workflow_runs) &&
      runs.workflow_runs.length <= 100 &&
      Number.isSafeInteger(runs.total_count) &&
      runs.total_count >= runs.workflow_runs.length,
    "invalid runs snapshot",
  );
  const selected = runIds.map((id) => {
    const matches = runs.workflow_runs.filter((r) => r.id === id);
    check(matches.length === 1, "CI run missing or duplicate");
    const run = matches[0];
    check(
      run.name === "CI" &&
        run.head_sha === revision &&
        run.repository?.full_name === "lovell/sharp-libvips" &&
        run.run_attempt === 1,
      "CI run identity mismatch",
    );
    const jobs = jobSnapshots.get(id);
    check(
      jobs && jobs.total_count === jobs.jobs?.length && jobs.jobs.length <= 100,
      "incomplete jobs snapshot",
    );
    const seen = new Set();
    for (const job of jobs.jobs) {
      check(
        Number.isSafeInteger(job.id) &&
          !seen.has(job.id) &&
          job.run_id === id &&
          job.head_sha === revision &&
          job.run_attempt === run.run_attempt &&
          job.head_branch === run.head_branch,
        "job run/attempt identity mismatch",
      );
      seen.add(job.id);
    }
    const targets = ["build-linux-arm64v8", "build-linuxmusl-arm64v8"].map(
      (name) => {
        const matches = jobs.jobs.filter((j) => j.name === name);
        check(matches.length === 1, "ARM64 job missing or duplicate");
        const job = matches[0];
        check(
          Array.isArray(job.labels) &&
            job.labels.length <= 20 &&
            job.labels.every((l) => typeof l === "string" && l.length <= 128),
          "invalid runner labels",
        );
        return {
          id: job.id,
          name,
          conclusionReported: job.conclusion,
          runnerLabelsReported: job.labels,
        };
      },
    );
    return {
      id,
      headSha: run.head_sha,
      branchReported: run.head_branch,
      attempt: run.run_attempt,
      conclusionReported: run.conclusion,
      targetJobs: targets,
    };
  });
  return {
    scope: "job-metadata-not-container-toolchain",
    selectedRuns: selected,
    historicalEnvironmentCaptured: false,
  };
}

async function bounded(path) {
  const info = await lstat(path);
  check(
    info.isFile() &&
      (await realpath(path)) === resolve(path) &&
      info.size <= 2 * 1024 * 1024,
    "bounded regular file required",
  );
  const bytes = await readFile(path);
  check(bytes.length <= 2 * 1024 * 1024, "input grew beyond limit");
  return bytes;
}
function assetReader(root) {
  return async (entry) => {
    check(
      typeof entry.file === "string" &&
        /^third-party\/[A-Za-z0-9._/-]+$/.test(entry.file) &&
        !entry.file.split("/").some((p) => !p || p === "." || p === "..") &&
        /^[a-f0-9]{64}$/.test(entry.sha256 ?? ""),
      "invalid source asset",
    );
    const bytes = await bounded(join(root, entry.file));
    check(sha(bytes) === entry.sha256, "source asset digest mismatch");
    return bytes.length;
  };
}
async function environmentInputs(root, source, asset) {
  await asset(source.packagingSourceCollection);
  const packaging = JSON.parse(
    await bounded(join(root, source.packagingSourceCollection.file)),
  );
  const inputs = [];
  for (const gitPath of environmentPaths) {
    const entries = packaging.assets.filter((a) => a.gitPath === gitPath);
    check(entries.length === 1, "packaging environment input missing");
    const entry = entries[0];
    check((await asset(entry)) === entry.bytes, "source byte count mismatch");
    const bytes = await bounded(join(root, entry.file));
    const content = bytes.toString("utf8");
    check(Buffer.from(content).equals(bytes), "source is not UTF-8");
    inputs.push({
      gitPath,
      file: entry.file,
      sha256: entry.sha256,
      bytes: entry.bytes,
      content,
    });
  }
  return inputs;
}
const snapshotSpecifications = [
  {
    id: "runs",
    filename: "runs.raw",
    url:
      "https://api.github.com/repos/lovell/sharp-libvips/actions/runs?head_sha=" +
      revision +
      "&per_page=100",
  },
  ...runIds.map((id) => ({
    id: "jobs-" + id,
    filename: "jobs-" + id + ".raw",
    url:
      "https://api.github.com/repos/lovell/sharp-libvips/actions/runs/" +
      id +
      "/jobs?per_page=100",
  })),
];

export async function collectEnvironmentReview(root, ciDirectory, destination) {
  root = resolve(root);
  const source = JSON.parse(
    await bounded(join(root, "third-party/libvips-source-review.json")),
  );
  const asset = assetReader(root);
  for (const entry of source.assets) await asset(entry);
  await verifyMutableInputEvidence(root, source, asset);
  await verifyPackagingSource(root, source, asset);
  const inputs = await environmentInputs(root, source, asset);
  const snapshots = [];
  for (const spec of snapshotSpecifications)
    snapshots.push({
      ...spec,
      raw: await bounded(join(ciDirectory, spec.filename)),
    });
  const jobs = new Map(
    runIds.map((id) => [
      id,
      JSON.parse(snapshots.find((s) => s.id === "jobs-" + id).raw),
    ]),
  );
  const ci = summarizeEnvironmentCi(JSON.parse(snapshots[0].raw), jobs);
  const analysis = analyzeEnvironmentSources(inputs);
  await mkdir(destination, { mode: 0o700 });
  await mkdir(join(destination, "texts"), { mode: 0o700 });
  const assets = [];
  for (const snapshot of snapshots) {
    const hash = sha(snapshot.raw);
    await writeFile(join(destination, "texts", hash + ".txt"), snapshot.raw, {
      flag: "wx",
      mode: 0o600,
    });
    assets.push({
      id: snapshot.id,
      file: "third-party/native-environment/texts/" + hash + ".txt",
      sha256: hash,
      bytes: snapshot.raw.length,
      sourceUrl: snapshot.url,
      immutableReference: false,
    });
  }
  const report = {
    format: 1,
    scope: "declared-environment-and-ci-metadata-not-historical-capture",
    historicalBuildVerified: false,
    historicalEnvironmentCaptured: false,
    baselineBuilt: false,
    licenseClearance: "not-assessed",
    analyzerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    packagingCollectionSha256: source.packagingSourceCollection.sha256,
    inputs: inputs.map(({ content, ...entry }) => entry),
    assets,
    analysis,
    ci,
  };
  await writeFile(
    join(destination, "review.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return report;
}

export async function verifyNativeEnvironment(root, source, asset) {
  if (!source.assets.some((a) => a.file.endsWith("/build-posix.sh"))) return;
  const pointer = source.nativeEnvironmentReview;
  check(
    pointer?.file === "third-party/native-environment/review.json",
    "review required",
  );
  await asset(pointer);
  const report = JSON.parse(await bounded(join(root, pointer.file)));
  check(
    report.format === 1 &&
      report.scope ===
        "declared-environment-and-ci-metadata-not-historical-capture" &&
      report.historicalBuildVerified === false &&
      report.historicalEnvironmentCaptured === false &&
      report.baselineBuilt === false &&
      report.licenseClearance === "not-assessed",
    "invalid historical/baseline scope",
  );
  check(
    report.analyzerSha256 ===
      sha(await readFile(join(root, "scripts/native-environment.mjs"))) &&
      report.packagingCollectionSha256 ===
        source.packagingSourceCollection.sha256,
    "analyzer or packaging input digest mismatch",
  );
  const inputs = await environmentInputs(root, source, asset);
  check(
    isDeepStrictEqual(
      report.inputs,
      inputs.map(({ content, ...entry }) => entry),
    ),
    "source inputs mismatch",
  );
  check(
    isDeepStrictEqual(report.analysis, analyzeEnvironmentSources(inputs)),
    "derived declarations mismatch",
  );
  check(
    Array.isArray(report.assets) &&
      report.assets.length === snapshotSpecifications.length,
    "CI snapshot inventory incomplete",
  );
  const snapshots = new Map();
  for (const entry of report.assets) {
    const spec = snapshotSpecifications.find((s) => s.id === entry.id);
    check(
      spec &&
        !snapshots.has(entry.id) &&
        entry.immutableReference === false &&
        entry.sourceUrl === spec.url &&
        entry.file ===
          "third-party/native-environment/texts/" + entry.sha256 + ".txt" &&
        (await asset(entry)) === entry.bytes,
      "CI snapshot identity mismatch",
    );
    snapshots.set(entry.id, JSON.parse(await bounded(join(root, entry.file))));
  }
  const ci = summarizeEnvironmentCi(
    snapshots.get("runs"),
    new Map(runIds.map((id) => [id, snapshots.get("jobs-" + id)])),
  );
  check(isDeepStrictEqual(report.ci, ci), "derived CI metadata mismatch");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ciDirectory, destination, ...extra] = process.argv.slice(2);
  if (command !== "collect" || !ciDirectory || !destination || extra.length)
    throw new Error(
      "Usage: node scripts/native-environment.mjs collect CI_DIRECTORY NEW_DIRECTORY",
    );
  const report = await collectEnvironmentReview(".", ciDirectory, destination);
  process.stdout.write(
    JSON.stringify({
      observations: report.analysis.observations.length,
      ciRuns: report.ci.selectedRuns.length,
      historicalEnvironmentCaptured: false,
    }) + "\n",
  );
}
