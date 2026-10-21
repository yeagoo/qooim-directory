# GitHub / Google 上线前验收手册

本文用于真实平台凭据到位后的验收。当前代码、回调构造和受控 OIDC 已测试；**真实 GitHub/Google 授权码交换与账号返回尚未执行**，不能把本文当成已通过。

## 一、准备

1. 账号中心使用正式 HTTPS 域名，例如 `https://directory.example.com`。GitHub/Google 的回调必须与下面完全一致，协议、域名、端口、路径都不能差：
   - GitHub：`https://directory.example.com/api/auth/callback/github`
   - Google：`https://directory.example.com/api/auth/callback/google`
   - 通用 OIDC：`https://directory.example.com/api/auth/callback/<provider-id>`
2. 在 GitHub 创建 OAuth App，在 Google Cloud 创建 OAuth Client；只申请 `openid`、`email`、`profile` 所需范围。把 Client ID/Secret 写入 `.local/github.json`、`.local/google.json`，权限 0600，不提交。
3. 生产/预发使用 `AUTH_REQUIRE_EMAIL=true`，并配置可用的 SMTP。账号绑定要求本地邮箱已验证；未验证邮箱不应开放绑定。
4. 先在数据库和对象存储做备份；验收使用测试账号，不用真实用户数据。

配置与只读核对：

```bash
pnpm cli auth-provider-check atlas .local/github.json
pnpm cli auth-provider-set atlas .local/github.json
pnpm cli auth-provider-list atlas
```

容器内把 JSON 放到受控挂载目录后执行 `docker compose exec -T web pnpm cli ...`。命令不应输出 secret。

## 二、必须覆盖的路径

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 新外部用户 | 用未注册过的 GitHub/Google 账号登录 | 创建读者账号；邮箱来自已验证声明；进入账号中心；共享站可继续登录 |
| 已有密码账号同邮箱 | 先用密码注册/登录，再直接点第三方登录 | **不自动合并**；应提示账号已存在/需先登录后绑定；不得产生重复用户或静默并号 |
| 显式绑定 | 登录密码账号 → `/account` → 绑定对应提供方 | 回跳 `/account`；列表出现该提供方；`list-accounts` 有记录 |
| 绑定后登录 | 退出，改用该提供方登录 | 回到同一 `user_id`；中心与共享站会话一致 |
| 不同邮箱 | 用另一个邮箱的外部账号绑定到当前账号 | 拒绝；不得合并；账号列表不变 |
| 拒绝授权 | 在提供方页面点拒绝 | 回到 `/account?error=link` 或登录错误页；不产生半绑定 |
| 解除绑定 | `/account` 解除该提供方 | 记录移除；最后一种登录方式被拒绝；其他数据保留 |
| 解除后登录 | 解除后再次用该提供方登录 | 不应进入原账号；具体表现为新建账号或提示冲突，需记录实际结果 |
| 禁用提供方 | 后台/CLI 设 `enabled:false` | 新登录被阻止；已有绑定保留；账号中心仍可解除旧绑定 |
| 共享站 | 在共享站登录/退出 | 303 到账号中心；绑定状态跟随中心账号；不出现跨站身份泄漏 |
| 过期会话解绑 | 长时间后直接解绑 | 服务端要求新鲜会话；提示重新登录；不得绕过 |

每个场景记录：时间、环境域名、provider id、测试邮箱、结果、错误码/页面、是否产生新用户；不要记录 access token、client secret 或完整 Cookie。

## 三、失败与回滚

- 授权失败先看回调 URL 是否与提供方登记完全一致，再看时钟、issuer、PKCE、client secret；不要通过放宽 `ALLOW_INSECURE_HTTP` 解决生产问题。
- 绑定错误不得手工改认证库 `account` 表；先用 `/account` 重试或解绑。
- 禁用提供方不会撤销已有会话；需要撤销会话时按会话管理流程处理。
- 回滚配置用 `enabled:false` 或删除提供方配置；不要删除用户、账号或业务数据。
- 真实凭据只放受控文件；验收结束后按部署规范轮换测试 secret。

## 四、验收结论模板

```text
日期：
环境：
中心域名：
GitHub client：已配置/未配置
Google client：已配置/未配置
新用户：
同邮箱冲突：
显式绑定：
绑定后登录：
不同邮箱：
拒绝授权：
解绑：
禁用提供方：
共享站：
遗留问题：
```

全部通过后，更新 [P3 认证操作](P3-AUTH.md) 和 [发行清单](RELEASE-CHECKLIST.md) 的“真实 OAuth”状态；未执行时保持待验收。
