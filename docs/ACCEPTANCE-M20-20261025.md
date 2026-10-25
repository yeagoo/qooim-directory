# M20 验收记录：稳定版加固

日期：2026-10-25 至 10-26，分支 `m20-hardening`（从 `main` a1c3e01 分出）。依据是 [全项目 Review](CODE-REVIEW-20261025.md)。这是本地回归记录，不是发布批准；镜像证据尚未刷新。

## 内容（按 Review 编号）

### 第一批

| 编号 | 处理 |
| --- | --- |
| B2 | `package.json` 改为 `0.2.0-rc.3`。`release:check` 在打 tag 的提交上会检查 tag 和版本号是否一致；GitHub Actions 的 tag 构建如果解析不出 tag，直接失败 |
| H4 | 迁移 021：新增 `publication(resource_id,locale)`、`content_draft(resource_id,locale)` 两个索引，以及 publication 上 image/logo 的媒体引用索引 |
| L8 | 采集器解码字符实体时，超出范围或代理区的值保持原样，不再抛错 |
| M6 | 不带协议的技术名、文件名（`Node.js`、`vite.config.json`）不再算作新链接。P3-AI 和 M18 文档注明“检查通过不等于事实正确”。目前没有按站点关闭自动发布的开关 |
| M10 | README 的状态段和命令列表、`.env.example`（RETENTION 说明、备份密钥说明）已修正 |
| M12 | 后台在 `<head>` 中同步执行 `admin-theme-init.js`，并加入 `<noscript>` 提示 |
| L1 | 新增 `Permissions-Policy`；HTTPS 下返回 HSTS（不带 includeSubDomains）；CSP 增加 `object-src 'none'` |
| L3 | 清理未使用的声明和死代码，`tsconfig` 开启 `noUnusedLocals` |
| L6 | CHANGELOG 修正标题空格，加入 Unreleased 段，并把旧的 Unreleased（M6–M11）改名，标明随 rc.2 发布 |
| L7 | 提供 `/favicon.ico` 和 `/favicon.svg` |

### 第二批

| 编号 | 处理 |
| --- | --- |
| B1 | CI：同仓库 PR 在自托管 arm64 机器上跑 P1、P2、P17、P20；推送到 main 和 tag 时跑 P0–P17 和 P20；手动触发时跑 Docker 验收和镜像检查。fork 的 PR 不会用到自托管机器 |
| M8 | P12 中的固定等待改为条件轮询，或等待两个动画帧 |
| B3 | 新增 `deploy/Caddyfile.production`、`deploy/backup-cron.example`、[生产部署](DEPLOY-PRODUCTION.md)。`/health` 返回数据库、迁移（按名称比对）、worker 心跳和媒体目录状态，见下文。请求日志为 JSON，`/api/auth/` 路径会截断以免记录令牌，响应头带 `x-request-id` |
| H1 | 进程内固定窗口限流：页面、搜索、目录接口、sitemap、徽章各一个桶，按访客和站点计数，超出返回 429。计数表满时淘汰最旧的十分之一，不会整表清空 |
| H2 | 迁移 022 给幂等记录和 outbox 加上时间戳。幂等记录保留 90 天，已投递的发布事件保留 30 天；审计日志默认永久保留，可选择开启清理；新增 `cli audit-export`。媒体库新增“解除下架引用”（`POST /media/<id>/release`），会清除下架发布行中的 image/logo 以及 overrides 里对应的引用 |
| H3 | 访客账号：后台“访客账号”页，以及 `visitor-list`、`visitor-ban`、`visitor-anonymize` 三个命令，见下文 |
| H5 | 密文格式改为 `v1.<key id>.…`，旧格式仍可解开。`AUTH_ENCRYPTION_KEY_PREVIOUS` 中的旧密钥可用于解密。`cli re-seal` 会重写数据并逐行检查，报告 `remaining` 和 `unreadable` 两个计数。备份前检查所有加密列，如果存在用其他密钥加密的密文就拒绝备份 |
| M1 | OIDC 的 discovery 和 userinfo 请求经过公网检查并固定到检查过的地址；保存 issuer 时会解析 discovery，并校验其中列出的端点。内网身份提供方需设置 `OIDC_ALLOW_PRIVATE_NETWORK=true`。IPv6 特殊地址段（NAT64、6to4、Teredo、site-local 等）现在按内网处理；出站请求的 Host 头带上端口 |
| M5 | `Limits.save` 的权限检查、存在检查、写入和审计放进同一个事务 |

