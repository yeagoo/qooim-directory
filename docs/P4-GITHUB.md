# P4 开源项目目录与 GitHub 同步

首个垂直模块由用户确认为开源项目目录。当前只同步指定 GitHub 公开仓库的元数据，不扫描组织、不搜索全站、不读取 README 或代码，不执行项目内容，也不下载图片。

## 使用流程

1. 在站点配置勾选“启用开源项目模块”，保存并发布。完整配置的 `modules` 为 `["directory","opensource"]`；开源项目模块依赖通用导航。
2. 全局运营管理员进入后台“开源项目”，选择采集所属站点，输入稳定资源标识及 `owner/repo`，保存来源。可绑定已有主档，也可使用尚未创建的资源标识。
3. Worker 自动排队处理到期来源，也可点击“立即同步”。默认间隔 24 小时，可设置 1–168 小时；点击“刷新候选”查看结果。
4. 比较同步候选与当前主档，选择要应用的字段。已有主档默认只选择仓库元数据；新主档需选择元数据、URL、英文标题和说明。也可拒绝候选。
5. 应用只创建主档新版本，不自动分发或发布。到各站内容页面选择新版、编辑本站覆盖、预览并发布，各站分别生效。

源站描述缺失时，候选说明使用仓库全名，不编造功能或译文。同步仅建议英文内容，中文由运营者补录；不会覆盖未选择的人工文案、备注或各站覆盖字段。

一个资源主档最多绑定一个采集来源，来源固定归属于一个采集站；其他站仍可独立发布该主档。来源所属站点/资源标识不能就地迁移。来源管理、同步与候选应用限全局运营管理员；站点编辑者继续按原有权限编辑本站内容和发布记录。

来源保存、同步与候选审核的等待、失败恢复、未保存编辑和版本确认规则见 [GitHub 来源与候选交互 Review](GITHUB-UI-REVIEW.md)。提交已确认但刷新失败时，使用只读恢复按钮；不要重复发起写入。

## 类型与公共页面

主档 `kind: "repository"` 包含严格校验的 `project`：

| 字段 | 含义 |
| --- | --- |
| provider / repoId / fullName | 固定 github、稳定仓库 ID、仓库全名 |
| stars / forks / openIssues | GitHub 返回的非负计数 |
| language / license | 主语言与识别到的 SPDX 标识，未知为 null |
| topics / archived / pushedAt | 主题、归档状态、最近推送时间 |

这些信息是审批发布时的快照，页面不会实时请求 GitHub。公共 SDK API v1 新增可选 `project`，原模板仍兼容；内置模板显示 Stars、语言、许可证、归档等信息。没有识别到许可证不能据此断言项目开源或可按某许可证使用，采集元数据不构成授权核查。

`publication.module` 根据所选主档版本记录为 directory 或 opensource，`project` 同时冻结在站点发布快照中。统一 `public_listing` 门控列表、搜索、详情、语言链接、收藏与 sitemap。

模块源码声明位于 `src/public/modules.ts`，提供 API 版本、依赖、公共/后台入口、任务和资源类型描述。模块随应用代码部署；没有运行时安装任意模块或代码执行接口。

## 启停、变更与失败

停用某站开源项目模块后，该站已发布的项目不再公开查询；普通网站资源继续可见。本站来源不再发起新请求，已发出的请求无法收回，但完成前会再次检查并阻止候选落库。数据与发布历史保留，重新启用后恢复可见性/排队处理。

来源停用或配置变更会增加来源版本、取消旧的未完成任务、将旧待审候选标记 superseded，并重置条件请求状态。仓库地址变更才重置稳定仓库 ID；仅切换启用状态不会绕开 ID 替换检查。后台仍可查看停用来源的配置与历史，不能发起同步或应用候选。

任务状态为 pending、processing、done、failed、cancelled；候选状态为 pending、accepted、rejected、superseded。任务和候选分别管理。终止失败后可重新发起一次新的同步，旧失败记录保留。

