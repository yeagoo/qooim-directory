# 垂直采集器：RSS / npm / 通用 JSON

状态：M5 已实现。新增统一采集队列，不替换既有 GitHub 专用同步；GitHub 行为保持不变。

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

## 安全与限制

- 不抓网页 HTML、不登录、不绕过 robots/付费墙；仅公开 RSS/API/JSON。
- RSS 拒绝 DOCTYPE/ENTITY，避免外部实体；正则解析不是通用 XML 解析器，畸形 feed 会失败而不执行内容。
- 候选内容按纯文本/转义渲染；标题/说明截断，URL 只允许 http(s)。
- 没有采集源配额、凭据、代理、Webhook；没有 YouTube/Product Hunt/社交平台。
- 没有候选批量审核、定时编辑 UI、保留期清理、失败重试 UI。
- 当前 GitHub 仍用 `github_source`/`github_worker`，未迁移到新采集表；两套入口并存是兼容性选择，不是统一适配器完成。

## 测试

P4 覆盖：

- RSS 候选生成、接受只创建草稿、拒绝；
- RSS DOCTYPE 拒绝、npm 搜索规范化、通用 JSON 映射；
- 来源保存的私网 URL 拒绝；
- 既有 GitHub 回归全部保留。

详见 [M5 验收](ACCEPTANCE-M5-20261021.md)。
