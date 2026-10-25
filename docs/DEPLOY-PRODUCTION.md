# 生产部署

M20 起提供。本文说明如何在一台自己的服务器上用 Docker Compose 运行 Qoo.IM Directory，并由主机上的 Caddy 终结 HTTPS。演示环境（`compose.demo.yaml`）只用于本机，不要用于生产。

## 1. 准备

- Linux 主机，Docker Compose v2，Node 24（只有备份和源码工具需要）。
- 域名：后台一个（例如 `admin.example.com`），每个站点一个。DNS 指向这台主机。
- 在部署目录运行 `pnpm init:env` 生成 `.env`，然后检查以下变量：

| 变量 | 说明 |
| --- | --- |
| `ADMIN_ORIGIN` | 后台地址，必须是 `https://` |
| `AUTH_ENCRYPTION_KEY` | 32 字节十六进制。丢失后无法解开已保存的密钥和登录配置 |
| `AUTH_ENCRYPTION_KEY_PREVIOUS` | 仅在轮换密钥期间填写旧密钥，见第 6 节 |
| `PROXY_TRUST_TOKEN` | 32–128 个字符。生产环境必填，必须和 Caddy 注入的值一致 |
| `SMTP_*`、`MAIL_FROM` | 发验证和重置邮件。生产默认要求邮箱验证 |
| `OIDC_ALLOW_PRIVATE_NETWORK` | 默认 `false`。只有身份提供方在内网时才设为 `true` |
| `RETENTION_*` | 保留期，见第 5 节 |
| `REQUEST_LOG` | 默认输出请求日志，设为 `off` 关闭 |
| `MEDIA_HOST_PATH` | 媒体目录，UID 1000 可写 |

`BACKUP_ENCRYPTION_KEY` 不放在 `.env` 里，见第 4 节。

## 2. 反向代理

示例配置在 [`deploy/Caddyfile.production`](../deploy/Caddyfile.production)。

- **头部处理**：
  - 删除客户端自带的 `X-Network-Proxy-Key`、`X-Network-Client-IP`；
  - 注入 `PROXY_TRUST_TOKEN` 和真实客户端 IP（`{client_ip}`）。应用只在令牌一致时才信任这个 IP，所以限流按访客区分，而不是所有人共用一个桶。
  - 设置 `X-Forwarded-Proto https`，应用据此返回 HSTS。
- **CDN**：如果前面还有 CDN，把 CDN 的地址段写进 `trusted_proxies`，否则 `{client_ip}` 会是 CDN 的地址。
- **限流**：应用自己对公开搜索、目录、sitemap 和徽章按访客、按站点限流，每分钟分别为 120、240、60、600 次，超出返回 429。需要更严格的边缘限流时，可以给 Caddy 编译 `caddy-ratelimit` 模块，示例在配置末尾。
- **端口**：Web 容器只监听 `127.0.0.1:3000`，不要直接对外开放。

启动：

```bash
docker compose up -d --build
sudo caddy reload --config /etc/caddy/Caddyfile
```

新增站点后，把它的域名加进 Caddyfile 再重新加载。

## 3. 健康检查与日志

- `GET https://<后台域名>/health` 返回 `{status, db, migrations, workerHeartbeat, mediaWritable}`。
  - 返回 503：数据库不可用、迁移数量不一致，或媒体目录不可写。
  - `status: "degraded"`：worker 超过 5 分钟没有心跳。Web 仍能服务，但发布事件、邮件、AI、采集和定时发布会停下。
  - 适合接到外部可用性监控。
- **请求日志**：Web 进程对每个请求输出一行 JSON，字段为 `time, requestId, method, path, status, duration, site`，不含查询参数。
  - 用 `docker compose logs web` 查看，或交给日志系统收集。
  - 响应头 `x-request-id` 与日志对应。用户反馈问题时，请他提供这个值。
- **worker 健康**：worker 容器有自己的健康检查（`scripts/worker-health.ts`）。

## 4. 备份

