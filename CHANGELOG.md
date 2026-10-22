# Changelog

## Unreleased — M6 配额与保留期、M7 运维 UI、M8 媒体版本、M9 AI 治理

开发方案见 [M6–M10](docs/FEATURE-PLAN-M6-M10.md)。

### Added

- 站点配额：新表 `site_limit`。默认媒体 1 GiB / 5000 个文件，采集来源 20 个，每小时采集 60 次。`GET/POST /admin/api/limits`，后台新增“配额”页，CLI 新增 `site-limit`、`site-limit-set`。只有站群管理员能修改，改动写审计 `site.limit.save`。
- 媒体：上传强制执行配额（站点锁内检查，超限返回 413），新增用量接口 `/admin/api/media/usage`，媒体页显示配额，Worker 清理孤儿文件。
- AI：`ai_usage_month` 按月汇总用量；超过保留期的已结束任务汇总后删除，当月任务不删；预算统计包含汇总表；新增用量接口 `/admin/api/ai/usage`，AI 设置页显示近 12 个月用量。
- 采集器：来源数量配额（409）；每小时频率限制（手动同步返回 429，定时调度推迟 15 分钟）；保留期会删除旧任务和已作废候选，并压缩已审核候选（保留去重记录）；新增 `/admin/api/collectors/usage`，候选历史显示“已归档”。
- Worker 每小时执行一次保留期清理（多个 Worker 互斥），CLI `retention-run` 可立即执行一次；新增 `RETENTION_*` 环境变量。
- 迁移 `010-quota-retention.sql`；新增测试 `tests/p6/`，运行方式：`node scripts/test-p0.mjs tests/p6/foundation.test.ts tests/p6/media.test.ts tests/p6/ai.test.ts tests/p6/collectors.test.ts`。`package.json` 属于镜像 evidence 固定的输入文件，所以这次没有加 `test:p6` 脚本；等发布前刷新 evidence 时一并加入。

### Added（M7 运维 UI）

- AI 任务：列表（分页、状态筛选）、取消排队中或处理中的任务、重试失败或已取消的任务（新建任务并用 `retry_of` 关联原任务，每个任务只能重试一次）；AI 设置页新增“任务”面板；审计 `ai.job.cancel`、`ai.job.retry`。
- AI Worker 写回结果时会检查自己是否仍持有该任务：已取消或已被其他 Worker 接手的任务不会被改回完成；供应商已经消耗的 token 仍然计入预算。
- 采集任务：列表、重试失败任务（与手动同步共用频率限制，`operationId` 幂等，仅限站群管理员）；后台可以编辑来源（配置、语言、启用、同步间隔）；候选批量审核（每批 1–100 条，逐条返回结果，非原子）。
- “运行任务”页显示 AI 和采集任务的状态统计、保留期设置，以及最近一次清理的结果。
- 迁移 `011-operations-ui.sql`；新增测试 `tests/p7/`。

### Added（M8 媒体版本）

- 媒体替换、历史版本、恢复旧版本（新建一个版本，不复制文件）、删除历史版本（当前版本和被发布记录引用的版本不能删除）；新表 `media_version`。
- 发布冻结图片版本：公开地址改为 `/media/<id>/<version>`，旧地址 `/media/<id>` 302 跳转到已发布版本（不缓存）；替换图片不会改变已发布页面，重新发布后才切换。
- 配额：文件数按素材计算；容量按去重后的文件计算。孤儿清理会考虑历史版本。
- 媒体页：版本标记、历史版本面板、替换、批量上传（逐个上传，单独显示结果，配额不足时停止剩余文件）。
- 迁移 `012-media-versions.sql`；新增测试 `tests/p8/`。

### Added（M9 AI 治理）

- 提示词版本：内置 v1 只读；站群管理员新建版本，创建后不能修改；只能定制任务指令，系统提示和输出约束固定在代码里。各站为每种任务选择版本，任务记录创建时用的版本，Worker 按记录的版本生成提示。
- 对账：按月录入或用 CSV 导入供应商用量，与系统记录对比（差额和百分比），不影响预算。
- 余额检查（可选）：每站配置余额接口和 JSON 字段，由 Worker 带 API Key 发起请求（HTTPS、私网拒绝、固定 DNS、不跟随跳转、限时限量），每 6 小时自动检查一次，也可以手动排队检查。
- 新增“AI 对账”页面；AI 任务列表显示提示词版本。
- 迁移 `013-ai-governance.sql`；新增测试 `tests/p9/`。

### Changed（M8）

- 媒体对象的 `url` 字段改为当前版本的地址 `/media/<id>/<version>`。外部如果直接引用了旧的 `/media/<id>`，仍可通过跳转访问。

### Upgrade

- 应用迁移 `010-quota-retention.sql`、`011-operations-ui.sql`、`012-media-versions.sql`（会给现有媒体补上 v1，给已有发布记录补上 `version: 1`）、`013-ai-governance.sql`。现有站点使用默认配额；如果已经超出默认配额，只会阻止新增，不删除任何数据。
- 首次运行保留期清理时，会处理历史上积累的数据（每类每次最多 10 万行，下一小时继续）。

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
