# P1 安装与操作

本页记录 P1 的安装与运行基础。P2 内容运营已交付，见 [P2 内容操作](P2-CONTENT.md)；P3 模板/认证与 P4 GitHub 模块已交付，P5 运维工具及发行边界见 [P5 操作](P5-OPERATIONS.md)。后台品牌为 Qoo.IM Directory；技术包名和镜像名仍为 navigation-network，避免破坏既有部署。新代码独立编写；包保持 private；许可证已选择 AGPL-3.0-only，正式品牌为 Qoo.IM Directory。

## 本地 HTTPS 演示

需要 Node 24、pnpm 10.11.1 和 Docker Compose。先安装依赖并生成随机凭据；生成器不会覆盖已有 `.env`，文件权限为 0600。

```bash
pnpm install --frozen-lockfile
pnpm init:env
docker compose -f compose.yaml -f compose.demo.yaml up -d --build
```

后台：`https://admin.localhost:8443/admin`。三个示例站为 `https://atlas.localhost:8443`、`https://notes.localhost:8443`、`https://library.localhost:8443`。演示数据中 Atlas 与 Notes 仍使用既有共享账号，Library 独立；**新站点只创建独立账号空间**，共享中心仅作为既有部署兼容保留。后台账号独立于公众账号，初始邮箱和密码从本机 `.env` 的 `OPERATOR_EMAIL`、`OPERATOR_PASSWORD` 读取。

代理只绑定本机回环地址。远程服务器可通过 SSH 转发本机 8443 端口访问，勿把 `.localhost` 当成公网域名。若修改演示端口，同时修改 `DEMO_TLS_PORT`、`ADMIN_ORIGIN` 和三项 `DEMO_ORIGINS`；已初始化实例的 origin 不支持直接修改，须使用另一个全新演示项目。

演示使用 Caddy 独立生成的本地 CA，浏览器须信任该演示 CA；根证书可导出：

```bash
mkdir -p .local
docker compose -f compose.yaml -f compose.demo.yaml cp proxy:/trust/root.crt .local/demo-ca.crt
```

