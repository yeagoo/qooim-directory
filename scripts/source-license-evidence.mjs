// Collect exact-version package evidence for the four unresolved source notice
// gaps. This only records what the published artifacts and pinned revisions
// contain; it does not decide that a notice is legally sufficient.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes) => createHash("sha512").update(bytes).digest("base64");
const noticePattern = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

async function fetchOk(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "navigation-license-evidence/1" },
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), url: response.url };
}

// Minimal tar reader: regular files only, no extraction to disk.
function tarEntries(bytes) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(),
      8,
    );
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;
    if (type === "0" || type === "\0") {
      files.set(full, bytes.subarray(offset, offset + size));
    } else if (type === "L") {
      // GNU long name: next entry already carries the real header; keep simple
      // by ignoring the pseudo entry. npm tarballs normally use ustar only.
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

async function packageRecord(name, version) {
  const encoded = encodeURIComponent(name);
  const registryUrl = `https://registry.npmjs.org/${encoded}/${version}`;
  const metadata = JSON.parse((await fetchOk(registryUrl)).bytes.toString());
  const tarball = await fetchOk(metadata.dist.tarball);
  const integrity = `sha512-${sha512(tarball.bytes)}`;
  if (integrity !== metadata.dist.integrity)
    throw new Error(`SRI mismatch for ${name}@${version}`);
  const files = tarEntries(gunzipSync(tarball.bytes));
  const names = [...files.keys()].sort();
  const notices = names
    .filter((path) => noticePattern.test(path.split("/").pop() ?? ""))
    .map((path) => ({
      path,
      bytes: files.get(path).length,
      sha256: sha256(files.get(path)),
    }));
  const manifestText = names
    .map(
      (path) =>
        `${path}\t${files.get(path).length}\t${sha256(files.get(path))}\n`,
    )
    .join("");
  const parsed = metadata;
  const packageDoc = JSON.parse(
    (await fetchOk(`https://registry.npmjs.org/${encoded}`)).bytes.toString(),
  );
  parsed.time = packageDoc.time ?? {};
  if (packageDoc.maintainers && !parsed.maintainers)
    parsed.maintainers = packageDoc.maintainers;
  return {
    name,
    version,
    registryUrl,
    tarballUrl: metadata.dist.tarball,
    shasum: metadata.dist.shasum,
    integrity,
    tarballBytes: tarball.bytes.length,
    tarballSha256: sha256(tarball.bytes),
    fileCount: names.length,
    fileListSha256: sha256(manifestText),
    noticeCandidates: notices,
    declaresLicense: parsed.license ?? null,
    author: parsed.author ?? null,
    maintainers: parsed.maintainers ?? null,
    repository: parsed.repository ?? null,
    homepage: parsed.homepage ?? null,
    bugs: parsed.bugs ?? null,
    publishedAt: parsed.time?.[version] ?? null,
    publisher: parsed._npmUser?.name ?? null,
  };
}

async function github(path, accept = "application/vnd.github+json") {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { accept, "user-agent": "navigation-license-evidence/1" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status} ${path}`);
  return response.json();
}

const locks = JSON.parse(
  await readFile(resolve(root, "third-party/review.json"), "utf8"),
);
const byName = new Map(
  [...locks.notices, ...locks.pending].map((item) => [
    `${item.name}@${item.version}`,
    item,
  ]),
);

const targets = [
  ["@better-auth/utils", "0.5.0"],
  ["client-only", "0.0.1"],
  ["@img/sharp-libvips-linux-arm64", "1.3.4"],
  ["@img/sharp-libvips-linuxmusl-arm64", "1.3.4"],
];
const packages = [];
for (const [name, version] of targets) {
  const record = await packageRecord(name, version);
  const prior = byName.get(`${name}@${version}`);
  if (!prior || prior.registryIntegrity !== record.integrity)
    throw new Error(`Evidence does not match reviewed integration: ${name}`);
  packages.push(record);
}

const utilsRevision = "f03c1c76aff7bfa3f4de4af47b112315c770a0d1";
const utilsCommit = await github(`repos/better-auth/utils/commits/${utilsRevision}`);
const utilsRoot = await github(
  `repos/better-auth/utils/contents?ref=${utilsRevision}`,
);
const laterLicense = await fetchOk(
  "https://raw.githubusercontent.com/better-auth/utils/ef522888b7b2/LICENSE",
);

const clientOnly = packages.find((item) => item.name === "client-only");
const betterAuth = packages.find((item) => item.name === "@better-auth/utils");
const report = {
  format: 1,
  collectedAt: new Date().toISOString(),
  scope:
    "Exact published artifacts and pinned upstream revisions. Recording absence or presence of notice text is not a legal clearance decision.",
  collectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  lockfileSha256: sha256(
    await readFile(resolve(root, "pnpm-lock.yaml")),
  ),
  packages,
  findings: {
    betterAuthUtils: {
      package: `${betterAuth.name}@${betterAuth.version}`,
      exactRevision: utilsRevision,
      revisionTree: utilsRoot.map((entry) => ({
        name: entry.name,
        type: entry.type,
      })),
      revisionHasLicenseFile: utilsRoot.some((entry) =>
        noticePattern.test(entry.name),
      ),
      commitMessage: utilsCommit.commit.message,
      commitAuthorDate: utilsCommit.commit.author.date,
      laterLicenseCommit: "ef522888b7b2",
      laterLicenseDate: "2026-07-27T19:11:40Z",
      laterLicenseSha256: sha256(laterLicense.bytes),
      laterLicenseText: laterLicense.bytes.toString(),
      conclusion:
        "The exact release revision has no LICENSE/COPYING/NOTICE file. A later commit added an MIT text; it is recorded for a maintainer decision only and is not treated as the release notice.",
    },
    clientOnly: {
      package: `${clientOnly.name}@${clientOnly.version}`,
      publisher: clientOnly.publisher,
      publishedAt: clientOnly.publishedAt,
      repository: clientOnly.repository,
      homepage: clientOnly.homepage,
      bugs: clientOnly.bugs,
      packageJson: "package.json declares MIT, no copyright line",
      conclusion:
        "The published tarball contains no notice text and no repository field. Maintainer provenance (React team) does not by itself establish the package-specific copyright line.",
    },
    sharpLibvips: {
      packages: packages
        .filter((item) => item.name.startsWith("@img/sharp-libvips"))
        .map((item) => ({
          name: item.name,
          version: item.version,
          noticeCandidates: item.noticeCandidates,
        })),
      componentReview: "libvips-source-review.json",
      componentNoticeCollection: "component-notices.json",
      conclusion:
        "Package-level tarball contents are unchanged; the 28 declared components and their notice/source gaps remain governed by the existing component review.",
    },
  },
};
const destination = resolve(root, "third-party/source-license-evidence.json");
await writeFile(destination, JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
  mode: 0o644,
});
console.log(
  JSON.stringify(
    {
      file: "third-party/source-license-evidence.json",
      packages: packages.length,
      sha256: sha256(await readFile(destination)),
    },
    null,
    2,
  ),
);
