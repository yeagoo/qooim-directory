# Qoo.IM Directory v0.2.0-rc.1

发布日期：2026-10-21  
类型：**Release Candidate / pre-release**，不是稳定版。

## 本版包含

- 新站点独立账号；共享账号中心 legacy 兼容。
- PostgreSQL `pg_trgm` 搜索索引与相关度排序。
- 站点级 Passkey（不做 MFA）。
- 站点媒体库、图片发布、公开访问和加密媒体备份。
- 内置 AI 生成/翻译/SEO，异步 Worker、预算和人工确认。
- RSS/npm/通用 JSON 采集器，候选人工审核，接受只建草稿。

## 验证

- P0 48、P1 88、P2 137、P3 39、P4 30、P5 11 全部通过。
- `pnpm test:release` 69/69；Docker 整合验收通过。
- 源码/镜像门禁通过；QooIM 已确认六组 evidence。

## 未完成 / 不建议生产直接使用

- 真实 GitHub/Google OAuth 未配置。
- 真实 AI provider 未联调。
- 真实 RSS/npm 外网源未联调。
- 真实 Passkey 设备/平台同步未验收。
- 无生产容量、SLA、真实 SMTP 退信或主机级灾难切换认证。

## 升级

- 运行全部迁移；确保数据库允许 `CREATE EXTENSION pg_trgm`。
- 对每个独立账号/中心执行 `pnpm cli auth-upgrade <site>`。
- 设置可写的 `MEDIA_HOST_PATH` 并纳入备份。
- 共享账号中心只用于既有部署兼容。

完整变更见 [CHANGELOG](../CHANGELOG.md)，验收见 [整合验收](ACCEPTANCE-INTEGRATION-20261021.md)。
