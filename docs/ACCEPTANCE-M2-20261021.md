# M2 验收记录：Passkey（不做 MFA）

日期：2026-10-21。范围见 [2026 Q4 功能规划](FEATURE-PLAN-2026Q4.md) M2。

## 变更

- 新增 `@better-auth/passkey@1.7.10`（与 better-auth 1.7.10 对齐，MIT）。
- 独立站点和共享账号中心启用站点级 Passkey：RP ID 取实例 hostname，origin 精确匹配，HTTPS/ localhost 开发例外。
- `/account` 支持添加、命名、删除 Passkey；登录页支持“使用 Passkey 登录”；密码保留为回退。
- 共享依赖站仍走中心，不在本站暴露 Passkey 端点。
- 浏览器端使用随包的 SimpleWebAuthn 13.3.0 UMD 文件，保留 MIT 许可；插件挑战存签名 Cookie + verification 表，单次消费。
- 不做 MFA、跨站 Passkey 或管理员代注册。

## 验证

```text
pnpm check                 通过
pnpm build                 通过
P0 48/48
P1 88/88
P2 135/135
P3 37/37（含虚拟认证器端到端）
P4 28/28
P5 11/11
pnpm test:release          69/69
pnpm test:docker           Docker 整体验收通过
pnpm release:check         通过
pnpm release:check:image   通过
```

Docker 使用 `P1_DOCKER_IMAGE=m2-20261021`；最终应用镜像 `sha256:e417af97...`。P3 测试覆盖注册、登出后 Passkey 登录、删除；真实设备平台同步行为仍需上线前人工验收。

## 升级注意

- 插件表按 auth instance 前缀创建；已有实例升级后对每个独立账号/中心运行 `pnpm cli auth-upgrade <site>`。
- 未执行升级时账号页会提示 Passkey 加载失败，但密码/第三方登录不受影响。
- 依赖/锁文件变化后镜像 evidence 已刷新，公开发行前仍需审查人确认。

## 安全边界

- 注册要求新鲜会话；认证不要求已登录。
- RP ID/origin 固定到实例，不从任意 Host 拼接；挑战有有效期并单次消费。
- 不提供 MFA，不改变现有会话绝对有效期和跨站共享策略。
