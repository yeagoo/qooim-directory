# 2026-10-25 全项目 Review

审查对象：`main`（`16a21ef`，含 `v0.2.0-rc.3`）。范围覆盖 `src/`、`app/`、`migrations/`、`scripts/`、`tests/`、部署文件与 `docs/`，并结合 [项目历史总览](PROJECT-HISTORY.md) 核对叙述与实现是否一致。

本文是**审查结论**，不是修复记录；除新增本文与文档索引外，本轮没有修改代码。文中的"阻断/高/中/低"是审查严重度，与项目阶段 P0–P17 无关。

## 0. 结论摘要

| 维度 | 评分（5 分制） | 依据 |
| --- | ---: | --- |
| 架构与模块边界 | 4.5 | 单入口路由 + 服务层 + 单一公共视图；边界有静态检查 |
| 安全设计 | 4.0 | SSRF/CSP/CSRF/权限/加密整体扎实；OIDC 与运维面有缺口 |
| 并发与数据一致性 | 4.5 | 咨询锁顺序、版本 CAS、幂等键、租约与审计 |
| 测试深度 | 4.0 | 3 万行集成/浏览器测试，覆盖 IDOR 与预算原子性；CI 未接入 |
| 可运维性 | 2.5 | 无监控指标、无生产代理配置、无自动备份、无密钥轮换 |
| 文档与治理 | 4.0 | 决策与验收链完整；README 与部分索引用例已漂移 |
| 稳定版就绪度 | 2.5 | 外部验收未完成 + 本文 B1–B3 |

**总体判断**：这是一份工程质量明显高于同规模自托管项目的代码库——安全边界、并发控制、许可证据链和测试深度都属上乘，可以直接支撑"预发布、可自托管试运行"的定位。但**发布工程（CI、版本、运维面）落后于功能工程**：12 个测试套件不在任何自动流水线里，版本号与 tag 已脱节，生产部署与观测缺乏可执行材料。这些不否定代码质量，但会直接放大稳定版发布风险。

## 1. 审查范围与方法

| 类别 | 内容 |
| --- | --- |
| 已通读 | `src/server`（路由、认证、内容、发布、媒体、AI、分发、采集、计费）、`src/domain`、`src/public/sdk.ts`、`src/ui/*`、`src/templates/toolso` 关键页、全部 20 个迁移、`Dockerfile`、`compose*.yaml`、`deploy/`、`scripts/backup.mjs`、`scripts/release.mjs`、`scripts/check-boundaries.mjs`、CI、根 README、`docs/` 主要文档 |
| 已运行 | `tsc --noEmit`（通过）、`tsc --noEmit --noUnusedLocals`（12 处未使用声明）、`node scripts/check-boundaries.mjs`（通过）、`node scripts/build-toolso-css.mjs --check`（通过）、`node --test tests/p5/release.test.mjs`（69/69）、文档相对链接完整性检查（0 断链） |
| 未运行 | P0–P17 集成测试、`test:docker`、`pnpm build`、真实 OAuth/AI/RSS/npm 联调。原因：本环境没有可用的 Docker/sudo（测试工具链要求 `sudo -n docker` 并改写 `/etc/hosts`），不能安全复现。因此本文不对运行期行为下断言，只对可静态验证的代码路径下结论 |
| 未覆盖 | `third-party/*` 证据链的逐项复核、`scripts/distribution.mjs`（1480 行许可取证工具）逐行审查、容量测试数据本身 |

## 2. 项目画像

| 指标 | 数值 |
| --- | --- |
| 运行时代码 | 149 个文件 / 约 26,800 行（`src/`） |
| 其中服务端 | 约 12,000 行（`src/server`） |
| 前端模板 | 约 7,100 行（`src/templates`，含 CSS） |
| 后台/前台脚本 | 约 6,600 行（`src/ui`，纯 JS） |
| 测试 | 55 个文件 / 约 30,400 行；P0–P17 共 18 个套件 |
| 迁移 | 20 个文件 / 604 行 |
| 工具脚本 | 约 7,200 行（含许可/镜像取证） |
| 文档 | 123 个 Markdown / 约 7,700 行 |
| 直接依赖 | 15 个运行时 + 11 个开发依赖，全部精确锁定 |

测试代码与产品代码比例约 1.13:1，对一个单体应用而言属于很高的投入。

运行形态：`web`（Next.js 单 catch-all 路由）+ `worker`（同镜像另一入口）+ PostgreSQL + 可选 Caddy 演示代理；应用代码与源码归档打进同一镜像，`/source.tar.gz` 在任意已绑定站点提供（AGPL 合规）。

## 3. 架构评述

