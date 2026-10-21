# Changelog

## v0.2.0-rc.1 — 2026-10-21 (release candidate)

这是 M1–M5 的发布候选，不是稳定版。真实 OAuth、AI 供应商、RSS/npm 外网源和真实 Passkey 设备尚未验收；公开发布仍为 NO-GO（见 [整合验收](docs/ACCEPTANCE-INTEGRATION-20261021.md)）。

### Added

- M1：新站点固定独立账号；共享账号中心标记 legacy；`pg_trgm` GIN 搜索与相关度排序；迁移 `006-search.sql`。
- M2：站点级 Passkey 注册/登录/删除（不做 MFA）；`@better-auth/passkey@1.7.10`；升级后需对每个独立账号/中心执行 `auth-upgrade`。
- M3：站点级媒体库、图片发布/公开访问、删除引用保护；加密媒体归档备份/恢复；迁移 `007-media.sql`；不引入 sharp。
- M4：站点级 AI 生成/翻译/SEO、异步 Worker、密钥封装、月度预算与 SSRF 防护；迁移 `008-ai.sql`；人工确认后才可进入草稿。
- M5：RSS/npm/通用 JSON 采集器、统一候选审核、接受只建草稿；迁移 `009-collectors.sql`；GitHub 专用同步保留。

### Verified

- `pnpm check`、`pnpm build`、`pnpm test:release` 69/69 通过。
- P0 48/48、P1 88/88、P2 137/137、P3 39/39、P4 30/30、P5 11/11。
- Docker 整合验收通过：空库/三站/HTTPS/共享登录、内容、媒体上传/公开访问、搜索、AI 配置、采集来源、GitHub、Worker 重启和数据库恢复。
- `pnpm release:check`、`pnpm release:check:image` 通过；QooIM 已确认当前六组镜像 evidence（2026-10-21）。
- 最终 RC 验收镜像：`sha256:8d213bed...`。

### Known limitations / blockers

- 真实 GitHub/Google OAuth 未配置（preflight 2 个警告）；受控 OIDC 已测试。
- 真实 AI provider 未联调；当前使用注入传输。
- 真实 RSS/npm 外网源未联调；当前使用受控 fixture。
- Passkey 只用 Chromium 虚拟认证器，未做真实设备/平台同步验收。
- GitHub 仍是独立专用同步链路，未迁移到统一 collector 表。
- PostgreSQL `pg_trgm` 需要数据库权限或托管服务预装。
- 媒体绑定目录必须让容器 UID 1000 可写，并纳入备份。
- 没有生产容量/SLA、真实 SMTP 退信演练或主机级灾难切换认证。

### Upgrade

- 应用迁移 `006-search.sql`…`009-collectors.sql`；`pg_trgm` 需要扩展权限。
- 已有 auth instance 需执行 `pnpm cli auth-upgrade <site>` 建立 Passkey 表。
- Compose 需设置可写的 `MEDIA_HOST_PATH`（默认 `./data/media`），并备份媒体目录。
- 共享账号中心仅作为既有部署兼容，不再新增。

## v0.1.0 — 2026-10-21 (source preview)

首个公开源码预览版。AGPL-3.0-only。

### Added

- 多站点导航平台：独立站点、共享账号中心、配置/内容/发布/审计。
- 模板 SDK、邮件认证、会话策略、GitHub/Google/通用 OIDC 配置、账号绑定/解绑。
- GitHub 项目来源同步、内容审核、统计自动更新与逐站发布。
- 加密备份/隔离恢复、源码归档、容量短基线、后台任务与审计日志。
- 公开页面 ETag/缓存、robots.txt、sitemap、运营者生命周期管理。
- GitHub Actions 静态 CI；手动 arm64 全量验收 job。

### Verified

- `pnpm check`、`pnpm build`、`pnpm test:release` 通过。
- P0 48/48、P1 87/87、P2 134/134、P3 36/36、P4 28/28、P5 11/11。
- Docker 整体验收通过（空库、三站、HTTPS、共享登录、SMTP、内容/GitHub、worker 重启、数据库恢复）。
- `pnpm release:check` 与 `pnpm release:check:image` 通过（镜像为带保留签署）。

### Known limitations

- 真实 GitHub/Google OAuth 尚未用正式凭据联调；受控 OIDC 已测试。
- 域名、公开仓库名和容量/生产吞吐未认证。
- 六组镜像审查含保留项：`next-swc` 没有逐 crate 通知，`node-base`、`global-pnpm`、`esbuild`、`postgres-image`、`demo-proxy-image` 的保留项见 `third-party/image-review.json`。
- 代码/Dockerfile 变更后镜像 evidence 已刷新，公开发行前仍需审查人确认。
- `docs/` 历史过程文档已归档到 `docs/history/`；`.local/` 验收日志不进入仓库。
