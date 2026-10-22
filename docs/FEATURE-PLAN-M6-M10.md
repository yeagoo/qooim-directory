# M6–M10 开发方案：配额、保留期、运维 UI 与采集器统一

日期：2026-10-22。输入是 `v0.2.0-rc.1` 各里程碑验收中列为“未做/限制”的项目。本文是方案；实施状态见每节“状态”。

## 范围与原则

沿用 [2026 Q4 规划](FEATURE-PLAN-2026Q4.md) 的共同原则：站点作用域、人工审核优先、默认关闭、新增数据进入备份。另加两条：

1. **先治理增长，再加功能**。会无限增长的表和目录（`ai_job`、`collector_*`、媒体卷）先有配额和保留期，之后才加 UI。
2. **保留期不能破坏语义**。AI 预算按月计算，所以当月任务不能删；采集候选同时是去重记录，所以已审核候选只压缩不删除。

## 顺序

| 里程碑 | 内容 | 估算 | 依赖 |
| --- | --- | --- | --- |
| **M6** | 配额与保留期：站点配额、媒体配额/孤儿清理、AI 用量汇总/任务保留、采集候选压缩/任务保留、采集来源配额与频率限制 | 1.5–2 周 | — |
| M7 | 运维 UI：AI 任务列表/取消/重试，采集任务失败重试，候选批量审核，来源定时编辑 | 1.5 周 | M6（列表需分页和保留期语义） |
| M8 | 媒体增强：替换（新版本）、版本历史、批量上传 | 1.5–2 周 | M6 配额 |
| M9 | AI 治理：提示词版本管理 UI、token 对账、可选余额检查 | 1.5 周 | M6 的 `ai_usage_month` |
| M10 | GitHub 迁到统一采集器 | 2–3 周 | M6/M7（共用任务、保留期和重试 UI） |

M10 放最后：改动面最大，并且需要 M6/M7 先把统一采集器的配额、保留期和重试补齐，否则 GitHub 迁过去会丢掉现在专用链路里已有的能力。

## M6 配额与保留期（第一步）

状态：代码已完成，本地回归通过（2026-10-22，见 CHANGELOG Unreleased）；尚未发布。

### 共享基础

- 迁移 `010-quota-retention.sql`：
  - `site_limit`：每站覆盖值，NULL 表示默认值；
  - `ai_usage_month`：按站点和月份汇总的 AI 用量；
  - `collector_candidate.task_id` 改为可空，并设 `ON DELETE SET NULL`；新增 `reviewed_at`、`compacted_at`；
  - 保留期和频率限制用的索引。
- `src/server/limits.ts`：默认配额（媒体 1 GiB / 5000 个文件，采集来源 20 个，采集频率每小时 60 次）。`GET/POST /admin/api/limits`：站点成员可读，只有站群管理员能改；改动写审计 `site.limit.save`。
- `src/server/retention.ts`：保留期策略，可以通过环境变量覆盖（见下表）。
- `src/server/maintenance.ts`：Worker 每小时最多执行一次。用 `maintenance_status('retention')` 原子抢占执行权，所以多个 Worker 不会同时清理。各部分的失败互不影响，结果写入 `maintenance_status.detail`，后台任务页可以看到。
- CLI：`site-limit <site>`、`site-limit-set <site> <file.json>`、`retention-run`（强制立即执行一次）。

| 环境变量 | 默认 | 最小 | 含义 |
| --- | --- | --- | --- |
| `RETENTION_AI_DAYS` | 180 | 35 | 已结束的 AI 任务保留天数；当月任务永远不删 |
| `RETENTION_COLLECTOR_TASK_DAYS` | 30 | 1 | 已结束的采集任务保留天数 |
| `RETENTION_COLLECTOR_SUPERSEDED_DAYS` | 30 | 1 | 已作废候选删除前保留天数 |
| `RETENTION_COLLECTOR_REVIEWED_DAYS` | 90 | 1 | 已审核候选压缩前保留天数 |

### 媒体

- 上传时检查字节和文件数配额。检查、写文件、写数据库都在同一个站点级 advisory lock 内完成，所以并发上传不会超出配额。重复上传同一文件（同站同 sha256）不占配额。调低配额只阻止新上传，已有文件不删。
- `GET /admin/api/media/usage?site=`：返回已用量和配额，媒体页会显示。
- 孤儿清理会删除：超过 60 分钟的 `.tmp-*` 文件；超过 60 分钟、且数据库里没有对应记录的哈希文件。符号链接和不认识的文件名不动。数据库有记录但文件丢失的，只统计数量，不删记录。

### AI

- 先把已结束任务的用量按“站点 + 月份”汇总进 `ai_usage_month`，再删除这些任务。只处理“已结束超过保留期”且“不在当月”的任务，分批执行，可以重复运行。
- 预算统计 = 当月 `ai_job` + 当月 `ai_usage_month`。这样即使改了保留期，预算也不会少算。
- `GET /admin/api/ai/usage?site=`：返回近 12 个月的用量。清理前后总数应该一致，这也是 M9 对账的基础。