### 3.1 请求路径

```
app/[[...path]]/route.ts        ← 唯一 Next 路由，仅转发
  → src/server/entry.ts         ← 进程级 Application 单例
    → src/server/http.ts        ← Host 解析、缓存头、CSP、路由分发（1528 行）
      → *-http.ts               ← 各领域子路由（content/media/ai/collectors/distribution/limits）
        → 服务类                ← Content / Media / AiService / Distribution / Collectors
          → src/domain          ← Catalog（公共视图）、ConfigStore、transaction、outbox、identity
            → PostgreSQL
```

选择"Next 只当 HTTP 宿主，自己写路由器"而不是用文件路由，换来的是：一个入口统一做 Host 校验、缓存、CSP、错误映射；代价是失去 Next 的路由级能力（中间件、ISR、部分缓存），且路由文件里的 `dynamic = 'force-dynamic'`（`app/[[...path]]/route.ts:3`）等于放弃框架缓存。

### 3.2 三个关键设计

1. **公共数据边界是数据库视图，不是约定。** `public_listing` 由 `003-content.sql` 创建、在 `015-content-model.sql` 最终定型，把站点有效、模块启用、资源公开、发布状态、语言、分类可用性全部写进 WHERE；`Catalog` 只查这个视图。`scripts/check-boundaries.mjs` 再用 AST 禁止其他服务直接写业务表 SQL。这比"记得加 site_id"可靠得多。
2. **写路径统一是"锁 → 复核权限 → 版本 CAS → 幂等键 → 审计"。** `content.stageWith/publishWith`、`distribution.publishDue`、`operators.*` 都遵循同一顺序；多对操作按 `site:resource:locale` 排序获取咨询锁，写事务里用 `FOR SHARE/FOR UPDATE` 再读一次权限。这套顺序是并发用例（越权、重复发布、草稿冲突、预算竞争）能通过的前提。
3. **模板是"静态渲染 + 原生 JS 增强"，不是客户端 React。** `renderToStaticMarkup` 输出 HTML，交互由 `src/ui/toolso.js` 用 `data-*` 绑定；因为 CSP 禁止内联样式，所有动态样式走 CSSOM。这让页面在关闭 JS 时仍是完整内容，也避免了 hydration 体积。

### 3.3 主要架构代价

- `http.ts` 1528 行同时管缓存、CSP、媒体、sitemap、模板分发和 admin 路由，是维护热点。
- `react-dom/server` 通过 `process.getBuiltinModule("node:module").createRequire(...)` 绕过 Next 打包（`src/server/templates.ts:20-24`）。这是对 Next 内部行为的依赖，主版本升级时最可能先坏，而构建产物没有自动冒烟测试。
- 后台是纯 JS SPA（`src/ui/admin.js` 等约 6,600 行，无类型、无 lint），只能靠 `node --check` 做语法检查。

## 4. 做得好的地方（有证据）

1. **多租户隔离到认证实例级**：每站独立 `auth_instance`、独立 Better Auth secret、表名前缀 `network_<id>_`、`session_bridge` 双向校验（`src/server/auth.ts:47-51, 771-809`）。共享账号中心只作为 legacy 兼容，新站点在 `sites.create` 就被拒绝（`src/server/sites.ts:38-42`）。
2. **权限每次操作实时复核，且写事务内再复核一次**：`require()` 不看传入的 `global_admin`，而是重读 `operator_user` 与 `operator_grant`（`src/server/operators.ts:107-133`）。
3. **写操作幂等**：`content_operation` / `config_operation` 用 `operationId` + 参数指纹，重放返回原版本；指纹不符报 409（`src/server/content.ts:956-973`）。
4. **SSRF 防护是"解析后固定地址"而非只查 URL**：`outbound.ts` 解析全部 A/AAAA、任一私网即拒绝、连接 pin 到选定地址、重定向重新校验；AI 端点、余额查询、采集器、元数据抓取共用同一套判定（`src/server/outbound.ts:40-137`、`src/server/ai-billing.ts:197-205`）。
5. **媒体文件安全**：内容哈希命名、magic bytes + 尺寸校验、临时文件 `wx` + rename、事务提交后才删文件、站点级咨询锁串行化配额（`src/server/media.ts:155-173, 643-764`）。
6. **XSS 防线完整**：后台全部走 `escape()`；Markdown 用 `react-markdown` + `skipHtml` + 禁 `img`；JSON-LD 单独转义 `<>&`；SVG 徽章清 C0/代理项；CSP 无 `unsafe-inline`，动态样式走 CSSOM（`src/templates/toolso/components/detail/shared.tsx:38-48`、`src/server/http.ts:270-274`）。
7. **迁移安全**：咨询锁串行、逐文件 checksum、拒绝"数据库比应用新"、单个失败整体回滚（`src/server/migrate.ts:6-38`）。
8. **备份/恢复有真实校验**：AES-256-GCM 流式加密、备份密钥与应用密钥必须不同、先用应用密钥验证 `sealed_secret` 可解、恢复前校验迁移 checksum 与媒体文件数/字节数（`scripts/backup.mjs`）。
9. **会话吊销链完整**：中心会话删除 → `session_bridge` 标记 revoked；密码重置撤销桥接会话；`auth.maintain` 定期清扫（`src/server/auth.ts:232-237, 331-340, 810-880`）。
10. **测试写的是"不变量"而不是"调用次数"**：P17 覆盖越权找不到任务、预算预扣原子性、并发查重串行化、草稿不被覆盖、定时发布复核创建人权限；P12 覆盖焦点陷阱、Escape 返回焦点、CSP 违规（`tests/p17/distribution.test.ts`、`tests/p12/browser.test.ts`）。

