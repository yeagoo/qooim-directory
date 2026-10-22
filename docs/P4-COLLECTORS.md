# 垂直采集器：RSS / npm / 通用 JSON

状态：M5 已实现；M10 起 GitHub 也运行在同一套来源/任务表和 Worker 上（作为“绑定型” adapter，见 [P4 GitHub](P4-GITHUB.md#统一来源与任务m10)），本页描述的是“发现型”来源。

## 支持类型

| 类型 | 配置 | 行为 |
| --- | --- | --- |
| `rss` | `{"url":"https://.../feed.xml","locale":"zh"}` | 解析 RSS/Atom 的 `item`/`entry`，最多 50 条 |
| `npm` | `{"query":"react","locale":"en"}` | 调用 npm 官方搜索 API，最多 50 个包 |
| `json` | `url` + `itemsPath` + 字段映射 + `locale` | 读取公开 JSON 数组；字段映射是简单点路径，不是 JSONPath |

配置中的 URL 必须是公开 HTTPS；保存时拒绝 localhost、`.local/.internal` 和字面私网 IP；Worker 拉取时再解析 DNS 并拒绝私网、限制 2 MiB/10 秒、最多跟随 2 次公开重定向。

## 流程

1. 后台站点页 → “采集器”创建来源；可立即同步或等待定时任务。
2. Worker 拉取并规范化，写入 `collector_candidate`：
   - `external_id` 按来源去重；
   - 候选保存 `resourceData`（URL/标题/说明/语言）；
   - 同一来源重复项只在 pending 且内容变化时更新。
3. 后台待审核列表：
   - “接受为草稿”创建 `collector-<id>` 主档和一条 `content_draft`；
   - 不自动发布，仍需在内容页编辑/发布；
   - “拒绝”只改候选状态。

## 数据与 API

迁移 `009-collectors.sql`：

- `collector_source`：站点、kind、config、enabled、interval、version、etag、next_run_at；
- `collector_task`：手动/定时同步任务、租约、重试、错误；
- `collector_candidate`：external_id、locale、data、fingerprint、审核状态、接受后的 resource id。

| 方法/路径 | 用途 |
| --- | --- |
| `GET/POST /admin/api/collectors` | 列表/创建或更新来源 |
| `GET /admin/api/collectors/<id>` | 来源和候选 |
| `POST /admin/api/collectors/<id>/sync` | 手动同步（operationId 幂等） |
| `GET /admin/api/collector-candidates?site=<id>` | 待审核候选 |
| `POST /admin/api/collector-candidates/<id>/review` | 接受/拒绝，乐观版本 |
| `GET /admin/api/collectors/usage?site=<id>` | 来源数/配额、最近一小时采集次数/上限（M6） |
| `GET /admin/api/collectors/tasks?site=<id>&status=&page=` | 任务列表，每页 50 条，按时间倒序（M7） |
| `POST /admin/api/collectors/tasks/<id>/retry` | `{site,operationId}`；重试失败的任务，与手动同步共用频率限制；重放同一个 `operationId` 返回原任务；仅限站群管理员（M7） |
| `POST /admin/api/collector-candidates/batch-review` | `{site,decision,items:[{id,expectedVersion}]}`，每批 1–100 条；站点编辑者可用（M7） |

### 运维操作（M7）

- 权限沿用原有规则：管理来源、手动同步、重试会对外发起请求，只有站群管理员能做；审核候选（单条或批量）只生成草稿，站点编辑者就能做。
- 重试只针对 `failed` 的任务；`cancelled` 表示来源已经改过，不能重试。来源停用、或者已经有进行中的任务时，返回 409。重试会新建一个任务，并用 `retry_of` 关联原任务，原任务不改。
- 批量审核不是原子操作：每条单独开事务，单独校验版本；单条失败（版本冲突、已经审核过等）会写进结果，其余照常处理；遇到意外错误时中止，已处理的条目保留。
- 后台采集页可以编辑来源（配置、语言、启用、同步间隔 1–168 小时）；遇到版本冲突时保留用户已填写的内容。

## 配额、频率与保留期（M6）

- 来源配额：默认每站 20 个，停用的来源也计入。新建时在站点锁内计数，超限返回 409；编辑已有来源不受影响。
- 频率限制：默认每站每小时 60 次，统计最近一小时创建的所有任务（手动和定时都算）。
  - 手动同步超限返回 429；用同一个 `operationId` 重放仍然返回原任务。
  - 定时调度只排队剩余额度内的来源，其余来源推迟 15 分钟。
  - 额度设为 0 表示停用本站采集，但已经排队的任务仍会执行。
- 保留期（Worker 每小时运行，见 [P5 运维](P5-OPERATIONS.md#保留期与配额)）：
  - 已结束的任务超过 `RETENTION_COLLECTOR_TASK_DAYS`（默认 30）天后删除，候选的 `task_id` 置空；
  - 已作废（superseded）的候选超过 `RETENTION_COLLECTOR_SUPERSEDED_DAYS`（默认 30）天后删除，之后如果 feed 里还有这一条，会重新进入待审核；
  - 已接受或已拒绝的候选超过 `RETENTION_COLLECTOR_REVIEWED_DAYS`（默认 90）天后只压缩：清空 `data`，保留去重键和审核结果，所以已拒绝的条目不会再出现。后台“候选历史”里显示为“已归档”；
  - 待审核候选和未结束的任务永远不会被清理。
- 10 万条候选的清理验收：用时约 2.4 秒，分 2 次运行完成。

## 安全与限制

- 不抓网页 HTML、不登录、不绕过 robots/付费墙；仅公开 RSS/API/JSON。
- RSS 拒绝 DOCTYPE/ENTITY，避免外部实体；正则解析不是通用 XML 解析器，畸形 feed 会失败而不执行内容。
- 候选内容按纯文本/转义渲染；标题/说明截断，URL 只允许 http(s)。
- 没有采集凭据、代理、Webhook；没有 YouTube/Product Hunt/社交平台。

## 测试

P4 覆盖：

- RSS 候选生成、接受只创建草稿、拒绝；
- RSS DOCTYPE 拒绝、npm 搜索规范化、通用 JSON 映射；
- 来源保存的私网 URL 拒绝；
- 既有 GitHub 回归全部保留。

详见 [M5 验收](ACCEPTANCE-M5-20261021.md)。
