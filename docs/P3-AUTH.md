# P3 认证操作

独立站有独立身份空间；共享站只向所选账号中心授权。GitHub、Google 和通用 OIDC 配置在独立账号中心，依赖站继续走既有 `network` 授权流程。后台运营账号与读者账号仍分开管理。

## 外部登录

只有全局运营管理员可通过 CLI 配置提供方。应用 ID、密钥等由部署者写入本地 JSON，建议权限 0600，保存在 `.local/` 或受控挂载目录。不要提交凭据文件。命令只返回 ID/启用状态；数据库加密保存配置，普通站点导出和公开接口不含密钥。

```bash
pnpm cli auth-provider-set atlas .local/github.json
pnpm cli auth-provider-set atlas .local/google.json
pnpm cli auth-provider-set atlas .local/oidc.json
```

命令需要与现有 CLI 相同的数据库、加密密钥及运营凭据环境；容器中可用 `docker compose exec -T web pnpm cli ...`，文件须事先受控挂载，运营凭据不能暴露给公开接口。

写入前可先核对配置和固定回调地址，不落库、不返回 secret：

```bash
pnpm cli auth-provider-check atlas .local/github.json
pnpm cli auth-provider-list atlas
```

`auth-provider-check` 输出 `callbackUrl`（如 `https://atlas.localhost:8443/api/auth/callback/github`）和该提供方当前是否已配置/启用；`auth-provider-list` 只列出 id、kind、label、enabled 与回调地址，不含 clientId/clientSecret。后台站点详情页也会显示同样的只读状态和回调地址；共享站显示其账号中心入口。

```json
{"id":"github","kind":"github","label":"GitHub","clientId":"REPLACE_WITH_APP_ID","clientSecret":"REPLACE_WITH_APP_SECRET","enabled":true}
```

Google 使用 `id: "google"`、`kind: "google"`。通用 OIDC 使用独立 ID：

```json
{"id":"oidc-company","kind":"oidc","label":"公司账号","clientId":"REPLACE_WITH_APP_ID","clientSecret":"REPLACE_WITH_APP_SECRET","issuer":"https://identity.example.com","enabled":true}
```

issuer 必须为固定 HTTPS URL，无用户信息、查询串或 fragment；保留原始 issuer 精确验证，构造发现 URL 时去掉末尾斜线再追加 `/.well-known/openid-configuration`，遵循 [OIDC Discovery §4.1](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderConfig)。`authentication` 可选 `post`（默认，client_secret_post）或 `basic`（client_secret_basic），按提供方注册配置选择。该提供方须支持授权码、PKCE、ID token/JWKS 验证、userinfo，并提供一致的 sub 和已验证邮箱。此入口不支持纯 OAuth2 但不提供 OIDC 身份声明的任意平台。

注册回调使用**账号中心**固定 origin：

| 提供方 | 回调 |
| --- | --- |
| GitHub | `https://center.example.com/api/auth/callback/github` |
| Google | `https://center.example.com/api/auth/callback/google` |
| 通用 OIDC | `https://center.example.com/api/auth/callback/oidc-company` |

前端统一 POST `/api/auth/sign-in/social`；通用提供方也使用此路由，这是锁定 Better Auth 1.7.10 源码核对并经测试的接口。不要使用旧版本示例的 `/sign-in/oauth2`。