## 5. 问题清单

### 5.1 阻断（建议稳定版发布前解决）

**B1. CI 只覆盖到 P5，P6–P17 完全不在自动流水线**

- 证据：`.github/workflows/ci.yml:32-34` 静态任务只跑 `check`、`build`、`test:release`、`release:check`；`:44-63` 的 arm64 全量任务只在 `workflow_dispatch` 手动触发，且只列到 `test:p5`。
- 影响：M6–M19（配额、媒体版本、AI 治理、采集器迁移、富字段、榜单、程序化 SEO、分发、后台改版）没有任何自动回归保护。`docs/ACCEPTANCE-*.md` 多次记录"并行回归偶发失败，单独重跑通过"，说明这些套件本身也不够稳定，正需要 CI 持续暴露。
- 建议：至少把 `test:p6`–`test:p17` 纳入 arm64 自托管任务，并按依赖分组（DB 组 / 浏览器组）；PR 上跑一个"冒烟子集"（P1/P2/P17），main 上跑全量。

**B2. 版本号已与 tag 脱节，并被写进备份与源码清单**

- 证据：`package.json:3` 仍是 `"version": "0.2.0-rc.1"`，而 `git tag` 已到 `v0.2.0-rc.3`。`scripts/backup.mjs:124-138` 的 `applicationIdentity()` 把 `pkg.version` 写进备份清单；`scripts/release.mjs` 把 `pkg.version` 写进 `SOURCE-MANIFEST.json`。
- 影响：rc.3 镜像产出的备份和源码包自称 rc.1；故障排查、支持对账、镜像证据复核都会被误导。`release.mjs check` 不校验 tag 与版本一致，问题不会在门禁处暴露。
- 建议：bump 到 `0.2.0-rc.3`（或引入单一版本来源），并在 `release.mjs check` 增加"`git describe --tags --exact-match` 与 `package.json.version` 一致"的校验（允许在非 tag 提交上跳过并提示）。

**B3. 生产部署与运行面没有闭环**

- 证据：`deploy/` 只有 `Caddyfile.demo`；`compose.yaml` 把 web 绑到 `127.0.0.1:3000`，但仓库没有生产 TLS 终结、`X-Network-Proxy-Key` 注入、HSTS、真实 IP 的参考配置。`src/server/auth-policy.ts:62-71` 在生产环境强制 `PROXY_TRUST_TOKEN`，否则启动失败——方向正确，但没有配套代理配置，首次部署极易踩坑（配置错误会让全站共用 `untrusted` 限流桶）。同时全仓只有 8 处 `console.error`，没有请求 ID、延迟/错误率/队列深度指标，`/health` 只执行 `SELECT 1 FROM schema_migration`（`src/server/http.ts:445-448`），不反映 worker 心跳、迁移版本或媒体目录可写性。
- 影响：能跑起来，但出问题时缺少第一手证据；这不是代码缺陷，是"稳定版"必须补齐的发布工程。
- 建议：提供 `deploy/Caddyfile.production`（或 nginx）示例 + `.env` 说明；`/health` 增加 worker heartbeat 与迁移版本；增加结构化 JSON 日志（method/path/status/duration/site/requestId）与最小指标端点；把 `scripts/backup.mjs` 接成 compose profile 或文档化的 cron。

### 5.2 高

**H1. 公开读路径没有任何速率限制**