- 备份工具和恢复步骤见 [P5 运维](P5-OPERATIONS.md)。
- `BACKUP_ENCRYPTION_KEY` 必须和 `AUTH_ENCRYPTION_KEY` 不同，单独保存在密码库里。
- 定时备份示例见 [`deploy/backup-cron.example`](../deploy/backup-cron.example)：每晚生成一个带日期的新目录。生成后要复制到异地，并定期做恢复演练。
- 正在轮换加密密钥时（第 6 节），先完成 `re-seal` 再备份。备份前会检查数据库里的密文能否用当前密钥解开。

命令行工具通过 `init` 服务运行，它带有运营者凭据，例如 `docker compose run --rm init pnpm cli retention-run`。下文写作 `cli <命令>`。

## 5. 数据保留

Worker 每小时清理一次，也可以用 `cli retention-run` 立即执行。

| 数据 | 默认 | 变量 |
| --- | --- | --- |
| AI 任务 | 180 天（至少 35 天） | `RETENTION_AI_DAYS` |
| 采集任务、候选 | 30 / 30 / 90 天 | `RETENTION_COLLECTOR_*` |
| 内容和配置的幂等记录 | 90 天（至少 7 天） | `RETENTION_OPERATION_DAYS` |
| 已投递的发布事件 | 30 天 | `RETENTION_OUTBOX_DAYS` |
| 审计日志 | 永久保留 | `RETENTION_AUDIT_DAYS`（至少 365，默认不清理） |

- **开启审计清理前先导出**：`docker compose run --rm -T init pnpm -s cli audit-export 2025-01-01 > audit-2024.jsonl`。导出 JSON lines，每行一条 2025-01-01 之前的事件。
- **回收媒体**：下架的内容仍然引用它的图片，以便重新发布时还能显示，所以这些图片不能删除。在媒体库里对图片点"解除下架引用"后，它就可以删除了，配额随之回收。线上内容不受影响；解除后，那些下架内容再发布时就不再带这张图片。审计记为 `media.release`。

## 6. 加密密钥轮换演练

`AUTH_ENCRYPTION_KEY` 加密了这些内容：
- 账号实例密钥；
- 登录提供方配置；
- AI 服务商密钥；
- 邮件队列。

M20 起，密文带有密钥标识（`v1.<key id>.…`）；更早的密文没有标识，仍然可以读取。

1. 生成新密钥：`node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`。
2. 在 `.env` 中把旧密钥移到 `AUTH_ENCRYPTION_KEY_PREVIOUS`，新密钥写入 `AUTH_ENCRYPTION_KEY`，然后重启：`docker compose up -d`。这时新写入的密文用新密钥，旧密文仍然能读。
3. 运行 `docker compose run --rm init pnpm cli re-seal`。它逐行用新密钥重写，可以重复运行，已经是新密钥的行会跳过。确认输出中每张表的 `failed` 都是 0。
4. 从 `AUTH_ENCRYPTION_KEY_PREVIOUS` 删除旧密钥，再重启。
5. 做一次备份并验证：备份前的密文检查会用新密钥。

先在恢复出来的副本上演练一遍，再在生产上执行。

## 7. 访客账号

在站点配置页的“访客账号”里可以：
- 按邮箱搜索；
- **封禁**：立即结束该账号所有会话；
- **匿名化**：清除邮箱、昵称、头像和登录方式，并封禁账号。收藏和投稿保留，但不再关联个人信息。不可撤销。

共享账号空间（legacy）的账号同时属于多个站点，只有全局管理员能操作。

对应命令行：
- `cli visitor-list SITE [关键词]`
- `cli visitor-ban SITE USER_ID [true|false]`
- `cli visitor-anonymize SITE USER_ID`

审计记为 `visitor.ban`、`visitor.unban`、`visitor.anonymize`。

## 8. 升级

1. 先备份。
2. 拉取新版本并构建镜像。
3. 运行 `docker compose up -d`：`init` 会先执行迁移，再启动 Web 和 worker。

迁移在一个事务里执行；大库上建索引的迁移会锁表一段时间，请安排在维护窗口。
