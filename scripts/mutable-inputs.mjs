import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const requireEvidence = (condition, message) => {
  if (!condition) throw new Error("Mutable input evidence: " + message);
};
const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) &&
  Number.isFinite(Date.parse(value));
const text = (bytes) => {
  const value = bytes.toString("utf8");
  requireEvidence(Buffer.from(value).equals(bytes), "invalid UTF-8 patch");
  return value;
};
function diffBody(value, commit) {
  requireEvidence(
    value.startsWith(`From ${commit} Mon Sep 17 00:00:00 2001\n`),
    "patch commit header mismatch",
  );
  const start = value.indexOf("diff --git ");
  requireEvidence(start >= 0, "patch has no diff body");
  // format-patch series adds separator newlines; no other whitespace is normalized.
  return Buffer.from(value.slice(start).replace(/\n+$/, ""));
}

export async function verifyMutableInputEvidence(root, source, asset) {
  const recipes = source.assets.filter((a) =>
    a.file.endsWith("/build-posix.sh"),
  );
  if (!recipes.length) return;
  const pointer = source.mutableInputReview;
  requireEvidence(
    pointer?.file === "third-party/mutable-inputs/review.json",
    "review required for packaging recipe",
  );
  await asset(pointer);
  const report = JSON.parse(await readFile(join(root, pointer.file), "utf8"));
  requireEvidence(
    report.format === 1 &&
      report.scope === "mutable-input-observations-not-historical-build" &&
      report.historicalBuildVerified === false &&
      report.publisherSignatureVerified === false &&
      report.licenseClearance === "not-assessed",
    "invalid observation scope",
  );
  requireEvidence(
    report.verifierSha256 ===
      sha(await readFile(join(root, "scripts/mutable-inputs.mjs"))),
    "verifier digest mismatch",
  );
  const revision = "ebb95f8add54eee8bed840e3fb587e4cbec857d7";
  requireEvidence(
    source.packagingRevision === revision &&
      recipes.length === 1 &&
      report.recipe?.file === recipes[0].file &&
      report.recipe.sha256 === recipes[0].sha256 &&
      (await asset(report.recipe)) === report.recipe.bytes,
    "recipe identity mismatch",
  );
  const noticeUrl =
    "https://raw.githubusercontent.com/lovell/sharp-libvips/main/THIRD-PARTY-NOTICES.md";
  const lines = (await readFile(join(root, report.recipe.file), "utf8")).split(
    /\r?\n/,
  );
  requireEvidence(
    Number.isSafeInteger(report.recipe.noticeFetchLine) &&
      lines[report.recipe.noticeFetchLine - 1] === "$CURL -O " + noticeUrl &&
      lines.filter((line) => line === "$CURL -O " + noticeUrl).length === 1,
    "notice fetch line mismatch",
  );
  const fixedCommits = [
    "e2daed8da97d8857dcec2fd68d2f6f3326170f67",
    "7af35883ee575266cc43bbd05686734ebd5b1a82",
  ];
  const lastNotice = "b2a873eff17decd90e534e97ec6a63e08b705a81";
  const expected = {
    pr: ["https://api.github.com/repos/google/libultrahdr/pulls/383", false],
    "pr-commits": [
      "https://api.github.com/repos/google/libultrahdr/pulls/383/commits?per_page=100",
      false,
    ],
    "packaging-commit": [
      "https://api.github.com/repos/lovell/sharp-libvips/commits/" + revision,
      true,
    ],
    "notice-history": [
      "https://api.github.com/repos/lovell/sharp-libvips/commits?path=THIRD-PARTY-NOTICES.md&sha=" +
        revision +
        "&per_page=100",
      true,
    ],
    "commit-patch-1": [
      "https://github.com/google/libultrahdr/commit/" +
        fixedCommits[0] +
        ".patch",
      true,
    ],
    "commit-patch-2": [
      "https://github.com/google/libultrahdr/commit/" +
        fixedCommits[1] +
        ".patch",
      true,
    ],
    "last-notice": [
      "https://raw.githubusercontent.com/lovell/sharp-libvips/" +
        lastNotice +
        "/THIRD-PARTY-NOTICES.md",
      true,
    ],
    "current-notice": [noticeUrl, false],
    "current-pr-patch": [
      "https://patch-diff.githubusercontent.com/raw/google/libultrahdr/pull/383.patch",
      false,
    ],
    "fixed-notice-metadata": [
      "https://api.github.com/repos/lovell/sharp-libvips/contents/THIRD-PARTY-NOTICES.md?ref=" +
        revision,
      true,
    ],
  };
  requireEvidence(
    Array.isArray(report.assets) &&
      report.assets.length === Object.keys(expected).length,
    "snapshot inventory incomplete",
  );
  const bytes = new Map();
  for (const entry of report.assets) {
    const reference = expected[entry.id];
    requireEvidence(
      reference &&
        !bytes.has(entry.id) &&
        entry.sourceUrl === reference[0] &&
        entry.immutableReference === reference[1] &&
        entry.file ===
          "third-party/mutable-inputs/texts/" + entry.sha256 + ".txt" &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0 &&
        (await asset(entry)) === entry.bytes,
      "snapshot identity or byte count mismatch",
    );
    bytes.set(entry.id, await readFile(join(root, entry.file)));
  }
  const json = (id) => JSON.parse(bytes.get(id).toString("utf8"));
  const pr = json("pr"),
    commits = json("pr-commits"),
    packaging = json("packaging-commit"),
    history = json("notice-history");
  requireEvidence(
    pr.number === 383 &&
      pr.base?.repo?.full_name === "google/libultrahdr" &&
      pr.head?.sha === fixedCommits[1] &&
      pr.merged === true &&
      pr.state === "closed" &&
      timestamp(pr.merged_at),
    "PR metadata mismatch",
  );
  requireEvidence(
    Array.isArray(commits) &&
      commits.length === 2 &&
      commits.every(
        (c, i) =>
          c.sha === fixedCommits[i] && timestamp(c.commit?.committer?.date),
      ),
    "PR commit list mismatch",
  );
  requireEvidence(
    packaging.sha === revision && timestamp(packaging.commit?.committer?.date),
    "packaging commit mismatch",
  );
  requireEvidence(
    Array.isArray(history) &&
      history.length > 0 &&
      history.length <= 100 &&
      history[0].sha === lastNotice &&
      history.every(
        (c) =>
          /^[a-f0-9]{40}$/.test(c.sha ?? "") &&
          timestamp(c.commit?.committer?.date),
      ),
    "notice history snapshot mismatch",
  );
  const patch = source.patches.find(
    (p) => p.url === expected["current-pr-patch"][0],
  );
  requireEvidence(
    patch &&
      patch.immutableReference === false &&
      patch.historicalBinaryMatch === "not-asserted",
    "retained mutable patch missing",
  );
  await asset(patch);
  const retained = await readFile(join(root, patch.file));
  const segments = text(retained).split(
    /(?=^From [a-f0-9]{40} Mon Sep 17 00:00:00 2001$)/m,
  );
  requireEvidence(segments.length === 2, "retained patch series mismatch");
  const patchDiffs = fixedCommits.map((commit, i) => {
    const body = diffBody(segments[i], commit),
      fixed = diffBody(text(bytes.get("commit-patch-" + (i + 1))), commit);
    requireEvidence(
      body.equals(fixed),
      "fixed commit diff differs from retained patch",
    );
    return { commit, bytes: body.length, sha256: sha(body) };
  });
  const notice = source.assets.find(
    (a) =>
      a.file ===
      "third-party/sources/sharp-libvips-ebb95f8/THIRD-PARTY-NOTICES.md",
  );
  requireEvidence(notice, "fixed notice asset missing");
  await asset(notice);
  const fixedNotice = await readFile(join(root, notice.file));
  requireEvidence(
    bytes.get("last-notice").equals(fixedNotice),
    "last fixed notice differs",
  );
  const metadata = json("fixed-notice-metadata");
  const encoded =
    typeof metadata.content === "string"
      ? metadata.content.replace(/\s/g, "")
      : "";
  const decoded = Buffer.from(encoded, "base64");
  const blobSha = createHash("sha1")
    .update(Buffer.from("blob " + fixedNotice.length + "\0"))
    .update(fixedNotice)
    .digest("hex");
  requireEvidence(
    metadata.type === "file" &&
      metadata.path === "THIRD-PARTY-NOTICES.md" &&
      metadata.encoding === "base64" &&
      metadata.size === fixedNotice.length &&
      metadata.sha === blobSha &&
      decoded.equals(fixedNotice) &&
      decoded.toString("base64") === encoded &&
      metadata.download_url ===
        "https://raw.githubusercontent.com/lovell/sharp-libvips/" +
          revision +
          "/THIRD-PARTY-NOTICES.md",
    "fixed notice Git blob mismatch",
  );
  const summary = {
    packagingCommitterTime: packaging.commit.committer.date,
    prMergedAt: pr.merged_at,
    prCommitIds: fixedCommits,
    patchDiffs,
    noticeHistoryCount: history.length,
    lastNoticeCommit: lastNotice,
    fixedNoticeGitBlobSha1: blobSha,
    currentNoticeMatchesFixed: bytes.get("current-notice").equals(fixedNotice),
    currentPrMatchesRetained: bytes.get("current-pr-patch").equals(retained),
  };
  requireEvidence(
    isDeepStrictEqual(report.summary, summary),
    "derived observation summary mismatch",
  );
  return summary;
}