- 证据：全仓只有 4 处限流调用：运营者登录（`src/server/http.ts:455`）、后台元数据抓取（`:504`）、站点认证（`src/server/auth.ts:627`）、邮箱+来源（`:663`）。`/api/search`、`/api/catalog`、`/api/config`、`/sitemap-*.xml`、`/badge/*` 均无限流（`:1052-1070`、`:1080-1122`）。
- 影响：搜索走 `pg_trgm` + `similarity()` + `count(*)`，sitemap 分片一次可读 45,000 条；公网脚本可以用很低成本放大数据库压力。对自托管小站风险可接受，但对"多个独立品牌站点"产品是明显缺口。
- 建议：在应用层加按 IP/站点的读桶（可复用 `AuthLimiter`，key 用 `read:<site>:<ip>`），或在参考代理配置里做 `rate_limit`；sitemap 已有 60 秒缓存，可再缩短分片大小。

**H2. 数据只增不减，媒体一旦发布永久不可回收**

- 证据：有保留期的只有 `ai_job`、`collector_*`、`submission_image`、`metadata_fetch`、`scheduled_publish`、`distribution`（`src/server/maintenance.ts:40-48`）。`audit_event`、`publication_revision`、`config_revision`、`outbox`（done）、`content_operation`、`config_operation` 都没有清理策略。媒体删除要求"任何发布记录（含已下架）都不引用"（`src/server/content.ts:819-834`、`src/server/media.ts:450-495`），而 publication 行没有删除路径。
- 影响：长期运营后修订/审计表成为主要增长源；站点配额（默认 1 GiB / 5,000 文件）被历史图片占满后，即使内容早已下架也无法回收，只能调高配额或手工改库。
- 建议：给 `*_operation` 设 30–90 天保留期（幂等窗口足够）；`audit_event` 提供导出后按年清理或分区；为媒体提供"解除历史引用"的显式管理操作（例如清空已下架 publication 的 image/logo 引用），并写进运维文档。

**H3. 访客账号没有删除、封禁或导出能力**

- 证据：后台只有运营者（`operator_*`）管理，没有访客账号列表；`identity_user.banned` 字段存在，但除登录校验外没有任何写入路径；Better Auth 的 `deleteUser` 未启用。
- 影响：公开站点允许注册、投稿、收藏，却无法响应"删除我的账号/数据"、无法处置滥用账号、无法做数据导出。对欧盟/加州等地区的公开部署是合规缺口，对垃圾投稿也缺少最后手段。
- 建议：至少提供管理员侧的"封禁 + 撤销全部会话 + 匿名化邮箱"操作与 CLI；若要支持用户自助删除，需明确收藏/投稿的保留或匿名化规则。

**H4. 三个高频查询缺索引**

- 证据：`publication` 只有 `(site_id,locale,status,rank,slug)`、trgm、`category_ids`、`tag_ids` 索引（`migrations/003-content.sql:43`、`migrations/006-search.sql:2`、`migrations/015-content-model.sql:26-27`），没有 `(resource_id, locale)`；`content_draft` 只有主键 `(site_id,resource_id,locale)`。而分发/查重按 `resource_id + locale` 跨站查询（`src/server/content.ts:1012-1054`、`src/server/distribution.ts:595-615`），媒体用量按 `image_media_id/logo_media_id` 查 `public_listing`（`src/server/content.ts:798-834`）。
- 影响：在 30 万发布记录的基线上，每个分发任务会多次顺序扫描 `publication`/`content_draft`；媒体删除/版本检查同样全表扫描。功能正确，但延迟随数据量线性增长。
- 建议：新增迁移 `021-review-indexes.sql`：`CREATE INDEX publication_resource ON publication(resource_id, locale);`、`CREATE INDEX content_draft_resource ON content_draft(resource_id, locale);`，并评估 `public_listing` 上 `(site_id,image_media_id)` / `(site_id,logo_media_id)` 的表达式索引。

**H5. 加密密钥没有轮换路径**

- 证据：`seal/unseal` 没有 key id 或版本（`src/server/crypto.ts:24-48`）；`AUTH_ENCRYPTION_KEY` 加密 AI key、登录提供方 secret、`auth_instance.sealed_secret`、邮件队列 payload。`backup.mjs` 只验证应用密钥能解开现有密文，没有 re-seal 工具；`auth-upgrade` 只重跑 schema 迁移。
- 影响：一旦密钥泄漏或需要定期轮换，除了重建所有 auth instance / 重填所有 provider 与 AI 配置之外没有路径；属于"平时不痛、事故时最痛"的缺口。
- 建议：在密文前加 1 字节 key 版本，支持新旧密钥并存解密；提供 `cli re-seal` 逐行重加密（在事务内、可断点续跑）；文档写明轮换演练步骤。

### 5.3 中

