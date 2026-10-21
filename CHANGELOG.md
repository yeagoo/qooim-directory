# Changelog

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
