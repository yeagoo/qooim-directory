# 镜像证据复核材料（2026-10-26，v0.2.0-rc.4 候选）

**这份材料不是签字。** `third-party/image-review.json` 中六个证据范围现在全部是 `pending`。在 QooIM 本人确认之前，`pnpm release:check:image` 会一直失败。

## 候选镜像

- 镜像：`navigation-network:rc4-candidate`，`sha256:b20df17dafb468702456248750aecc473c564985d6f04be435722c827a6c68fd`，linux/arm64，构建自 `main`（M20 合并后，版本号 0.2.0-rc.4）。拟定 tag：`v0.2.0-rc.4`。
- 和上次确认的 rc.3 镜像 `sha256:aa13093e…` 相比，变化是 M20 稳定版加固，见 [M20 验收记录](ACCEPTANCE-M20-20261025.md)。主要内容：
  - 公开读接口限流；
  - 数据保留期，以及媒体引用回收；
  - 访客账号的封禁和匿名化；
  - 密钥带版本号，可以轮换；
  - OIDC 请求经过 SSRF 校验；
  - 健康检查和结构化日志；
  - 迁移 021、022。

## 六个固定输入的变化

| 文件 | 是否变化 | 原因 |
| --- | --- | --- |
| `package.json` | 变化 | 版本号 0.2.0-rc.1 → 0.2.0-rc.4（审查项 B2）；新增 `test:p20` 脚本。依赖没有变。 |
| `compose.yaml` | 变化 | 向容器传入新的可选环境变量，默认值都是空或安全值。镜像、服务、端口、卷都没有变。这些变量是：`AUTH_ENCRYPTION_KEY_PREVIOUS`（密钥轮换）、`OIDC_ALLOW_PRIVATE_NETWORK`（默认 false）、`REQUEST_LOG`（默认 on）、`RETENTION_OPERATION_DAYS`、`RETENTION_OUTBOX_DAYS`、`RETENTION_AUDIT_DAYS`。 |
| 其余四个 | 未变化 | — |

## 证据对比

- 六个证据文件只有镜像身份、inventory 哈希和采集时间变了，观察内容与 rc.3 相同。
- 应用运行时 npm 包（191 个）、操作系统软件包（88 个）和许可声明（293 条）与 rc.3 完全相同，没有新增或删除。

## 请 QooIM 确认的事项

1. 沿用上次的决定和保留意见。
2. 同意把这个镜像作为 `v0.2.0-rc.4`。

确认后，按以前的格式在 `image-review.json` 中填写 reviewer、reviewedAt 和 `status: complete`，然后打 tag。这些字段必须由 QooIM 本人确认后才能填写。