在平台控制台配置应用和回调后，用真实账号检查首次登录、再次登录、用户拒绝、中心返回共享站、同邮箱冲突和退出。GitHub/Google 的真实账号联调尚待应用凭据；本地 HTTPS OIDC 提供方通过测试不代表真实平台验收。配置说明依据 [GitHub 授权文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) 和 [Google OIDC 文档](https://developers.google.com/identity/openid-connect/openid-connect)，回调以本项目锁定适配实现为准。

账号页开始手动操作后，当前页面的自动续接不再使用迟到跳转或错误；在途手动请求不会重复提交，结束后可以重试。没有手动操作时仍可正常自动续接，服务端认证校验不变。控序与失败路径见[账号页面流程 Review](ACCOUNT-FLOW-REVIEW.md)。

账号页对异常响应保留 HTTP 状态与输入；找回、重置、重发验证须确认 status:true，登录/注册须具备必要结果字段，外部登录须具备跳转地址。未确认结果提示先核对邮件或登录状态，不自动重放；重置 token 仅在明确成功后移除。详见 [账号响应确认 Review](ACCOUNT-RESPONSE-REVIEW.md)。

相同 ID 重新配置会增加提供方修订，其他进程下次读取实例即使用新配置，不要求重启。`enabled:false` 阻止新的该提供方登录；它不等同于撤销已有会话。自动邮箱绑定关闭：已有密码账号与外部账号同邮箱时不会自动关联；用户可在账号中心显式绑定。不要直接编辑认证库账号表绕过验证。

## 邮件

设置 `.env` 后重建 web/worker 的容器环境：

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=REPLACE_WITH_SMTP_USER
SMTP_PASSWORD=REPLACE_WITH_SMTP_PASSWORD
MAIL_FROM=accounts@example.com
AUTH_REQUIRE_EMAIL=true
AUTH_HISTORY_DAYS=30
```

`SMTP_SECURE=false` 默认仍要求 STARTTLS；465 等隐式 TLS 服务使用 `SMTP_SECURE=true`。未配置 SMTP 时隐藏重置/重发入口，对相关 API 返回 404；要求邮箱验证却没有 SMTP 时启动失败。默认 `AUTH_REQUIRE_EMAIL=false` 便于既有演示；生产启用验证必须显式设置 true。SMTP 配好但验证非强制时，仍发送验证邮件，不阻止未验证邮箱登录。

`SMTP_ALLOW_INSECURE=true` 只允许显式本地开发接收器（127.0.0.1、localhost、::1、mailpit），不可用于真实远程邮件服务。自动化 Docker 验收只在独占内部网络启动测试接收器，不连接外部邮箱。

验证/重置链接有效期一小时；邮件正文包含敏感 token，加密持久化，发送成功、到期或最终失败后清除正文。Worker 使用租约认领、5 次封顶重试，失败延后 30 秒；过期租约可接管。SMTP 是至少一次投递，发送成功后进程崩溃可能导致重复邮件，稳定 Message-ID 不能保证收件端去重。

后台任务页显示状态数量，不展示邮箱、token 或原始 SMTP 错误。最终失败/过期邮件不能恢复正文，用户应重新申请；修复 SMTP 后尚有效的待重试邮件由 Worker 自动继续。投递成功不代表已进入外部收件箱。密码重置 token 单次使用，成功后撤销同一账号空间该用户的所有产品会话，包括共享依赖站；验证邮件不自动登录。

## 账号绑定与解绑

登录后访问账号中心的 `/account`。共享站会把该路径 303 到所属账号中心的 `/account`；未登录时先跳登录，返回路径仅允许站内路径。

- 页面列出当前登录方式：邮箱密码和已绑定的第三方提供方。
- “绑定”只列出当前站点已配置且尚未绑定的提供方；跳转到提供方授权，回调固定回 `/account`。
- 绑定是**显式操作**：`accountLinking.enabled=true` 但 `disableImplicitLinking=true`，同邮箱的第三方登录不会在普通登录时自动合并账号。
- 绑定仍要求本地邮箱已验证，且提供方返回的已验证邮箱与本地账号一致；不同邮箱不会合并。
- 解绑使用 Better Auth 的 `unlink-account`，需要新鲜会话；最后一个登录方式会被服务端拒绝，页面会显示错误。密码方式不提供解绑按钮。
- 提供方被禁用或删除后，已有绑定记录保留；该提供方不能再发起新登录或新绑定，用户仍可在账号中心解除旧绑定。
- 解绑不会删除用户、收藏、投稿或站点数据；不会撤销其他设备的现有会话。

CLI/后台配置提供方后，先在账号中心验证绑定、重复绑定、不同邮箱、解绑最后方式和禁用提供方后的表现。真实 GitHub/Google 的绑定验收仍需上线前用真实凭据完成；受控 OIDC 的端到端绑定/解绑已在 P3 测试覆盖。

## 代理与会话

`PROXY_TRUST_TOKEN` 为至少 32 字符随机值，演示初始化自动生成。反向代理必须覆盖客户端传来的 `X-Network-Proxy-Key`、`X-Network-Client-IP`，再分别填入私有令牌和可信客户端 IP。演示 Caddy 已配置。认证库不信任普通 Forwarded/X-Forwarded-* 来改变固定 origin，Cookie 为 Secure、HttpOnly、Host-only，跨站登录使用顶层跳转。

`/api/session` 只返回当前会话的 `{email, role}`；内部 `user_id`、`center_session`、`space_id` 不再暴露给浏览器。需要区分同邮箱的不同身份空间时，服务端查询 `identity_session`。

未建立可信代理链时，来源桶为 `untrusted`，同站用户共享 IP 限额；部署者需正确配置代理，不能直接信任互联网请求里的 IP 字段。有上游 CDN 时只在明确的可信代理范围取原始客户端 IP，不把任意头转发进私有字段。

认证入口持久限额：每站每来源 300 次/5 分钟；邮箱登录、注册、找回、重发另有每站每邮箱 10 次/5 分钟；后台登录另有来源桶及既有邮箱限额。多进程和重启共享 PostgreSQL 状态。邮件发送由异步队列完成，避免在登录请求里等待 SMTP。

读者会话滑动有效期 7 天，超过一天通过本站 `/api/auth/get-session` 续期并更新 Cookie；内部鉴权查询不偷偷续期。单次登录绝对上限 30 天；以本地认证库、规范会话及共享中心关联中较短期限为准。到期、撤销或缺失桥接不能被刷新恢复，认证入口会清理残留库会话再继续协议处理。

共用身份服务的授权与组退出来源也要求普通期限、绝对期限同时有效，绝对到期后不能继续授权或触发同组退出。实现范围与正式/原型入口的回归见[会话绝对有效期 Review](SESSION-EXPIRY-REVIEW.md)。

`AUTH_HISTORY_DAYS` 可设 7–365，默认 30。Worker 清理超过保留期的已撤销/过期规范会话及桥接，以及已完成/失败邮件；会话按批清理，保留用户和业务数据，不清理配置、内容或业务审计历史。旧会话在 004 升级时将原 expires_at 作为绝对上限，不追溯编造原始创建时间。

密钥仍必须随数据库一起受控备份。认证库本身的访问/刷新 token 表也是敏感数据，不因提供方配置已加密就视为无敏感信息。P5 负责完整备份恢复、容量和发行核查。