### 采集器

- 已作废候选超过保留期就删除。之后如果 feed 里还有这一条，会重新进入待审核。
- 已接受和已拒绝的候选超过保留期只压缩：清空 `data`，保留 `external_id`、`fingerprint`、`status`。这样之前拒绝过的条目不会再出现。
- 已结束的任务超过保留期就删除；候选的 `task_id` 会置空。
- 待审核候选、未结束的任务永远不动。
- 来源配额：新建来源时在站点锁内计数，超限返回 409；编辑已有来源不受影响。
- 频率限制：按站点统计最近一小时创建的任务数。手动同步超限返回 429，用同一个操作 ID 重放仍然返回原任务。定时调度只排队剩余额度内的来源，其余来源推迟 15 分钟。额度设为 0 表示停用本站采集。
- 用 10 万条候选做清理性能验收。

### 验收

- 新增 `tests/p6/`（foundation/media/ai/collectors），P0–P5 全量回归、`pnpm check`、`pnpm build`、`pnpm test:release` 都要通过。`package.json` 和 `compose.yaml` 是镜像 evidence 固定的输入文件，M6 不改动它们；`test:p6` 脚本和 Compose 透传 `RETENTION_*` 留到发布前刷新 evidence 时一起加入。
- 迁移 010 在空库和已有 v0.2.0-rc.1 数据上都能应用。
- 不新增依赖。

### 不做

- 不自动删除“没有被引用的媒体”：这是运营者主动上传的内容。
- GitHub 专用表（`github_task`/`github_candidate`）的保留期留给 M10 统一处理。
- 不做配额计费，也不做超额告警通知。

## M7 运维 UI

状态：代码已完成，本地回归通过（2026-10-23，见 [M7 验收](ACCEPTANCE-M7-20261023.md)）；尚未发布。与原方案的差异：采集任务重试沿用“同步仅限站群管理员”的既有规则；批量审核与单条审核一样，站点编辑者可用。

- AI：任务列表（分页、状态筛选）。`pending` 可以取消；`failed` 可以重试：新建任务并带上来源任务 ID，原任务不改，便于审计。
- 采集：任务列表，失败任务一键重试（复用手动同步的幂等操作 ID 和频率限制）。来源编辑表单加入启用开关和同步间隔。
- 候选批量审核：一次最多 100 条，每条都校验版本，结果逐条返回，不承诺整批原子。批量接受仍然只建草稿。
- 后台显示保留期策略和最近一次清理结果（读 `maintenance_status`）。

## M8 媒体增强

状态：代码已完成，本地回归通过（2026-10-23，见 [M8 验收](ACCEPTANCE-M8-20261023.md)）；尚未发布。与原方案的差异：旧地址的跳转不缓存（原方案为短缓存），因为重新发布后跳转目标会变。

- 引入 `media_version`。“替换”会生成新版本：草稿引用的是媒体 ID，会看到新版本；已发布内容固定在发布时的版本，重新发布后才切到新版本，保持发布冻结语义。公开 URL 改为 `/media/<id>/<version>`，旧 URL 跳转到已发布版本。
- 版本历史：列出各版本，可以把旧版本设为当前版本（这会生成一个新版本，不改历史）。
- 批量上传：前端逐个文件上传，逐个计入配额，失败单独提示；服务端不改为 multipart。
- 备份清单加入版本信息，孤儿清理需要识别各版本文件。

## M9 AI 治理

- 提示词模板表 `ai_prompt(kind, version, system, task, created_by, created_at)`，内置 v1 作为只读种子。站点选择每种任务用哪个版本；任务记录 `prompt_version`（字段已有）。改提示词只能新建版本。
- 对账：导入供应商用量 CSV/JSON（按天或按月的 token 数），和 `ai_usage_month` 加当月 `ai_job` 对比，显示差异，不自动修正预算。
- 余额检查：OpenAI-compatible 协议没有标准的余额接口，所以默认不支持。只提供可选的“余额端点 + JSON 字段路径”，并沿用同一套 SSRF 防护；读不到时显示“未知”。

## M10 GitHub 迁到统一采集器

- 定义 adapter 接口：`validateConfig`、`fetch`、`normalize`、`contentHash`、`statsFields`、`reviewFields`。RSS、npm、JSON 先改成 adapter（不改变行为），GitHub 作为第四个 adapter。
- 迁移 `github_source/task/candidate` 数据到 `collector_*`，保留 ID、版本、etag、last_hash 和待审候选。需要补的统一表字段：`resource_id`（绑定已有主档）、`last_hash`、`remote_id`。
- 保留 GitHub 现有语义：统计字段自动更新，内容字段逐字段审核；全局 `github_budget` 速率预算继续生效。
- 旧 `/admin/api/github/*` 接口和 CLI 保留一个版本，作为兼容层转发到新表；下一个版本再删除。
- 验收：P4 现有 GitHub 30 项回归全部改为通过新链路运行，并且结果不变；对 v0.2.0 数据做迁移演练并能恢复。