| 编号 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| M1 | OIDC issuer / userinfo 未做私网校验或 DNS pinning，与 AI、采集器、余额查询的 SSRF 标准不一致 | `src/server/providers.ts:28-45`、`src/server/auth.ts:144-170` | 复用 `publicUrl`/`requestText`，或至少在 fetch 前解析并拒绝私网；管理员可配置不等于可信 |
| M2 | 每个公开请求重复解析 Host→site | `src/server/http.ts:334-338` 与 `:920` | 复用第一次的 `mediaContext`，省一次 DB 查询 |
| M3 | 可缓存响应先整包读入内存再算 ETag；sitemap 分片可达数 MB | `src/server/http.ts:231-260` | 用 `revision + updated_at` 生成弱 ETag，或流式 hash；超大响应跳过缓冲 |
| M4 | 搜索/列表每次 `count(*)` 扫描全部匹配行，容量基线 p95 已接近 1 秒 | `src/domain/catalog.ts:141-170`；`docs/history/P5-FINAL.md` 容量表 | 评估近似计数、上限截断或物化计数；为搜索加 read 桶（见 H1） |
| M5 | `Limits.save` 是"查存在 → upsert → 再查 → 写审计"四步非事务；其他部分写路径审计也在业务事务外 | `src/server/limits.ts:50-83` | 放进 `transaction`，并在事务内 `require(..., c)`；审计要么同事务，要么接受"可缺失"并写明 |
| M6 | 分发的自动发布依赖启发式 gate：定性幻觉（无数字、无 URL、无第一人称）可以通过；`domains` 正则会把 "Node.js" 判成新链接 | `src/server/distribution.ts:110-162, 1151-1181` | 文档明确"检查通过 ≠ 事实正确"；对 `*.js`、版本号等做白名单/例外；考虑抽样人工复核 |
| M7 | `react-dom/server` 通过 `getBuiltinModule` + `createRequire` 绕过 Next 打包，属框架内部行为依赖 | `src/server/templates.ts:20-24` | 增加"构建后启动 + 渲染一页"的 smoke（现有 Docker 验收可裁剪成 CI 任务）；升级 Next 时单独回归 |
| M8 | 测试存在固定 sleep 与共享宿主机资源（`/etc/hosts`、`sudo docker`、独占 DB），并行时偶发失败 | `tests/p12/browser.test.ts:80,431-441,481,536-539`；多份验收文档 | 用轮询断言替换固定等待；把 flaky 用例标注并隔离；CI 上串行与并行各跑一次 |
| M9 | 没有 lint/format、`pnpm audit`、依赖更新机制；`check-boundaries` 是正则启发式（`FROM "publication"`、`public_listing` 可绕过） | `package.json` scripts；`scripts/check-boundaries.mjs:130-161` | 引入 ESLint（至少 `no-unused-vars`、`no-floating-promises`）与 Prettier；把边界检查升级为"仅允许导入 Catalog/Content 导出"的模块级规则 |
| M10 | 文档漂移：README 仍有已删除的 `pnpm test:p0:next`、仍称"正式品牌待确定"；`.env.example` 称 compose 不传 `RETENTION_*`（实际已传），且缺 `BACKUP_ENCRYPTION_KEY` | `README.md:16,39`；`.env.example:33`；`compose.yaml:19-22` | 以 PROJECT-HISTORY 为准重写 README 状态段；修正 `.env.example` 并补备份密钥说明（`docs/README.md` 的索引状态已在本次审查中同步） |
| M11 | 语言硬编码在 schema 层：5 处 `CHECK(locale IN ('zh','en'))` + 多处 `z.enum(["zh","en"])` + 模板 i18n | `migrations/003-content.sql:23`、`009-collectors.sql:33`、`017-comparisons.sql:3`、`020-distribution.sql:28,44`、`src/server/content.ts:12` | 把"第三语言"从"配置项"改述为"需要迁移 + 代码 + 文案的工程"；若近期要做，先抽 locale 注册表 |
| M12 | 后台是纯 JS SPA，CSP 严格，脚本失败即整页不可用；主题在 JS 加载后才应用，可能与系统主题闪烁 | `src/ui/admin.js:400-417`；`src/ui/pages.ts:163-172` | 增加 `<noscript>` 提示与关键状态服务端兜底；后台也加一个同步的 theme init 脚本（与 toolso 一致） |
| M13 | 迁移全部在单事务内执行，含全表 UPDATE 与 `CREATE INDEX`，大库升级停机不可控 | `src/server/migrate.ts:22-36` | 为大数据量迁移提供分批/停机窗口说明；评估把索引创建拆到事务外（需 `CONCURRENTLY`，与当前"单事务全有或全无"取舍冲突，应在文档中写明） |