- 固定请求 `https://api.github.com/repos/{owner}/{repo}`，10 秒超时，最大响应 256 KiB；不能填写任意 URL。
- 不自动跟随仓库重定向，避免向其他地址转发凭据；迁移/改名后人工核实并修改来源。
- 不接收私有仓库。404、无权限、私有、无效数据或地址指向不同仓库 ID 时，不更新主档、不自动下架已发布历史快照。
- ETag 条件请求返回 304 或规范化元数据相同，不重复创建候选。拒绝的内容也不会因一次未变化同步反复进入队列。
- 网络错误、响应流中断和 5xx 可重试；403/429 保守退避，并读取 Retry-After/额度重置头。全局预算存 PostgreSQL，至少间隔一秒认领，限流暂停跨进程和重启保留。
- 每次运行最多尝试 5 次，认领租约 60 秒；过期任务可接管，旧令牌不能覆盖新消费者的结果。未来定时运行可重新尝试，不会因耗尽立即无限重排。
- 候选写入、来源 ETag/哈希游标更新与任务完成在同一事务；审核的主档、版本、审计与候选状态也在同一事务。失败回滚，不留下半份发布。

GitHub 请求协议依据 [仓库 REST API](https://docs.github.com/en/rest/repos/repos#get-a-repository)；条件请求和退避依据 [GitHub API 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)。本实现固定 API 版本 `2026-03-10`，已进行一次无凭据的真实公开仓库读取验证；自动化主要使用受控服务，不能保证未来外部平台始终可用。

## 令牌与部署

公开仓库可不配置令牌，但配额较低。可在服务器环境设置 `GITHUB_SYNC_TOKEN`，用于公开仓库只读元数据请求；它与读者 GitHub OAuth 登录凭据分离。不要将令牌写入来源配置、站点 JSON、投稿或模板。

Compose 已将该变量传入运行服务。修改 `.env` 后重建容器环境，普通 restart 不会加载新环境。非法令牌格式启动时拒绝；日志和任务只记录固定错误码，不记录上游响应正文或令牌。

```bash
# 保留现有 .env、数据库卷及应用加密密钥
# 升级前备份；init 应用增量迁移 005，原迁移不改动
docker compose -f compose.yaml -f compose.demo.yaml up -d --build
```

新增的来源、请求幂等映射、任务、候选、预算及发布元数据均保存在 PostgreSQL。完整备份恢复演练、保留策略与容量基线属于 P5；资源 JSON 导出保留项目字段，但不替代来源/任务数据库备份。

## CLI 与接口

CLI 使用既有数据库/加密密钥/运营凭据环境。示例文件：

```json
{"siteId":"atlas","resourceId":"my-project","repository":"owner/repo","enabled":true,"intervalSeconds":86400,"expectedVersion":0}
```

```bash
pnpm cli github-source-save .local/source.json
pnpm cli github-sources 1
pnpm cli github-source SOURCE_UUID
pnpm cli github-sync SOURCE_UUID OPERATION_UUID
pnpm cli github-review .local/review.json
```

审核文件：

```json
{"candidateId":"REPLACE_WITH_CANDIDATE_UUID","expectedCandidateVersion":1,"expectedResourceVersion":0,"decision":"accept","fields":["project","url","source","translations.en.title","translations.en.description"]}
```

已有主档可仅选择 `["project"]`；未选字段保留当前人工内容。候选基线与当前版本供比较，提交必须带当前主档版本和候选版本。并发修改后拒绝写入，重新读取比较后才能提交。相同审核输入重试返回已完成结果；不同输入复用同一已审核候选报冲突。

| 后台接口 | 用途 |
| --- | --- |
| GET/POST `/admin/api/github/sources` | 分页列出 / 乐观锁保存来源 |
| GET `/admin/api/github/sources/:id` | 当前主档及最近 30 条任务/候选 |
| POST `/admin/api/github/sources/:id/sync` | `{operationId}` 幂等排队；已有运行时关联同一任务 |
| POST `/admin/api/github/review` | 按审核文件接受或拒绝 |
| GET `/admin/api/modules` | 内置模块声明 |

列表每页 50 项，候选/任务详情保留最近 30 项展示；数据库历史未据此删除。运营接口继续要求登录、全局权限和同源 POST。没有自动批量发布或站点间自动复制覆盖规则。

## 统计自动更新

`stars`、`forks`、`openIssues`、`pushedAt` 变化不再生成人工候选。同步事务会直接更新主档与已发布站点快照，并把 pending 候选的基线前移；URL、标题、描述、语言、许可、topics、archived 等字段变化仍进入人工审核。审计动作记为 `github.stats`。
