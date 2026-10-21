// Build reviewer-facing evidence for the current image distribution scopes.
// It records immutable image identities, inventories and digest manifests. It
// does not assert that any license obligation is satisfied.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const linesHash = (lines) => sha256(lines.sort().join("\n") + "\n");
const docker = async (args) =>
  (
    await exec("docker", args, {
      timeout: 180000,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;

const inspect = async (reference) => {
  const [item] = JSON.parse(
    await docker(["image", "inspect", reference]),
  );
  return {
    id: item.Id,
    architecture: item.Architecture,
    os: item.Os,
    repoDigests: item.RepoDigests,
    labels: item.Config?.Labels ?? {},
  };
};

const run = async (reference, entrypoint, args) =>
  docker([
    "run",
    "--rm",
    "--pull=never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--entrypoint",
    entrypoint,
    reference,
    ...args,
  ]);

async function writeEvidence(directory, id, body) {
  const file = join(directory, `${id}.json`);
  await mkdir(directory, { recursive: true });
  const document = {
    format: 1,
    scope: id,
    collectedAt: new Date().toISOString(),
    collectorSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    ...body,
    limitations:
      "Inventory and identity evidence only. No license clearance, linking analysis, corresponding-source delivery or vulnerability assessment.",
  };
  const bytes = JSON.stringify(document, null, 2) + "\n";
  try {
    await lstat(file);
    throw new Error(`Evidence already exists: ${file}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(file, bytes, { flag: "wx", mode: 0o644 });
  return { file, sha256: sha256(Buffer.from(bytes)) };
}

const inventoryPath = resolve(root, ".local/license-evidence/app-inventory.json");
const inventoryBytes = await readFile(inventoryPath);
const inventory = JSON.parse(inventoryBytes);
const runtime = inventory.runtime;
const appImage = await inspect(inventory.reference);
const appCommon = {
  image: {
    reference: inventory.reference,
    id: inventory.image.id,
    repoDigests: appImage.repoDigests,
    architecture: inventory.image.architecture,
    os: inventory.image.os,
  },
  basis: {
    inventory: ".local/license-evidence/app-inventory.json",
    inventorySha256: sha256(inventoryBytes),
    collector: "scripts/distribution.mjs inventoryImage (format 2)",
  },
};
const packageLine = (p) => `${p.name}\t${p.version}\t${p.license ?? ""}`;
const packageManifest = linesHash(runtime.packages.map(packageLine));
const osPackageManifest = linesHash(
  runtime.osPackages.map((p) => `${p.name}\t${p.version}\t${p.architecture ?? ""}`),
);
const noticeManifest = linesHash(
  runtime.notices.map((n) => `${n.path}\t${n.sha256}`),
);
const noticesUnder = (prefix) =>
  runtime.notices
    .filter((n) => n.path.startsWith(prefix))
    .map(({ text, ...notice }) => notice);

const outputDirectory = resolve(root, "third-party/image-evidence");
const written = {};

written["node-base"] = await writeEvidence(outputDirectory, "node-base", {
  ...appCommon,
  observations: {
    baseImage: (
      await readFile(resolve(root, "Dockerfile"), "utf8")
    ).match(/^FROM\s+(\S+)/m)?.[1],
    osRelease: runtime.osRelease,
    node: runtime.node,
    nodeBinarySha256: (
      await run(inventory.image.id, "sh", [
        "-c",
        "sha256sum /usr/local/bin/node",
      ])
    ).trim(),
    osPackageCount: runtime.osPackages.length,
    osPackageManifestSha256: osPackageManifest,
    osPackages: runtime.osPackages.map(({ name, version, architecture }) => ({
      name,
      version,
      architecture,
    })),
    osLicenseFileCount: noticesUnder("/usr/share/doc/").length,
    nodeLicense: noticesUnder("/usr/local/LICENSE"),
    globalTools: (
      await run(inventory.image.id, "sh", [
        "-c",
        "for p in npm corepack; do node -p \"require('/usr/local/lib/node_modules/'+process.argv[1]+'/package.json').name+'\\t'+require('/usr/local/lib/node_modules/'+process.argv[1]+'/package.json').version+'\\t'+(require('/usr/local/lib/node_modules/'+process.argv[1]+'/package.json').license??'')\" \"$p\"; done",
      ])
    )
      .trim()
      .split("\n"),
  },
});

const pnpmBundled = JSON.parse(
  await run(inventory.image.id, "node", [
    "-e",
    `const crypto=require("crypto"),fs=require("fs"),path=require("path");
const base="/usr/local/lib/node_modules/pnpm/dist/node_modules";
const out=[];
const hash=(f)=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
for(const name of fs.readdirSync(base).sort()){
  const dir=path.join(base,name);
  if(!fs.statSync(dir).isDirectory()) continue;
  const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);
    if(e.isDirectory()){if(e.name!=="node_modules")walk(f);}
    else if(e.name==="package.json"){const p=JSON.parse(fs.readFileSync(f,"utf8"));if(p.name&&p.version)out.push({name:p.name,version:p.version,license:p.license??null,dir:d});}
  }};
  walk(dir);
}
for(const p of out){p.licenseFiles=fs.readdirSync(p.dir).filter((n)=>/^(licen[cs]e|copying|notice)([._-].*)?$/i.test(n)).map((n)=>({name:n,sha256:hash(path.join(p.dir,n))}));delete p.dir;}
console.log(JSON.stringify(out.sort((a,b)=>a.name.localeCompare(b.name))));`,
  ]),
);
const pnpmLicense = noticesUnder("/usr/local/lib/node_modules/pnpm/LICENSE")[0];
written["global-pnpm"] = await writeEvidence(outputDirectory, "global-pnpm", {
  ...appCommon,
  observations: {
    pnpm: runtime.pnpm,
    pnpmLicense,
    bundledPackageCount: pnpmBundled.length,
    bundledPackageManifestSha256: linesHash(
      pnpmBundled.map((p) => `${p.name}\t${p.version}\t${p.license ?? ""}`),
    ),
    bundledPackages: pnpmBundled,
    bundledLicenseFileCount: pnpmBundled.reduce(
      (total, item) => total + item.licenseFiles.length,
      0,
    ),
    bundledPackagesWithoutLicenseFile: pnpmBundled
      .filter((item) => !item.licenseFiles.length)
      .map((item) => `${item.name}@${item.version}`),
  },
});

const packageOf = (name) =>
  runtime.packages.find((p) => p.name === name) ?? null;
written["next-swc"] = await writeEvidence(outputDirectory, "next-swc", {
  ...appCommon,
  observations: {
    packages: [
      packageOf("next"),
      packageOf("@next/swc-linux-arm64-gnu"),
      packageOf("@next/swc-linux-arm64-musl"),
    ].filter(Boolean),
    nativeBinaries: runtime.nativeBinaries.filter((b) =>
      b.package.startsWith("@next/swc-"),
    ),
    nextLicense: noticesUnder("/node_modules/next/").filter((n) =>
      n.path.endsWith("/next/license.md"),
    ),
    embeddedRustDependencies:
      "Not enumerated by this inventory; see third-party/rust-lock/inventory.json and docs/RUST-LOCK-REVIEW.md.",
  },
});
written["esbuild"] = await writeEvidence(outputDirectory, "esbuild", {
  ...appCommon,
  observations: {
    packages: [packageOf("@esbuild/linux-arm64"), packageOf("esbuild")].filter(
      Boolean,
    ),
    nativeBinaries: runtime.nativeBinaries.filter(
      (b) => b.package === "@esbuild/linux-arm64",
    ),
    packageLicenseFiles: runtime.notices.filter((n) =>
      /\/esbuild(@[^/]*)?\/(?:LICENSE|LICENSE\.md)$/.test(n.path),
    ),
    embeddedGoDependencies:
      "Not enumerated by this inventory; the executable is distributed as a compiled Go binary.",
  },
});
async function alpineScope(reference, id, binaryNames) {
  const image = await inspect(reference);
  const database = await run(image.id, "sh", [
    "-c",
    "cat /lib/apk/db/installed; echo '@@VERSIONS@@'; for b in " +
      binaryNames.join(" ") +
      "; do p=$(command -v $b || true); [ -n \"$p\" ] && sha256sum \"$p\"; done",
  ]);
  const [databaseText, versionText = ""] = database.split("@@VERSIONS@@");
  const records = [];
  let current = {};
  for (const line of databaseText.split("\n")) {
    if (!line.trim()) {
      if (current.name) records.push(current);
      current = {};
      continue;
    }
    const key = line[0];
    const value = line.slice(2);
    if (key === "P") current.name = value;
    else if (key === "V") current.version = value;
    else if (key === "L") current.license = value;
    else if (key === "o") current.origin = value;
    else if (key === "A") current.architecture = value;
  }
  if (current.name) records.push(current);
  const licenseCounts = {};
  for (const record of records) {
    const key = record.license || "(not declared)";
    licenseCounts[key] = (licenseCounts[key] ?? 0) + 1;
  }
  return writeEvidence(outputDirectory, id, {
    image: {
      reference,
      id: image.id,
      repoDigests: image.repoDigests,
      architecture: image.architecture,
      os: image.os,
      labels: image.labels,
    },
    observations: {
      packageCount: records.length,
      packageManifestSha256: linesHash(
        records.map((r) => `${r.name}\t${r.version}\t${r.license ?? ""}`),
      ),
      packages: records.map(({ name, version, license, origin, architecture }) => ({
        name,
        version,
        license: license ?? null,
        origin: origin ?? null,
        architecture: architecture ?? null,
      })),
      declaredLicenseCounts: licenseCounts,
      binaryVersions: versionText.trim().split("\n").filter(Boolean),
      licenseTextFilesPresent: false,
      note: "The runtime image contains no /usr/share/licenses or /usr/share/doc tree; package license declarations come from /lib/apk/db/installed and are not license texts.",
    },
  });
}

written["postgres-image"] = await alpineScope(
  "postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873",
  "postgres-image",
  ["postgres"],
);
written["demo-proxy-image"] = await alpineScope(
  "caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f",
  "demo-proxy-image",
  ["caddy"],
);

console.log(JSON.stringify(written, null, 2));
