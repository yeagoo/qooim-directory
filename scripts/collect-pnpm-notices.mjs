// Collect exact notice files for pnpm's bundled packages that lack a LICENSE
// file in the application image. Network-dependent, evidence-only.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = resolve(root, "third-party/image-notices/global-pnpm");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sha512 = (b) => createHash("sha512").update(b).digest("base64");
const packages = [
  ["@npmcli/agent", "3.0.0"],
  ["@npmcli/fs", "4.0.0"],
  ["balanced-match", "1.0.2"],
  ["cacache", "19.0.1"],
  ["chownr", "3.0.0"],
  ["eastasianwidth", "0.2.0"],
  ["err-code", "2.0.3"],
  ["imurmurhash", "0.1.4"],
  ["jackspeak", "3.4.3"],
  ["mkdirp", "3.0.1"],
  ["ms", "2.1.3"],
  ["package-json-from-dist", "1.0.1"],
  ["path-scurry", "1.11.1"],
  ["ssri", "12.0.0"],
  ["yallist", "5.0.0"],
];
const noticePattern = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
async function fetchOk(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "qooim-image-notices/1" },
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
function tarEntries(bytes) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
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
    if (type === "0" || type === "\0")
      files.set(full, bytes.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const manifest = [];
for (const [name, version] of packages) {
  const encoded = encodeURIComponent(name);
  const registryUrl = `https://registry.npmjs.org/${encoded}/${version}`;
  const metadata = JSON.parse((await fetchOk(registryUrl)).toString());
  const tarball = await fetchOk(metadata.dist.tarball);
  const integrity = `sha512-${sha512(tarball)}`;
  if (integrity !== metadata.dist.integrity)
    throw new Error(`SRI mismatch ${name}@${version}`);
  const files = tarEntries(gunzipSync(tarball));
  const notices = [...files.entries()]
    .filter(([path]) => noticePattern.test(path.split("/").pop() ?? ""))
    .map(([path, bytes]) => ({ path, bytes }));
  const base = name.replace(/^@/, "").replace("/", "-");
  const written = [];
  for (const [index, notice] of notices.entries()) {
    const filename = `${base}-${version}${index ? "-" + index : ""}.txt`;
    await writeFile(resolve(outDir, filename), notice.bytes, { flag: "wx" });
    written.push({
      file: `third-party/image-notices/global-pnpm/${filename}`,
      sourcePath: notice.path,
      sha256: sha256(notice.bytes),
      bytes: notice.bytes.length,
    });
  }
  manifest.push({
    name,
    version,
    license: metadata.license ?? null,
    registryUrl,
    integrity,
    tarballSha256: sha256(tarball),
    gitHead: metadata.gitHead ?? null,
    repository: metadata.repository ?? null,
    noticeFiles: written,
    status: written.length ? "notice-file" : "no-standalone-notice",
  });
  console.log(`${name}@${version}: ${written.length} notice file(s)`);
}
const document = {
  format: 1,
  scope:
    "Exact npm artifacts for pnpm bundled packages missing a license file in the image. Files are copied verbatim; no license conclusion.",
  packages: manifest,
};
const manifestBytes =
  JSON.stringify(document, null, 2) + "\n";
await writeFile(resolve(outDir, "manifest.json"), manifestBytes, { flag: "wx" });
console.log(
  `wrote ${manifest.length} records, ${manifest.reduce((n, p) => n + p.noticeFiles.length, 0)} notice files`,
);
