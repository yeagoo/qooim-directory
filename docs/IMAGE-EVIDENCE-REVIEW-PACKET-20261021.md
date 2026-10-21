# 镜像 evidence 复核包

复核对象：发布候选 tag `v0.2.0-rc.1`（commit 待 tag 固定）  
应用镜像：`sha256:8d213bed11cf2b8b80d45566f452094aa8ede39b546397705a884ae9a368af09`  
审查人：QooIM（已确认）  
日期：2026-10-21

## 本轮变化

- M1–M5 代码已合并：独立账号/搜索、Passkey、媒体、AI、采集器。
- 新增 `@better-auth/passkey@1.7.10` 及 SimpleWebAuthn 传递依赖（MIT）；浏览器端 vendored UMD 使用同一 MIT 文本。
- 版本 bump 为 `0.2.0-rc.1` 后重新构建镜像；六组 evidence 已重新采集。
- `release:check` 和 `release:check:image` 均通过；这只代表门禁记录一致，不代表法律意见。

## 六组 evidence

| Scope | 镜像/基础镜像 | Evidence SHA-256 | 采集时间 |
| --- | --- | --- | --- |
| `node-base` | `sha256:8d213bed11cf2b8b80d45566f452094aa8ede39b546397705a884ae9a368af09` | `6b01f0fcdedcec04f956322abc83de5e8ef39020a777ca7c848d94d09f9a3809` | `2026-10-21T09:41:10.484Z` |
| `global-pnpm` | `sha256:8d213bed11cf2b8b80d45566f452094aa8ede39b546397705a884ae9a368af09` | `d1d0a520d9a3284bdd7498591af7629a6d699de1ec93381b76e1f6ec2cf6f4c1` | `2026-10-21T09:41:10.876Z` |
| `next-swc` | `sha256:8d213bed11cf2b8b80d45566f452094aa8ede39b546397705a884ae9a368af09` | `4836a0030c700616af7fa173a40bd0f1ce59082ef3fd4abe145bdaf7b2ed6948` | `2026-10-21T09:41:10.876Z` |
| `esbuild` | `sha256:8d213bed11cf2b8b80d45566f452094aa8ede39b546397705a884ae9a368af09` | `ebd5e459c9c46f7fd8c5d0e26ae571ac8a1e714ff799a0768972e048b4255724` | `2026-10-21T09:41:10.876Z` |
| `postgres-image` | `sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` | `a7857d495b4744fdf6e638bb3ba9c604cf198b4c9f0ad014bad08941a47f7970` | `2026-10-21T09:41:11.397Z` |
| `demo-proxy-image` | `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` | `e2eff81acad9d7ee92d53c269e4aa70970213895893288eba23958fb4042f2b5` | `2026-10-21T09:41:12.004Z` |

## 输入哈希

| 文件 | SHA-256 |
| --- | --- |
| `Dockerfile` | `fab72263f45284226e8b56cd0445ab2a13a1031197de3c5999530fe2ef2948d6` |
| `compose.yaml` | `c1e00390f8652064219ffdb83c6544905d925e028689eefe7a43ac4d2cbdc6e4` |
| `compose.demo.yaml` | `b99944fbac97da67ff18a64492b42452b9cfad274852ead04eee76567220a373` |
| `pnpm-lock.yaml` | `6c78cd34d2039c03f65eacab5795a9cbec983b7e17882aec07b0fcbdaebdc986` |
| `package.json` | `a9f6eb697f40eb6c25e56397f1175e33efac13b50f52799beeda8b71e951771c` |
| `.dockerignore` | `cfbe4fb99779a91497d6b385517c634579e832a12710813eeaa80209981a3596` |

## 复核确认

QooIM 确认：

1. 六组 evidence 的镜像 digest、平台（linux/arm64）与 `v0.2.0-rc.1` 候选镜像一致。
2. evidence 内容足以支持“内部 RC 的 inventory/identity 记录”，并接受其 `limitations`：不做许可 clearance、链接分析、对应源码交付或漏洞评估。
3. 新增 Passkey/SimpleWebAuthn 依赖没有新增需要逐 crate 通知的原生镜像范围；其 MIT 文本由源码通知和 vendored LICENSE 覆盖。
4. 无额外保留意见。

## 明确不声称

- 本复核不是法律意见，不替代完整开源合规审查。
- `next-swc` 仍不接受逐 crate 通知。
- PostgreSQL/Caddy 基础镜像、Debian 包、Rust/Go 内嵌依赖的完整通知/对应源码仍需按发行范围处理。

## 签署

- [x] QooIM 确认当前六组 evidence 与 `v0.2.0-rc.1` 候选镜像一致
- [x] 接受 evidence 的 limitations，作为内部 RC 记录
- [x] 记录保留意见：无额外保留；本确认不构成法律意见或完整合规审查。

审查人：**QooIM**  日期：**2026-10-21**  
确认对象：tag `v0.2.0-rc.1` / image `sha256:8d213bed...`
