# 2026-10-21 代码 Review 修复记录

审查输入：`src/`、`app/`、`migrations/`、部署脚本；未逐行读 `tests/`、`scripts/distribution.mjs` 和大部分 `docs/`。项目不是 Git 仓库，无法查历史/diff；未运行 `pnpm audit`。

处理原则：先修安全/可运维性高收益项；对需要产品决策或会改变发布语义的项，明确保留，不把“改绿”写成“已解决”。

## 已修复

### 1. 未预期错误日志与数据库错误映射

- `Application.respond` 现在只把真正未预期的异常记为 503，并输出方法、路径和错误对象；`HttpError`、`NotFound`、`Conflict`、Zod/引用错误不刷日志。
- PG `23503`（外键）和 `22P02`（非法文本表示）映射为 400，返回明确的“关联对象不存在或已被删除”/参数错误；`23505` 仍映射 409。
- 测试：P1/P3 全量通过，新增缓存/限流/生命周期测试未依赖日志文本。

### 2. 登录限流锁号与代理令牌

- 运营者登录计数从“仅邮箱”改为“邮箱 + 客户端来源”；一个 IP 连续失败不会锁住其他 IP 的正常登录。
- 访客登录/注册/重置/重发的邮箱桶同样改为“邮箱 + 来源”，全站来源桶保留。
- `PROXY_TRUST_TOKEN` 在生产环境缺失时启动失败；开发环境打印明确警告。`AUTH_REQUIRE_EMAIL` 生产默认 true，缺少 SMTP 时启动失败。
- 测试：新增 `operator login lockout is scoped to email and source`（P1 87/87 中的一项）。

### 3. 运营者生命周期

新增服务与管理员接口：

- `POST /admin/api/operators/password`：重置密码并撤销该成员全部运营会话。
- `POST /admin/api/operators/enable` / `disable`：启停成员；不能停用自己或最后一个站群管理员；停用即撤销会话。
- `POST /admin/api/operators/revoke-sessions`：撤销成员全部运营会话。
- 后台“成员与权限”页增加账号安全面板；保留原 `#disable` 兼容选择器。
- 审计事件：`operator.password`、`operator.enable`、`operator.session.revoke`。
- 测试：`operator account lifecycle resets credentials and revokes sessions` 覆盖改密、旧会话失效、停用/启用、撤销会话和自我保护。

### 4. 默认邮箱验证

- `AUTH_REQUIRE_EMAIL` 在 `NODE_ENV=production` 默认 true；未配置 SMTP 时启动失败。
- `compose.yaml` 默认 true；`.env.example` 改为 true 并注明生产需要 SMTP。
- `pnpm init:env` 生成**本地演示** `.env` 时显式写 false（没有 SMTP 接收器），避免本地 demo 启动失败；生产必须改 true。
- 公开上线前仍应配置 SMTP 并把 `AUTH_REQUIRE_EMAIL` 保持 true。

### 5. outbox / config_delivery

`config_delivery` 不再完全没人读：管理员任务接口返回 `delivery`（site_id、revision），任务页展示“已投递修订”。

保留边界：它仍是本地 durable projection，不是缓存失效/推送消费者。若不需要该投影，应另开任务删除 outbox/config_delivery；本轮没有直接删除，避免破坏迁移和重试状态机。

### 6. 备份不再绑定源码全文

- `applicationIdentity()` 只保留包名、版本和迁移文件名/checksum；移除全源码摘要。
- restore 只比较 migrations checksum；源码注释变化不再阻止灾难恢复。
- 仍校验备份密钥指纹、格式、nonce、tag 和迁移兼容性。

### 7. 公开页面/静态资源缓存与 robots

- 公开首页、语言/目录页、sitemap、robots.txt 返回 `cache-control: public, max-age=60, must-revalidate` 和 ETag；命中 `If-None-Match` 返回 304。
- `/assets/*` 返回 `public, max-age=3600`；资产内容在内存缓存，避免每次请求 `readFile`。
- 登录、账号、管理 API、会话等仍 `no-store`。
- 新增 `/robots.txt`，声明 `Sitemap: <origin>/sitemap.xml`。
- 测试：`P1 public pages and assets are cacheable...` 覆盖 ETag、304、robots 和登录页 no-store。

### 8. 小型修复

- 删除 http.ts 未使用的 `directoryPage`/`detailPage`/`missingPage` 导入。
- `Providers.get` 单条配置损坏时记录固定错误并跳过该条，不再让整个站点登录选项 503。
- `reviewGithub` 在资源还没有 url 且只选 `project` 时给出明确 400，而不是泛化“配置格式或参数不正确”。
- P0 生产入口的 `P0_NEXT_TEST` 分支已删除；`p0/tests/next.test.ts` 与 `test:p0:next` 脚本移除，运行时镜像删除 `/app/p0`。生产 Next 路由仍由 P1 的 `production Next route` 测试覆盖。
- OAuth advisory lock 连接池从 2 提到 8，减少并发回调排队；仍保留连接超时和查询超时。

## 两项后续项已补齐

### 9. GitHub 统计字段自动更新，不再刷审核队列

- `last_hash` 改为**内容哈希**：`stars`、`forks`、`openIssues`、`pushedAt` 归零/置空后计算；URL、标题、描述、语言、许可、topics、archived、repoId/fullName 变化仍生成候选。
- 纯统计变化时，`Content.applySourceStats` 在同步事务内：
  - 更新 `resource.data.project` 统计并递增 resource version；
  - 同步 pending candidate 的 `base_version` 和 `data.project`，避免后续审核基线过期；
  - 更新已发布 `publication.project`（统计是发布冻结的明确例外）；
  - 写 `github.stats` 审计事件。
- 任务结果新增 `stats_updated`；内容变化仍返回 `candidate_created`。
- P4 回归 28/28；测试覆盖“统计自动更新、内容仍审核、并发基线前移”。

### 10. `/api/session` 收敛为 `{email, role}`

- 公开响应不再包含 `user_id`、`center_session`、`space_id`。
- P1/P3 的跨站/独立身份断言改为直接查 `identity_session` 的 canonical id，不再依赖公开接口字段。
- P3 页面 mock 的 session 响应同步改为 `{email, role}`。
- P1 87/87、P3 36/36 通过；登录/账号/目录 UI 不依赖被移除字段。

## 验证

```text
pnpm check                通过
pnpm build                通过
P0 48/48
P1 87/87
P2 134/134
P3 36/36
P4 28/28
P5 11/11
pnpm test:release         69/69
pnpm test:docker          Docker 整体验收通过
pnpm release:check        通过
pnpm release:check:image  通过（六组带保留签署）
preflight                 0 硬失败
```

日志在 `.local/acceptance-20261021-review/`。P0 Next 测试入口移除后，P0 默认套件仍为 48 项；生产 Next 动态 Host 覆盖在 P1。
