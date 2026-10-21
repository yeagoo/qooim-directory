# 2026-10-20 本地验收记录

本轮按 [发行前检查清单](RELEASE-CHECKLIST.md) 执行可自动化的回归与 Docker 验收。环境为 `linux/arm64`，Node v24.21.0、pnpm 10.11.1、Docker 29.2.1、Compose v5.1.0。

当前沙箱没有免密 sudo，且 `~/.docker` 不可写。因此测试在临时用户命名空间中运行：绑定可写的 `/etc/hosts`、用本地 `sudo` 包装转发 Docker 命令、Playwright Chromium 以 `--no-sandbox` 启动。这些只影响测试执行方式，没有修改产品权限、认证或发行代码。

## 结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/preflight.mjs` | 18 项，0 硬失败，3 警告 | 警告为 sudo、GitHub/Google 未配置 |
| `pnpm test:p0` | 48/48 | `.local/acceptance-20261020/test-p0.log` |
| `pnpm test:p1` | 87/87 | 含审计日志、运营者生命周期、缓存与限流用例 |
| `pnpm test:p2` | 134/134 | 含批量发布浏览器用例 |
| `pnpm test:p3` | 36/36 | 含提供方自检、账号绑定/解绑端到端用例 |
| `pnpm test:p4` | 28/28 | — |
| `pnpm test:p5` | 11/11 | — |
| `pnpm test:release` | 69/69 | — |
| `pnpm test:docker` | 通过 | 空库、三站、HTTPS、共享登录、SMTP、内容/GitHub、worker 重启、数据库恢复 |

Docker 验收输出摘要：

```text
Docker source download contains corresponding build/test sources and excludes local secrets
Content master, frozen site publication and public detail passed
Empty database, HTTPS routing and operator login passed
Shared browser login passed; process and database recovery verified
GitHub candidate, manual review and frozen project publication passed
Docker acceptance passed
```

### 账号绑定变更后的回归

2026-10-20 增加账号中心 `/account` 与显式绑定/解绑后，重新执行 P0 48/48、P1 87/87、P2 134/134、P3 **36/36**、P4 28/28、P5 11/11、发行 69/69，并再次通过 Docker 整体验收。P0 Next 测试入口已移除，生产 Next 路由由 P1 覆盖。日志在 `.local/acceptance-20261020-account/`，Docker 使用 `P1_DOCKER_IMAGE=account-20261020`。

### 2026-10-21 Review 修复后最终回归

完成错误日志、限流、运营者生命周期、缓存/robots、备份身份、GitHub 统计自动更新和 `/api/session` 收敛后，最终执行 P0 48/48、P1 87/87、P2 134/134、P3 36/36、P4 28/28、P5 11/11、发行 69/69，并通过 Docker 整体验收。最终应用镜像为 `sha256:97d12c83...`；日志在 `.local/acceptance-20261021-final/`，Docker 使用 `P1_DOCKER_IMAGE=final3-20261021`。

## 与发行门禁的关系

- 功能回归和本地 Docker 验收通过，不等于可以公开发行。
- `pnpm release:check` 已在维护者 MIT 归属决定后退出 0。
- `pnpm release:check:image` 已退出 0：六组均由 QooIM 带保留签署；`next-swc` 的逐 crate 通知风险已明确接受。
- 真实 GitHub/Google OAuth 仍未完成；品牌已定为 Qoo.IM Directory，域名/仓库名待定。镜像门禁已通过，但保留项仍有效。
- `pnpm test:capacity` 未在本轮重跑；容量结论仍以既有短基线为准，不外推生产吞吐。

## 复现说明

测试日志在 `.local/acceptance-20261020/`；品牌与许可归属变更后又用 `.local/acceptance-20261020-final/` 重跑了 P0–P5、发行测试和 Docker，结果相同。最终 Docker 验收使用 `P1_DOCKER_IMAGE=acceptance-20261020-final` 构建的镜像。临时命名空间、Docker 包装和 `/etc/hosts` 绑定不进入源码包；正式环境有免密 sudo 时直接运行清单中的命令即可，不需要这些包装。