### 5.4 低

| 编号 | 问题 | 证据 |
| --- | --- | --- |
| L1 | 缺 HSTS、Permissions-Policy；CSP 未显式写 `object-src 'none'`（`default-src 'self'` 会兜底，但显式声明更清晰） | `src/server/http.ts:265-274` |
| L2 | scrypt 用 Node 默认参数（N=16384），未显式声明成本或调优记录 | `src/server/crypto.ts:13-17` |
| L3 | 12 处未使用声明；`publicPage` 导入被同名局部变量遮蔽；`ui/directory.ts` 的 `directoryPage/detailPage/missingPage` 已无调用方 | `tsc --noUnusedLocals` 输出 |
| L4 | 预览/演示站点没有站点级 `robots` 禁收录；只有页面级 `noindex` | `src/server/http.ts:1071-1079`、`:659` |
| L5 | 错误文案中英混杂（`NotFound` 返回 `"Not found"`），面向运营者的 API 不统一 | `src/server/http.ts:191-212` |
| L6 | CHANGELOG 的 rc.3 标题缺空格；没有 `Unreleased` 段承载未发版变更 | `CHANGELOG.md:3` |
| L7 | 没有 favicon，任何 `/favicon.ico` 请求都走 404 模板 | 路由未处理 |
| L8 | 采集器的实体解码未限幅：`&#xFFFFFF;` 会抛 `RangeError` 使整个任务失败（仅影响该来源的任务） | `src/server/collector-adapters.ts:38-51`（对比 `src/server/metadata.ts:24-27` 已限幅） |

## 6. 专项评估

### 6.1 安全

- **认证与会话**：运营者 cookie `HttpOnly + SameSite=Strict + Path=/admin + https 时 Secure`，令牌只存哈希，8 小时绝对过期；非 GET 请求校验精确 Origin；登录对不存在/停用/错误密码返回同一文案并做 dummy scrypt（`src/server/operators.ts:45-78`、`src/server/http.ts:323-325, 435-444`）。
- **CSRF**：后台靠 Origin + SameSite；访客写接口额外校验 `origin === site.origin`（`src/server/http.ts:957-959`）；Better Auth `trustedOrigins` 限定实例源。
- **SSRF**：四条出站路径（元数据、采集、AI、余额）都做了"仅 HTTPS + 解析 + 私网拒绝 + 地址 pin + 超时 + 大小上限"；OIDC 是唯一例外（M1）。
- **注入**：SQL 全部参数化，动态表名来自固定联合类型；`checkDataBoundary` 作为补充。未见命令注入、路径穿越、反序列化入口。
- **输出编码**：见第 4 节第 6 条。
- **密钥**：AES-GCM + 随机 12 字节 nonce；密钥 32 字节；备份密钥与应用密钥强制不同；日志不打印密钥（`ai-billing` 明确不记录 key/body）。
- **缺口**：密钥轮换（H5）、OIDC SSRF（M1）、公开读限流（H1）、无安全响应头 HSTS（L1）。

### 6.2 多租户与数据边界

- 站点由 Host 唯一确定，`site_id` 从不接受客户端输入；公共查询全部带 `site_id`；管理服务先 `require(actor, site)`，写操作在事务内再查一次。
- 跨站共享是显式的：资源主档全局，但只有全局管理员能编辑；站点编辑只能通过投稿/采集创建主档，且给别站新增发布对需要网络管理员（`src/server/content.ts:878-879`）。
- 分发矩阵、任务详情、定时发布都按 `access.read` 过滤（`src/server/distribution.ts:537-556, 579-627`）。未发现可越权读取别站内容的路径。
- 唯一"全局可见"的是资源主档本身（按设计共享）；`/resources` 仅全局管理员可读。

### 6.3 并发与一致性

- 锁顺序统一：业务咨询锁 → 行锁 → 审计；跨站操作先按排序获取多把咨询锁（`distribution.unpublishEverywhere`、`batchReview` 逐条）。
- 版本 CAS 覆盖配置、内容、媒体、persona、榜单、对比；冲突返回 409 而不是覆盖。
- 幂等键覆盖发布与配置发布；指纹不符报冲突。
- 租约/心跳覆盖 outbox、邮件、AI、采集、分发、定时发布；失败重试有上限；超过 24 小时的定时发布标 missed 而不是意外上线。
- 残余风险：所有跨进程协调都依赖 PostgreSQL 咨询锁与轮询，单库是明确假设；文档已声明单应用/集中运维，水平扩展 web 副本时配置缓存无广播（5 秒窗口）。