`/health` 的判断规则：
- 返回 503：数据库不可用、已应用的迁移与当前版本的迁移文件对不上，或媒体目录不可写；
- 返回 `degraded`：worker 超过 5 分钟没有心跳。

访客账号的操作：
- **封禁**：撤销该账号的会话，并删除对应的本地会话；
- **匿名化**：在这个账号空间的所有认证实例里清除邮箱、昵称和头像，删除会话、登录方式、passkey 和验证记录，并封禁账号。

共享账号空间（legacy）里的账号只有全局管理员能操作，后台界面也会相应隐藏按钮。

### 附带修正

- **library 站点被停用的原因**：预览环境的审计记录有操作人，是预览用的运营者账号 owner@example.test，时间是 M19 开发截图期间（2026-10-24 17:04 UTC）。当时“停用站点”只需点一次，很可能是自动化截图时误点的。现在：
  - 停用需要在 5 秒内点第二次确认；
  - “最近活动”显示操作人，启用和停用分开显示。

## 结果

- check、build 通过；`tsc --noUnusedLocals` 没有输出。
- P0–P17、P20 全部通过，P20 共 11 项，P8 新增了“解除引用”的路由测试。并行跑时 P3、P4 因 `ERR_NETWORK_CHANGED` 偶发失败，单独重跑分别为 39/39、30/30。
- `test:docker` 通过。
- `test:release` 和 `release:check:image` 只有镜像门禁失败，原因是 `package.json` 和 `compose.yaml` 有改动，镜像证据需要重新采集并请 QooIM 确认。
- Codex 审查：一次审查整个 diff 两次都超时，于是拆成三组并行审查。共提出 19 项，处理情况：
  - 已修复：媒体解除引用的路由不可达、overrides 中的引用残留、共享账号空间的卫星实例数据没有匿名化、共享站点的按钮没有隐藏、re-seal 在比较交换未命中和遇到损坏密文时误报成功、备份只检查一张表且不比对 key id、IPv6 特殊地址段、Host 头、日志泄露令牌、Caddy 访问日志泄露令牌、限流表满时整表清空、HTML 页面不受限流、Caddy 读不到代理令牌（已写入文档）、健康检查只比迁移数量、tag 构建时版本门禁不生效、PR 不跑 P20。
  - 部分处理：OIDC 中由 Better Auth 自己发出的 token/JWKS 请求。保存时会校验 discovery 中列出的端点，但运行期如果对方改了 DNS 指向，仍拦不住，已写入部署文档并建议在网络层限制出站。
  - 不采纳：迁移 022 改名。这个文件只在本分支存在，没有进入 main，也没有被任何持久数据库执行过：预览库仍是 M18 镜像，Docker 验收每次都用空库。

## 已知限制与延后

- Better Auth 自己的出站请求不能按请求固定地址，见上文。
- 限流按进程计数；多个 Web 进程时，每个进程各算各的。
- 访客匿名化目前只有单实例场景的自动化测试。共享空间卫星实例的清理逻辑已实现并通过类型检查，但还没有端到端测试。
- 没有 ESLint/Prettier（M9）、近似计数（M4）、ETag 流式计算（M3）、迁移分批执行（M13）、Host 重复解析（M2），这些留到稳定版之后。
- 镜像证据没有刷新：本分支改了 `package.json` 和 `compose.yaml`，合并后要重新采集，并请 QooIM 确认。
