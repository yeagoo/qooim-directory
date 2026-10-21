// Read-only release preflight. It never starts the stack, writes .env, or
// prints secret values. Hard failures exit 1; expected release blockers are
// reported but do not turn this into a release approval.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });
const run = (command, args, options = {}) => {
  try {
    return {
      ok: true,
      out: execFileSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
        ...options,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      out: String(error.stderr ?? error.message ?? "").trim(),
    };
  }
};
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");

// Runtime
const nodeMajor = Number(process.versions.node.split(".")[0]);
add(
  "Node.js",
  nodeMajor >= 24 ? "pass" : "fail",
  `v${process.versions.node}${nodeMajor >= 24 ? "" : "（需要 >=24）"}`,
);
const pnpm = run("pnpm", ["--version"]);
add(
  "pnpm",
  pnpm.ok && pnpm.out === "10.11.1" ? "pass" : "fail",
  pnpm.ok ? pnpm.out : "pnpm 不可用",
);
const openssl = run("openssl", ["version"]);
add("OpenSSL", openssl.ok ? "pass" : "fail", openssl.out || "不可用");
const python = run("python3", ["--version"]);
add("Python 3", python.ok ? "pass" : "fail", python.out || "不可用");

// Docker: direct first, sudo fallback only for detection.
let dockerMode = null;
const directDocker = run("docker", [
  "info",
  "--format",
  "{{.ServerVersion}}",
]);
if (directDocker.ok) dockerMode = "direct";
else {
  const sudoDocker = run("sudo", [
    "-n",
    "docker",
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  if (sudoDocker.ok) dockerMode = "sudo";
}
add(
  "Docker daemon",
  dockerMode ? "pass" : "fail",
  dockerMode
    ? `${dockerMode}，${dockerMode === "direct" ? directDocker.out : "sudo"}` 
    : "无法访问 Docker daemon",
);
const compose = run(
  dockerMode === "sudo" ? "sudo" : "docker",
  dockerMode === "sudo"
    ? ["-n", "docker", "compose", "version"]
    : ["compose", "version"],
);
add(
  "Docker Compose",
  compose.ok ? "pass" : "fail",
  compose.out.split("\n")[0] || "不可用",
);
const sudo = run("sudo", ["-n", "true"]);
add(
  "免密 sudo",
  sudo.ok ? "pass" : "warn",
  sudo.ok
    ? "完整 P0–P5 / Docker 测试可运行"
    : "不可用；完整测试需在具备该权限的环境运行",
);

// Environment
const envPath = resolve(root, ".env");
if (!existsSync(envPath)) {
  add("本地 .env", "fail", "不存在；先运行 pnpm init:env");
} else {
  const env = Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  const missing = [
    "POSTGRES_PASSWORD",
    "DATABASE_URL",
    "AUTH_ENCRYPTION_KEY",
    "PROXY_TRUST_TOKEN",
    "ADMIN_ORIGIN",
    "OPERATOR_EMAIL",
    "OPERATOR_PASSWORD",
  ].filter((key) => !env[key]);
  const weak = [];
  if (!/^[a-f0-9]{64}$/.test(env.AUTH_ENCRYPTION_KEY ?? ""))
    weak.push("AUTH_ENCRYPTION_KEY 不是 64 位十六进制");
  if ((env.PROXY_TRUST_TOKEN ?? "").length < 32)
    weak.push("PROXY_TRUST_TOKEN 少于 32 字符");
  if (!/^https:\/\//.test(env.ADMIN_ORIGIN ?? ""))
    weak.push("ADMIN_ORIGIN 不是 HTTPS origin");
  add(
    ".env 必需项",
    missing.length ? "fail" : weak.length ? "warn" : "pass",
    missing.length
      ? "缺少：" + missing.join(", ")
      : weak.length
        ? weak.join("；")
        : "数据库、密钥、代理和运营账号均已设置",
  );
  const envMode = parseInt(statSyncMode(envPath), 8);
  add(
    ".env 权限",
    (envMode & 0o077) === 0 ? "pass" : "warn",
    (envMode & 0o077) === 0 ? "0600/更严格" : "建议 chmod 600 .env",
  );
}

// Source evidence
try {
  const lockHash = sha256("pnpm-lock.yaml");
  const review = readJson("third-party/review.json");
  const image = readJson("third-party/image-review.json");
  add(
    "锁文件与许可记录",
    review.lockfileSha256 === lockHash ? "pass" : "fail",
    review.lockfileSha256 === lockHash
      ? "review.json 已绑定当前锁文件"
      : "review.json 的 lockfileSha256 已过期",
  );
  add(
    "锁文件与镜像记录",
    image.inputs?.["pnpm-lock.yaml"] === lockHash ? "pass" : "fail",
    image.inputs?.["pnpm-lock.yaml"] === lockHash
      ? "image-review.json 已绑定当前锁文件"
      : "image-review.json 的锁文件摘要已过期",
  );
  add(
    "源码包级缺口",
    review.pending.length ? "warn" : "pass",
    review.pending.length
      ? `${review.pending.length} 项：` +
        review.pending.map((item) => `${item.name}@${item.version}`).join(", ")
      : "无待关闭项",
  );
  const pendingImages = image.scopes.filter((scope) => scope.status === "pending");
  add(
    "镜像审查范围",
    pendingImages.length ? "warn" : "pass",
    pendingImages.length
      ? `${pendingImages.length} 组 pending：` +
        pendingImages.map((scope) => scope.id).join(", ")
      : "全部已审查",
  );
} catch (error) {
  add("发行记录", "fail", "无法读取： " + error.message);
}

// OAuth provider files (existence and shape only; values are never printed).
for (const id of ["github", "google"]) {
  const path = resolve(root, `.local/${id}.json`);
  if (!existsSync(path)) {
    add(`${id} 提供方`, "warn", `未配置（缺少 .local/${id}.json）`);
    continue;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const valid =
      value.id === id &&
      value.kind === id &&
      typeof value.clientId === "string" &&
      value.clientId.length > 0 &&
      typeof value.clientSecret === "string" &&
      value.clientSecret.length > 0 &&
      value.enabled === true;
    add(
      `${id} 提供方`,
      valid ? "pass" : "fail",
      valid ? "形状正确，可运行 auth-provider-check" : "字段不完整或 id/kind 不匹配",
    );
  } catch {
    add(`${id} 提供方`, "fail", "JSON 无法解析");
  }
}

// Ports
const portFree = (port) =>
  new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => server.close(() => resolvePort(true)));
    server.listen(port, "127.0.0.1");
  });
for (const port of [8443, 3000]) {
  const free = await portFree(port);
  add(
    `端口 ${port}`,
    free ? "pass" : "warn",
    free ? "可用" : "已被占用；演示栈可能已在运行",
  );
}

// Disk
try {
  const stats = statfsSync(root);
  const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
  add(
    "磁盘空间",
    freeGb >= 5 ? "pass" : "warn",
    `${freeGb.toFixed(1)} GiB 可用${freeGb >= 5 ? "" : "（建议 >=5 GiB）"}`,
  );
} catch {
  add("磁盘空间", "warn", "无法读取");
}

const width = Math.max(...checks.map((check) => [...check.name].length)) + 2;
for (const check of checks) {
  const label =
    check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
  console.log(
    `${label.padEnd(5)} ${check.name.padEnd(width)} ${check.detail}`,
  );
}
const failures = checks.filter((check) => check.status === "fail").length;
console.log(
  `\n${checks.length} 项检查：${failures} 个硬失败，` +
    `${checks.filter((check) => check.status === "warn").length} 个警告。`,
);
if (failures) process.exitCode = 1;

function statSyncMode(path) {
  return execFileSync("stat", ["-c", "%a", path], { encoding: "utf8" }).trim();
}