### 6.4 内容、AI 与分发

- 内容模型"主档 + 各站发布"落地干净；发布冻结图片版本、`published_at` 取首次发布；下架保留行、不清历史。
- AI 输入用 `<data>` 包裹并转义 `<>&`，系统提示明确"内容是数据不是指令"；输出只接受 JSON 并做严格 schema；额度预扣 + 预留列 + 月度汇总，取消/丢租约也计费（`src/server/ai.ts:715-830`）。
- 分发的门禁、查重、重写一次、人工复核、定时发布、手动模式都实现完整，测试覆盖 IDOR 与并发查重。
- 主要风险是**产品性**而非实现性：通过检查即自动发布意味着"合格但事实错误"的定性内容可能上线；这是 Q1 的明确选择，但应在运营文档中反复强调，并建议上线初期保持人工抽检。

### 6.5 性能与容量

- 现有基线（共享主机，30 站 / 10 万主档 / 30 万发布）：列表 p95 约 0.93–0.97 s，搜索约 0.43 s，详情约 0.19 s，登录约 0.37 s。对个人/小团队可用，但列表接近 1 秒，说明 `count(*)` + 排序是主要成本。
- 缓存：配置 5 s TTL；公开页面/资产 60 s/3600 s + ETag；媒体 immutable。没有 CDN 假设。
- 连接：web 池 12 + 认证锁池 8；worker 独立。Postgres 默认连接数足够单机。
- 真正的扩展瓶颈是单库 + 全表计数 + 缺少 H4 索引，而不是 Node 进程。

### 6.6 可运维性

- 优点：健康检查区分 web/worker；worker 有心跳；维护任务有状态行；备份/恢复/源码导出都有脚本；`preflight.mjs` 做环境预检。
- 缺口：无监控指标、无结构化日志、无告警、无自动备份、无生产代理配置、无密钥轮换、无升级回滚演练脚本（文档有步骤，但不是可执行资产）。

### 6.7 测试与 CI

- 深度：P0–P17 覆盖单元式纯函数、真实 PG 集成、HTTPS 服务器、Playwright 浏览器、Docker 全链路；安全用例（IDOR、越权、预算原子性、并发查重、CSRF 相关路径）写得具体。
- 问题：CI 覆盖（B1）、固定 sleep（M8）、需要 sudo/hosts 的高门槛、无覆盖率、无 lint、无依赖审计。
- 建议优先级：先接 CI（B1），再谈覆盖率；覆盖率对这类集成测试的边际价值低于"每次提交都跑"。

### 6.8 文档与治理

- 这是项目最强的非代码资产：ADR、阶段验收、Review 修复记录、镜像证据复核包、决策卡、许可请求草稿、模型交接提示词，形成可追溯链。`docs/PROJECT-HISTORY.md` 作为总览准确度很高。
- 漂移集中在"入口层"：根 README、docs 索引、`.env.example`。内部阶段文档反而比入口新。
- 建议：把 README 的"当前状态"改为从 PROJECT-HISTORY 摘录的短段落，并加一条 CI 检查（README 中的 `pnpm <script>` 必须存在于 package.json）。

### 6.9 许可与分发

- AGPL-3.0-only + Apache-2.0 归属头 + `third-party` 证据链 + 源码归档 + 镜像证据，在本项目规模下属于超配。
- 代价是流程重：任何 `docs/` 变更都会改变镜像 digest，签署镜像只能对应签署前的候选提交。**本轮新增本文也会改变下一次构建的镜像 digest**；rc.3 证据仍对应 `42390d8` 候选镜像，这是既有惯例，不是本文引入的问题，但下次重建镜像前需要按流程刷新证据，或在发布说明中明确"证据绑定候选提交"。

## 7. 与 PROJECT-HISTORY 的核对

