# 镜像 evidence 复核包

复核对象：发布候选 commit `a72c16e` / 镜像 `navigation-network:acceptance6-20261021`  
应用镜像：`sha256:6f4c4af3891d3c50bf116049061c0ccf56829f6c9549f1742dbd5f66ac0769a2`  
审查人：QooIM（已确认）  
日期：2026-10-21

## 本轮变化

- M1–M5 代码已合并：独立账号/搜索、Passkey、媒体、AI、采集器。
- 新增 `@better-auth/passkey@1.7.10` 及 SimpleWebAuthn 传递依赖（MIT）；浏览器端 vendored UMD 使用同一 MIT 文本。
- 镜像已重新构建；六组 evidence 已重新采集并刷新哈希。
- `release:check` 和 `release:check:image` 均通过；这只代表门禁记录一致，不代表法律意见或审查人已确认。

## 六组 evidence

| Scope | 镜像/基础镜像 | Evidence SHA-256 | 采集时间 |
| --- | --- | --- | --- |
| `node-base` | `sha256:6f4c4af3891d3c50bf116049061c0ccf56829f6c9549f1742dbd5f66ac0769a2` | `32824311e4a45635115f3e4f5c1c9a4ba8b7b747410ebf036397d8cd16efcb4a` | `2026-10-21T08:55:58.284Z` |
| `global-pnpm` | `sha256:6f4c4af3891d3c50bf116049061c0ccf56829f6c9549f1742dbd5f66ac0769a2` | `d6ce143aca05d57d1d19660b5fb4f7be3805e87aeb656b411e3d9d6ad70d9a36` | `2026-10-21T08:55:58.727Z` |
| `next-swc` | `sha256:6f4c4af3891d3c50bf116049061c0ccf56829f6c9549f1742dbd5f66ac0769a2` | `a986b5fc7df398f57d692e44284cd060428d8d1b5d35c51c9c8d7dbfcc15a33b` | `2026-10-21T08:55:58.728Z` |
| `esbuild` | `sha256:6f4c4af3891d3c50bf116049061c0ccf56829f6c9549f1742dbd5f66ac0769a2` | `6f334afa63f91ae6c4b6c0e349958a0757a2b87e9427c7377afa1115f869a69f` | `2026-10-21T08:55:58.728Z` |
| `postgres-image` | `sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` | `7cf18b014494fecf70df729d82e02d4b8fd23511f1209542e8f6fbc317641233` | `2026-10-21T08:55:59.271Z` |
| `demo-proxy-image` | `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` | `a7ae89fe77a2b29ef48ead9a9d69758d3ad16bfadf412bd2be7c33d9fc8bddd6` | `2026-10-21T08:55:59.960Z` |

## 输入哈希

| 文件 | SHA-256 |
| --- | --- |
| `Dockerfile` | `fab72263f45284226e8b56cd0445ab2a13a1031197de3c5999530fe2ef2948d6` |
| `compose.yaml` | `c1e00390f8652064219ffdb83c6544905d925e028689eefe7a43ac4d2cbdc6e4` |
| `compose.demo.yaml` | `b99944fbac97da67ff18a64492b42452b9cfad274852ead04eee76567220a373` |
| `pnpm-lock.yaml` | `6c78cd34d2039c03f65eacab5795a9cbec983b7e17882aec07b0fcbdaebdc986` |
| `package.json` | `0d2a742980e684acd544d1e2f659c95fbff906c7702cacd7a67d7b371813f8ca` |
| `.dockerignore` | `cfbe4fb99779a91497d6b385517c634579e832a12710813eeaa80209981a3596` |

## 复核问题

请审查人确认：

1. 六组 evidence 的镜像 digest、平台（linux/arm64）与候选镜像一致。
2. evidence 的内容足以支持“内部 RC 的 inventory/identity 记录”，并接受其 `limitations`：不做许可 clearance、链接分析、对应源码交付或漏洞评估。
3. 新增 Passkey/SimpleWebAuthn 依赖没有新增需要逐 crate 通知的原生镜像范围；其 MIT 文本由源码通知和 vendored LICENSE 覆盖。
4. 是否要求在公开发布前补充特定证据（例如 SimpleWebAuthn 逐包通知、vendored UMD 的对应源码或额外原生库清单）。

## 明确不声称

- 本复核不是法律意见，不替代完整开源合规审查。
- `next-swc` 仍不接受逐 crate 通知。
- PostgreSQL/Caddy 基础镜像、Debian 包、Rust/Go 内嵌依赖的完整通知/对应源码仍需按发行范围处理。

## 签署

- [x] QooIM 确认当前六组 evidence 与候选镜像一致
- [x] 接受 evidence 的 limitations，作为内部 RC 记录
- [x] 记录保留意见：无额外保留；本确认不构成法律意见或完整合规审查。

审查人：**QooIM**  日期：**2026-10-21**  
确认对象：commit `a72c16e` / image `sha256:6f4c4af3...`
