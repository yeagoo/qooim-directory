# P5 备份、恢复和发行操作

许可证已由维护者选择为 AGPL-3.0，本仓库按 `AGPL-3.0-only` 声明，完整文本见 [LICENSE](../LICENSE)。正式品牌为 Qoo.IM Directory；技术包名和镜像名仍保留 navigation-network。`private: true` 防止意外发布 npm 包，不取消源码许可证。

## 加密备份

备份依赖 Node 24 和可访问目标 PostgreSQL 容器的 Docker CLI；源码归档另需 tar；通知核对需要按锁文件完整安装开发与运行依赖。使用容器内与服务端一致的 `pg_dump`；默认 `docker`，需要非交互 sudo 时设置 `NAV_DOCKER_SUDO=true`。工具不读取旧站文件，不连接外部服务。

认证密钥 `AUTH_ENCRYPTION_KEY` 和备份密钥 `BACKUP_ENCRYPTION_KEY` 均为 32 字节十六进制，必须不同。备份密钥单独存入受控密码库，不随应用 `.env`、归档或仓库分发。可以先在受保护的本地工作目录创建它，再移交密码库：

```bash
mkdir -p .local
node -e 'require("node:fs").writeFileSync(".local/backup.env", "BACKUP_ENCRYPTION_KEY=" + require("node:crypto").randomBytes(32).toString("hex") + "\n", {flag:"wx",mode:0o600})' 
```

以上示例只创建新文件，已有文件会拒绝覆盖；不要丢失旧备份对应的密钥。工具不会生成、轮换或覆盖密钥。应用认证密钥、SMTP/GitHub 外部凭据、代理配置及 TLS 私钥也须通过独立受控渠道保存。

在与部署完全匹配的源码目录执行（替换容器名和新备份目录）：

```bash
node --env-file=.env --env-file=.local/backup.env scripts/backup.mjs create navigation-network-db-1 network network .local/backup-2026-10-18
```

目录必须不存在，权限 0700，包含权限 0600 的 `database.enc` 和 `manifest.json`。数据库自定义归档流式 AES-256-GCM 加密，清单作为认证附加数据，记录时间、源码摘要、版本、迁移校验和、PostgreSQL 版本、认证密钥指纹；不保存密钥。创建前实际验证库中认证实例密文可被传入密钥解开，迁移记录在备份前后核对。密文关闭前 flush；清单最后写入并 flush，再同步输出目录及父目录，全部成功才返回。目录同步依赖 Linux/POSIX 文件系统支持；同步失败按备份失败处理，不降级为成功。没有完整清单或密文认证失败的目录不能恢复。备份失败只删除本次独占创建的输出目录，已有目录不改动。文件同步不能替代异地副本、恢复演练或存储设备的持久性保证。