只导入自己这次安装生成的根证书。容器中的 Node 通过 `NODE_EXTRA_CA_CERTS` 信任它，未关闭 TLS 校验；应用只挂载公共根证书，不挂载 CA 私钥。[Caddy 官方说明](https://caddyserver.com/docs/automatic-https#local-https)解释了本地 CA 与客户端信任的关系。

基础 Compose 用于外部 TLS 代理，演示叠加文件提供本地代理。生产接入须使用真实 HTTPS origin、关闭 `SEED_DEMO`、保持 `ALLOW_INSECURE_HTTP=false`，由入口代理保留正确 Host 并剥离外部转发头，限制源站入口。共享账号必须使用 HTTPS，不能通过开发 HTTP 开关绕过 Web OIDC 回调限制。

## 启动与运行约束

- `init`：等待 PostgreSQL 健康，执行版本迁移、首次管理员创建、可选示例初始化。已有管理员不重置密码。
- `web`：Next.js 生产构建，承载后台及多域名公开入口。
- `worker`：独立受管理进程，处理实例建表、发布事件和会话维护；不依赖页面请求触发任务。
- 数据库与演示证书分别存于命名卷；正常 `down` 保留卷。`down -v` 会删除该项目数据，不用于升级。
- `AUTH_ENCRYPTION_KEY` 必须持久保存并单独备份；丢失后无法解密认证实例密钥。P1 不提供在线密钥轮换。

每个 Node 进程共用一个最多 12 连接的业务池及一个最多 2 连接的认证锁池，认证实例不创建独立池。默认 web + worker 最大约 28 连接，init/CLI 执行期间增加一个进程的预算；健康检查短连接和数据库管理连接另计。认证实例缓存最多 64 个。这是资源配置，尚不是 30 站容量证明。

配置写入、内容候选保存/发布/下架与站点启停在业务事务内复核权限，并持有账号及必要的站点授权行锁。撤权先提交时排队操作拒绝；写入先取得事务内授权时，撤权等待该事务完成，随后生效。撤权不是追溯取消已提交操作，具体并发验证与范围见[事务权限 Review](history/PERMISSION-TRANSACTION-REVIEW.md)。

主档保存/应用导入、分类和投稿审核、GitHub 来源保存/人工排队/候选审核、登录提供方配置也按同一事务顺序复核。站点编辑者接受本站投稿的权限保持不变，已合法排队的后台同步不因提交者之后变更角色而追溯取消。覆盖范围及尚未审计的管理入口见[管理写入口 Review](history/MANAGEMENT-WRITES-REVIEW.md)。

`/health` 仅在后台 Host 上提供，数据库或迁移表不可用时不健康。worker 健康检查要求两分钟内有完成心跳。查看状态：

```bash
docker compose -f compose.yaml -f compose.demo.yaml ps
docker compose -f compose.yaml -f compose.demo.yaml logs --tail 100 init web worker
```

## 后台操作

1. 总览创建站点：填写独立域名、名称和稳定标识。**新站点固定使用独立账号空间**；共享账号中心不再出现在新建表单中，既有共享站点仍可编辑。通过 API 创建共享站点必须显式传 `legacyShared: true`，否则返回 400；该开关只用于兼容既有部署。DNS、TLS 和代理域名仍由部署者配置；本地演示代理仅含四个演示域名。
2. 等待账号服务就绪；失败可在“运行任务”查看阶段错误并重试。域名、账号中心和密钥不进入普通配置文件。
3. 配置页编辑名称、介绍、语言、模块和完整 JSON；导入文件先校验并显示差异。已有共享草稿需要显式勾选替换，过期版本返回冲突并保留输入。
4. 保存草稿后可通过受保护窗口预览。发布产生更高修订；恢复历史只生成新草稿，再发布才能上线。
5. 成员权限支持站群管理员、每站只读、每站编辑。撤销授权和停用账号于下次鉴权生效；管理写入在事务中复核并持有权限到提交。撤权先提交则排队写入拒绝，已获事务授权的操作先完成后再撤权。浏览器隐藏按钮不能代替服务端权限，详见[账号与任务控制 Review](history/ACCOUNT-CONTROL-REVIEW.md)。
6. 后台“审计日志”只读展示管理操作、内容发布、账号与任务事件。全局管理员可查看全部站点，站点成员只能查看已授权站点；按 id 游标向前加载，不提供导出或保留期配置。详见[后台审计日志 Review](history/AUDIT-LOG-REVIEW.md)。
6. 停用站点返回无品牌 404。停模块保留数据并立即隐藏相关公开内容。

配置页写入成功但刷新失败时保留确认，用“刷新并保留编辑”确认状态；“放弃本页编辑并载入服务器配置”才会主动替换本地内容。发布、启停和历史恢复保留未提交配置并提示；读取到新版本时旧替换勾选失效，需要重新比较确认，详见[配置编辑 Review](history/CONFIG-EDITOR-REVIEW.md)。

总览创建和列表刷新互斥。创建已确认而列表读取失败时，使用“刷新列表”恢复；只读刷新保留未提交建站输入。新建表单不再提供共享中心选项；既有共享站点仍显示 legacy 标记。

成员页操作与列表刷新互斥；提交成功但读取失败时保留确认，使用“刷新列表”恢复。权限操作和只读刷新保留未提交添加输入及权限选择，明确添加成功后清除本次邮箱和初始密码。输入只在当前视图内保留，详见[成员与权限页面 Review](history/TEAM-PAGE-REVIEW.md)。

普通配置其他进程最长在下次 5 秒 TTL 到期读取时更新；发布所在进程主动清缓存。停站、模块、公开发布状态和身份每次从数据库判断，不等待配置 TTL。所有动态响应 `no-store`，不得直接开启 CDN 全页缓存。

后台仅展示最近 50 个配置历史和最近 100 个失败发布事件；完整历史仍在数据库。失败发布事件可以重新排队，不重新生成修订。认证任务自动最多尝试五次，进程中断后用 PostgreSQL advisory lock 判断是否仍有执行者；最终中断进入失败状态后可手动重试。手动重试只接受失败状态，其他状态或不存在的目标返回409；认证准备重试与审计同事务提交。任务页仅为失败实例提供重试；提交成功但列表刷新失败时保留排队确认，使用“刷新列表”确认新状态，详见[后台任务页 Review](history/TASK-PAGE-REVIEW.md)。发布事件采用 30 秒租约、最多五次尝试和幂等消费者。

worker 顺序处理认证准备、配置投递、GitHub 同步、邮件和会话维护。某一类任务抛错后，仍尝试后续独立任务；配置投递本轮停止，按原有退避和租约机制在后续循环重试。发生异常的循环不会更新 worker 成功心跳，持续异常超过两分钟后健康检查失败；单次异常不会立即撤销上次成功心跳。正常记录的任务失败与循环异常仍有区别，需结合后台任务状态和 worker 日志排查。故障回归见[后台任务 Review](history/WORKER-REVIEW.md)。

## CLI 配置协作

CLI 与后台共用 Schema、权限、事务与审计。CLI 从 `.env` 或环境变量读取 `DATABASE_URL`、`ADMIN_ORIGIN`、`AUTH_ENCRYPTION_KEY` 和操作者凭据；不要把密码写在命令参数中。宿主机运行时 DATABASE_URL 必须指向可访问的数据库；Compose 内部数据库不默认暴露到宿主机。

```bash
pnpm --silent cli export atlas > atlas.json
pnpm --silent cli compare atlas atlas.json
pnpm --silent cli import atlas atlas.json 0
pnpm --silent cli publish atlas 0 1 00000000-0000-4000-8000-000000000001
pnpm --silent cli rollback atlas 0 1 2
pnpm --silent cli export atlas draft > atlas-draft.json
```

参数中的数字只是一个从初始状态开始的例子：`import` 最后参数是当前草稿版本，已有草稿须另加 `--replace`；`publish` 参数依次为当前线上修订、草稿版本、操作 UUID；`rollback` 参数依次为历史修订、当前线上修订、当前草稿版本。实际数字以 compare 或后台当前状态为准。同一次发布重试复用同一个 UUID，不能把一个 UUID 用于不同参数。

导出为完整 JSON：`schemaVersion: 1`、`kind`、`siteId`、`baseRevision`、`config`；草稿额外含 `sourceDraftVersion`。默认配置字段为名称、介绍、`catalogPath`、`template`、`locales`、有稳定 ID 的导航数组和模块数组。当前提供 `basic` / `editorial` 模板和 `directory` / `opensource` 模块；未知模板、模块、字段、错误站点和过期修订都会拒绝。数组整体替换，不执行三方合并。

## 迁移、升级与故障恢复

应用迁移记录在 `schema_migration`，按名称、SHA-256 校验和核对，事务和全局 advisory lock 防止并发初始化。已执行 SQL 不再改写，升级增加新迁移；失败回滚，同一命令可重试。`006-search.sql` 会创建 `pg_trgm` 扩展；数据库用户需要相应权限，托管 PostgreSQL 需确认扩展已预装/允许创建。禁止将 P0 测试数据库当成正式产品数据库；P0 的清库夹具不会在产品启动路径执行。

认证表由锁定版本 Better Auth 按实例前缀建立，持久化实例 ID、issuer、密钥和 schema 版本。升级前备份并审查认证依赖变更；使用对应镜像运行：

```bash
pnpm cli migrate
pnpm cli auth-upgrade atlas
```

`auth-upgrade` 保留实例身份与密钥，重新核对缺表和字段；执行中该站认证会暂时不可用。只验证了同一锁定版本下的重复建表与缺表恢复，不承诺任意未来认证版本能够无损降级。新镜像先通过测试，再停止旧 web/worker、运行 init 迁移，最后启动新 web/worker；不要让旧版本继续写新 Schema。数据库升级无自动向下迁移，需按备份恢复。

数据库断连时页面及受保护请求返回 503，worker 保留持久任务并重试。账号中心域名局部不可达时新共享登录失败，已有会话仍通过数据库校验。中心退出使关联站后续受保护请求失效，不自动退出其他设备。

备份应覆盖 PostgreSQL 完整库、应用版本及独立保存的加密密钥；配置 JSON 不含用户、内容、会话或密钥，不能替代备份。可使用 PostgreSQL `pg_dump -Fc` 保存数据库；恢复到隔离的新库，使用原密钥和对应版本镜像核对站点、登录与发布后再切换。P5 已增加受控加密备份、隔离恢复及容量工具，命令与实际验证范围见 [P5 操作](P5-OPERATIONS.md)。

## 验证命令

```bash
pnpm check
pnpm build
pnpm test:p0
pnpm test:p1
pnpm test:docker
pnpm audit --prod
```

P0/P1 测试还需要 OpenSSL、Python 3、Playwright 浏览器及非交互 Docker/hosts 管理权限，入口创建独占数据库并检查所有权后才清库。Docker 验收独立创建 Compose 项目、凭据、TLS 卷和随机端口，结束只清理自己创建的容器、网络、卷及临时文件，构建镜像保留作缓存。P1 应用集成使用 Chromium；Docker 浏览器流程使用 Firefox。Docker 联调中 Chromium 曾发生 ERR_NETWORK_CHANGED，未作为应用错误吞掉，也未通过无限重试隐藏。避免同时运行多个会创建/销毁网络的浏览器验收。