| PROJECT-HISTORY 叙述 | 代码/仓库现状 | 结论 |
| --- | --- | --- |
| 新站点只用独立账号，共享中心冻结为 legacy | `sites.create` 拒绝 `centerSite` 除非 `legacyShared`；`auth.publicOptions` 标记 shared | 一致 |
| Q2 没用向量复核，接近阈值转人工 | `SIMILAR=0.4` 直接进 `reasons` 转 review，无向量依赖 | 一致 |
| Q3 每站自己是 canonical | 详情/首页/对比页 canonical 均用 `site.origin`；`primary_site_id` 注释明确不影响 canonical | 一致 |
| Q4 资料更新先标记，再手动重写 | `publication.source_version` 与 `resource.content_version` 比较；矩阵显示 `stale`；统计变化不触发 | 一致 |
| Q5 分发复用各站额度 | 分发 `ai_job` 用目标站预算，`monthlyTokensUsed` 统一计算 | 一致 |
| Q6 可指定时间或自动错开 | `scheduled_publish` + `stagger_days` 随机 | 一致 |
| M19 方案 3 黑白高对比、⌘K、主题 | `pages.ts` 的 `.console` 主题、`admin.js` 命令面板与主题菜单 | 一致 |
| 长期不做服务端图片转码（避免 sharp） | `package.json` ignoredOptionalDependencies=sharp；`next.config.mjs` images.unoptimized | 一致 |
| v0.2.0-rc.3 已签署 | tag 存在，`third-party/image-review.json` 状态 complete | 一致 |
| 版本表暗示 rc.3 是当前版本 | `package.json` 仍是 rc.1 | **不一致**（B2） |
| "下一轮候选：zh/en 以外语言" | 语言写死在 DB CHECK 与 zod | 方向一致，但成本被低估（M11） |
| README 称品牌待定 | HISTORY 已定 Qoo.IM Directory | **不一致**（M10） |

## 8. 建议路线图

### 立即（1–3 天，低风险高收益）

1. bump `package.json` 版本，并在 `release.mjs check` 加 tag/版本一致性校验（B2）。
2. 修正 `.env.example`（`RETENTION_*` 注释、补 `BACKUP_ENCRYPTION_KEY`）与根 README 的失效命令/品牌状态（M10）。
3. 开启 `noUnusedLocals`，清理 12 处未使用声明（L3）。
4. 加 H4 索引迁移并跑一次 P17/P2 回归。
5. 后台加同步主题脚本 + `<noscript>`（M12）。

### 稳定版前（1–2 周）

1. CI 接入 P6–P17：PR 冒烟子集 + main 全量；先解决 M8 的固定 sleep（B1）。
2. 生产部署包：`deploy/Caddyfile.production`、环境变量清单、HSTS、限流、备份 cron 示例（B3）。
3. 观测最小集：结构化请求日志 + `/health` 扩展 + worker 心跳暴露（B3）。
4. 公开读限流（H1）与媒体历史引用回收（H2）。
5. 密钥版本化与 re-seal CLI（H5）；OIDC 私网校验（M1）。
6. 访客账号封禁/匿名化（H3，可与隐私政策一起发布）。

### 稳定版后

- 第三语言（按 M11 的工程成本排期）、审计导出/分区、CDN/多副本配置缓存、性能优化（count、ETag、索引复盘）、ESLint/Prettier/依赖审计、覆盖率基线。

## 9. 附录

### A. 本轮执行的命令与结果

```text
npx tsc --noEmit                                → 通过
npx tsc --noEmit --noUnusedLocals               → 12 处未使用声明（4 处在 src）
node scripts/check-boundaries.mjs               → Public/template dependency boundaries passed
node scripts/build-toolso-css.mjs --check       → 通过
node --test tests/p5/release.test.mjs           → 69/69 通过
docs 相对链接检查（脚本）                        → 0 断链
```

未执行：`pnpm build`、P0–P17、`test:docker`（本环境无 Docker/sudo）。因此本文对构建产物与运行期行为只做代码级推断，不替代验收记录。

### B. 建议的检查项（可直接变成 issue）

- [ ] CI：PR 跑 P1/P2/P17 冒烟；main 跑 P0–P17；nightly 跑 Docker。
- [ ] `release:check` 校验 `git describe` 与 `package.json.version`。
- [ ] 迁移 021：`publication(resource_id,locale)`、`content_draft(resource_id,locale)`、媒体引用索引。
- [ ] `/health` 返回 `{db, migrations, workerHeartbeat, mediaWritable}`。
- [ ] 公开读限流 + 429 文案 + 指标计数。
- [ ] `audit_event`/`*_operation` 保留策略与清理任务。
- [ ] 媒体"解除已下架引用"管理操作 + 配额回收说明。
- [ ] 访客账号封禁/匿名化 API + CLI + 审计。
- [ ] OIDC issuer/userinfo 走统一出站校验。
- [ ] 生产 Caddyfile（TLS/HSTS/真实 IP/代理令牌/限流）。
- [ ] 根 README 状态段同步（命令与品牌）；文档索引已在本轮同步。
- [ ] ESLint（`no-unused-vars`、`no-floating-promises`）与 Prettier。

### C. 评分说明

评分是审查者主观判断，用于横向比较而非验收结论。"阻断"指建议在稳定版发布前处理，不等同于项目阶段失败；"高"指会造成数据、合规或可用性实质风险；"中"指可维护性/性能/体验的持续成本；"低"指清理项。