备份可与业务写入并行，但不得与升级迁移并行。这里采用 PostgreSQL 单库逻辑备份，不包含集群角色、tablespace 或连续 WAL 归档。需要持续恢复或更小 RPO 的部署，应另行配置 PostgreSQL 的物理备份/WAL；本工具不声称实现 PITR。[PostgreSQL pg_dump 文档](https://www.postgresql.org/docs/18/app-pgdump.html)。

目前没有用户上传媒体存储，模板、静态资产和部署脚本随源码/镜像保存。若自行增加对象存储或媒体卷，须把其一致性与恢复验证加入自己的备份流程。演示 Caddy CA 卷不是数据库备份的一部分；丢失后重新生成的 CA 需要重新信任。正式 TLS 证书按部署者的证书系统管理。

## 隔离恢复

先取得备份创建时的源码归档、相同依赖与 PostgreSQL 主版本、原认证密钥和备份密钥。源码摘要包含操作文档、测试、构建脚本和迁移，因此修改文件后需切回对应归档；不能只比对包版本号。恢复前确保临时磁盘空间足够，使用受控主机/加密临时盘。解密暂存目录权限 0700、文件 0600，正常成功和错误都会删除；操作系统强制杀进程/断电后仍需检查临时目录。

```bash
node --env-file=.env --env-file=.local/backup.env scripts/backup.mjs restore isolated-db network_restore network .local/backup-2026-10-18
```

目标 PostgreSQL 容器须事先创建好角色和连接权限（包括连接维护库 `postgres`）；`network_restore` 必须不存在。工具先完整认证密文，再读取目标服务端版本，强制与备份记录的 PostgreSQL 主版本一致；不匹配时尚未创建数据库。本工具不提供跨主版本升级恢复。检查通过后运行 `createdb --template=template0`；已有数据库（即使为空）直接拒绝，不提供 `--clean` 或覆盖开关。使用 `pg_restore --single-transaction --exit-on-error --no-owner --no-privileges`，失败则事务回滚，保留新建的空库供检查，不删除任何库。只恢复自己信任来源的归档；数据库归档可能含源库定义的可执行函数。[PostgreSQL pg_restore 文档](https://www.postgresql.org/docs/18/app-pgrestore.html)。

恢复后先在隔离应用中使用原 origin/密钥检查后台登录、公众旧会话和新登录、收藏、主档、站点发布、配置及待消费任务。若需要连接新数据库，Compose 的 `APP_DATABASE=network_restore` 只选择应用数据库；初始 PostgreSQL 数据库仍为 network。切换前停止旧 web/worker 写入，保留旧卷，完成校验后再启动新服务；数据库和源站访问权限、TLS、DNS 切换由部署者执行。本轮没有切换生产或恢复旧站。

备份调度和异地复制由部署者设置。例如每日备份的理论 RPO 取决于最后一次成功且可恢复的备份，不能据此承诺 24 小时；故障和复制失败会扩大损失窗口。本地恢复时间见 [P5 验收记录](P5-FINAL.md)，不等于生产故障发现、取回归档、DNS/TLS 切换的端到端 RTO。

## 升级

1. 保存当前完整源码/镜像、认证密钥引用和加密备份，在隔离目标演练恢复。
2. 检查发行说明、依赖和新增迁移；禁止修改已应用的迁移 SQL。
3. 停止旧 web/worker，使用新镜像运行 init。失败迁移事务回滚；解决问题后重试。不要启动旧镜像写入已升级 Schema。
4. 启动新 web/worker，检查健康、后台/公众登录、内容、任务和配置传播。
5. 若需退回旧版，用匹配旧版的备份恢复到新库并校验，再切换；不支持自动向下迁移。

## 源码归档与公开检查

```bash
pnpm source:bundle
pnpm source:export .local/release-review
pnpm release:check
```

`source:bundle` 生成 `.local/source.tar.gz`，`pnpm build` 会先执行它。服务端在有效站点和后台的 `/source.tar.gz` 提供这个固定文件，并在内置页面及模板出口追加获取链接；未知 Host 仍为 404。下载按消费需求每次读取最多 64 KiB，提供 Content-Length，取消或请求中断时关闭文件；原子替换归档后，已开始的请求仍读取其打开的原版本。传输中途发生磁盘错误时终止响应，无法再改为 JSON 错误码，客户端须重新完整下载。自己修改模板或核心后应重新构建对应源码归档。开发模式如缺少归档，下载返回 503，先运行 `source:bundle`。

归档使用明确根目录和顶层文件清单，拒绝符号链接，排除内部背景、规划日志、`.local`、环境凭据、构建缓存、node_modules 和 Git 历史；扫描内部绝对路径、私钥标记、提供方 Token 和字面认证密钥。归档包含完整源码、迁移、测试、构建/部署脚本、锁文件、许可证、SHA-256 文件清单及安装树依赖通知。它是可供人工审查的候选，不是自动推送、建仓或发布动作。扫描只识别明确模式，不能替代人工检查品牌、数据与完整 Git 历史。

[后续 Review](RELEASE-REVIEW.md) 已为 4 个包补齐固定来源许可文本。源码许可缺口已由维护者按 MIT 归属决定关闭，`release:check` 通过；两个 `sharp-libvips` 平台包已随 `sharp` 移除。六组镜像已由 QooIM 带保留签署，镜像门禁通过；`next-swc` 的逐 crate 通知风险已记录。`release:check` 会阻止缺少许可文本的依赖清单通过公开发行门槛；这不阻止本地开发构建。镜像还包含基础系统及原生库，分发镜像前须单独完成其通知、对应源码等核查。模板 AI 生成代码仍须人工审查。[GNU AGPL 原文](https://www.gnu.org/licenses/agpl-3.0.html)。

## 容量重现

```bash
pnpm build
pnpm test:capacity
```

测试自行创建、标记并清理独占 PostgreSQL 容器和测试 hosts，不接受已有库；加载 30 独立站、10 万资源、30 万发布记录及版本记录，使用中英两种当前支持的语言。运行 Next 生产构建、独立 Worker 和 20 个 Chromium 上下文，覆盖首次应用读取、热列表、搜索、详情、公众密码登录、配置发布和事件消费并行。结果写入 `.local/p5-capacity.json`，包含分位数、错误、SQL 调用和内存。配置发布指标为后台共用服务调用，不包含后台浏览器点击时间。

默认基线门槛：读请求 p95 ≤ 3000ms、公众密码登录 p95 ≤ 5000ms、配置服务发布 p95 ≤ 2000ms，零 HTTP/浏览器错误；这是本次可重复开发基线，不是 SLA。应用首次读取不清除 PostgreSQL/操作系统缓存。数据库限制 4 CPU / 6 GiB，Next、Worker 与浏览器在共享宿主机运行，仅堆上限受控；不能将结果表述为整套系统在 4 vCPU / 8 GiB 的容量证明。长时间稳定性、完整宿主机资源配额、第三语言和外部 OAuth 提供方性能均未据本测试证明。

## 镜像盘点与发行范围

`pnpm release:check` 检查源码候选包级通知，`pnpm release:check:image` 额外检查当前平台及固定构建输入对应的六组镜像审查状态；当前六组均为带保留签署。两者均不替代品牌和真实外部登录验收。

使用 `pnpm release:inventory LOCAL_APPLICATION_IMAGE .local/NEW-inventory.json` 盘点本地已构建镜像；输出文件须不存在。工具只执行隔离只读探针，不启动应用或连接数据库，输出为本地采集证据。实际范围、限制和未解决项见 [镜像分发Review](DISTRIBUTION-REVIEW.md)。

原生源材料维护可使用Python标准库采集器，应用运行及Docker构建不需要Python。原始通知不会因采集成功自动放行；实际源码导出会校验工作目录和副本中的证据摘要。命令、大小限制、失败记录与剩余审查见 [原始通知与导出Review](COMPONENT-NOTICES-REVIEW.md)。

librsvg 原始 Cargo 输入和完整锁定包清单也纳入实际导出校验；Python 3.11+ 的离线维护命令及“锁定记录不等于编译图”的边界见 [Rust 锁文件 Review](RUST-LOCK-REVIEW.md)。

按原始锁文件 checksum 采集 crate、从保留归档离线复检，以及未找到独立通知的告警处理见 [crate 原始材料 Review](CRATE-NOTICES-REVIEW.md)。导出也会检查这批原始材料，采集成功不改变发行审查状态。

缺独立通知包的 README／源码前缀，以及原始锁与配方执行后锁文件的范围规则见 [缺通知 crate Review](CRATE-FOLLOWUP-REVIEW.md)。前缀不能当作完整成员，补充材料不会消除缺独立通知的告警。

使用已有 Rust 工具链离线解析候选包集合的命令与隔离要求见 [Rust 离线范围 Review](RUST-RESOLUTION-REVIEW.md)。该步骤不编译、不执行第三方构建脚本，结果也不能作为历史二进制链接证明。

优先 crate 的固定提交逐文件匹配、许可材料取得及离线缓存复检见 [优先 crate 来源 Review](PRIORITY-CRATES-REVIEW.md)。源码导出已校验这些材料；缓存复检不替代发布者认证或许可义务审查。

原始配方补丁的导出约束及 GLib 的 gvdb 嵌套来源缺口见 [原生补丁 Review](NATIVE-PATCH-REVIEW.md)。补丁快照不证明历史二进制匹配，28 顶层归档也不等于完整嵌套源码集合。

gvdb 固定提交源码与通知的离线采集、输入快照约束及嵌套来源导出校验见 [gvdb 来源 Review](GVDB-SOURCE-REVIEW.md)。这项补齐不代表完整原生包的历史构建或对应源码交付已经验证。

PR 补丁和 main 通知的当前快照、固定提交关联、Git blob 核对及历史未知范围见 [可变输入 Review](MUTABLE-INPUTS-REVIEW.md)。离线导出校验这些材料，但当前内容相同不能用来推定历史下载相同。

保留的原生/crate/gvdb 原归档可以生成独立离线材料包，命令及未完成的完整交付边界见 [源码交付 Review](SOURCE-DELIVERY-REVIEW.md)。该本地材料包未自动进入应用的公开源码下载。

固定打包工作树的离线采集、Git 对象验证和材料包新增必需参数 `--packaging-archive` 见 [打包工作树 Review](PACKAGING-SOURCE-REVIEW.md)。已保留工作树，不代表历史基础镜像、工具链或 sysroot 已恢复。

原生构建环境声明及历史 CI 任务元数据可离线采集核对，命令与未来固定基线所需材料见 [环境 Review](NATIVE-ENVIRONMENT-REVIEW.md)。runner 标签、成功状态和显式版本声明均不自动成为历史容器版本证明。
