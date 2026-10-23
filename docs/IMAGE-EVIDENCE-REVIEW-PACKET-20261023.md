# 镜像 evidence 复核包（M6–M11 候选）

复核对象：分支 `evidence-refresh-m6-m10`（基于 `main` 的 M6–M11 提交 `7f54beb`，加上 `62a1eb2`）  
应用镜像：`sha256:c73accb20b67ca3313c775eda5c613af8bb870f169f83ea0cb5a973e84d0d585`（`navigation-network:m6-m11-candidate`，linux/arm64）  
审查人：QooIM（**待确认**）  
日期：2026-10-23

## 本轮变化

- 代码：M6 配额与保留期、M7 运维 UI、M8 媒体版本、M9 AI 治理、M10 统一采集器、M11 收尾与加固。各里程碑的验收见 `docs/ACCEPTANCE-M6…M11`；M6–M10 的 Docker 验收已通过，M11 没有改动迁移和部署文件。
- **没有新增或升级依赖**：`pnpm-lock.yaml`、`Dockerfile`、`.dockerignore`、`compose.demo.yaml` 都没有改动。
- 改动的两个镜像输入文件：
  - `package.json`：新增 `test:p6`…`test:p11` 脚本，`check` 增加 5 个后台 UI 模块的语法检查。只改了脚本，没有改依赖。
  - `compose.yaml`：给 web/worker 透传 4 个 `RETENTION_*` 环境变量，默认为空（使用代码里的默认值）。
- 用同一个采集脚本（`scripts/image-license-evidence.mjs`，`collectorSha256` 与 rc.1 相同）重新采集了六组 evidence。

## 与已确认的 rc.1 evidence 的差异

新的应用镜像清单（`.local/license-evidence/app-inventory.json`）与 rc.1 逐项比对：

| 项目 | rc.1 | 本次 | 结论 |
| --- | --- | --- | --- |
| npm 运行时包（名称/版本/许可） | 94 | 94 | 完全相同 |
| Debian 系统包（名称/版本/架构） | 88 | 88 | 完全相同 |
| 许可/通知文件（路径/SHA-256） | 196 | 196 | 完全相同 |

六组 evidence 文件逐字段比对（`observations` 记录的是包、许可、通知和二进制版本）：

| Scope | 变化的字段 | `observations` | 镜像 |
| --- | --- | --- | --- |
| `node-base` | `image`、`basis`、`collectedAt` | 不变 | `8d213bed…` → `c73accb2…` |
| `global-pnpm` | `image`、`basis`、`collectedAt` | 不变 | 同上 |
| `next-swc` | `image`、`basis`、`collectedAt` | 不变 | 同上 |
| `esbuild` | `image`、`basis`、`collectedAt` | 不变 | 同上 |
| `postgres-image` | `collectedAt` | 不变 | 固定摘要 `77f58511…`，未变 |
| `demo-proxy-image` | `collectedAt` | 不变 | 固定摘要 `d8542f48…`，未变 |

结论：分发内容（第三方组件及其许可、通知）与 rc.1 相同；变化的只有应用镜像的身份（代码不同，所以镜像摘要不同）。

## 六组 evidence

| Scope | Evidence SHA-256 |
| --- | --- |
| `node-base` | `c982babc43c7e005ac5a0b8baeada4b4ccfd4853b71d802e5073cce9929aea0c` |
| `global-pnpm` | `bde1c3daeb8d2e3a07d4dfde5cff5c38e0c5be9d7f8adf3d53aa40f010cd7577` |
| `next-swc` | `473427cdc09f3d680c29e3d2eb7a071e981e52ea519cee7167886fbcbf218079` |
| `esbuild` | `8f7b0a97111f2586c6a7a643d131ec0b9360dd427afc9b28b86b246b8e1c9b8f` |
| `postgres-image` | `809409c8e1c45bc90fe2b347637b594ac263500c77e695f1851186345a26cbb3` |
| `demo-proxy-image` | `8a311240ef4ce8480a9a46c92bafb077b21bb909090957f67d6d3c456447452f` |

`third-party/image-review.json` 里六个 scope 都已设为 `pending`，并原样保留了 rc.1 的审查结论（`previousReview`，包括各 scope 的保留意见）。在 QooIM 确认之前，`pnpm release:check:image` 会报六项“review pending”而阻断发布，`pnpm test:release` 里镜像门禁那一项也会失败。这是预期的状态。

## 请 QooIM 确认

1. 六组 evidence 的镜像摘要、平台（linux/arm64）与候选镜像 `sha256:c73accb2…` 一致。
2. 接受“分发内容与 rc.1 相同、仅应用镜像身份变化”的比对结论，并沿用 rc.1 各 scope 的保留意见（见 `previousReview`）。
3. 接受 evidence 的 limitations：不做许可 clearance、链接分析、对应源码交付或漏洞评估。

确认后，把各 scope 的 `status` 改为 `complete`，填写 `reviewer`/`reviewedAt`，并更新 `confirmation`。这一步由审查人或经审查人授权后执行，不能由开发方代为签署。

## 明确不声称

- 本复核不是法律意见，不替代完整的开源合规审查。
- `next-swc` 仍然不提供逐个 crate 的通知（与 rc.1 相同）。
- PostgreSQL/Caddy 基础镜像、Debian 包、Rust/Go 内嵌依赖的完整通知与对应源码，仍需按发行范围另行处理。

## 签署

- [ ] QooIM 确认六组 evidence 与候选镜像 `sha256:c73accb2…` 一致
- [ ] 接受比对结论，沿用 rc.1 的保留意见
- [ ] 接受 evidence 的 limitations，作为内部候选记录

审查人：________  日期：________
